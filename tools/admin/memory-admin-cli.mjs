#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REASONS = ["keys_lost", "sso_down", "directory_down", "incident", "drill"];
/** Format of a provisioning file (POST /cli/provision). */
export const PROVISION_FORMAT = "prisma-provision/1";

/** One stderr line about a provisioning answer: counts and the kept keys with their reasons (names only, no values). */
export function provisionSummary(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.written)) return null;
  const kept = Array.isArray(report.kept) ? report.kept : [];
  const via = Array.isArray(report.through_recovery) ? report.through_recovery.length : 0;
  const head = `${report.dry_run ? "Dry run, nothing written — would write" : "Written"}: ${report.written.length}${via ? ` (${via} through the checks of recover set)` : ""}; kept: ${kept.length}`;
  return kept.length ? `${head} — ${kept.map((k) => `${k.key} (${k.reason})`).join(", ")}` : head;
}
const ANCHOR_FILE = /^(anchor-signers\.pub|trust-anchors(-inner)?\.json(\.sig\.\d{1,3})?)$/;

export function socketPath(env = process.env) {
  if (env.MEMORY_CLI_SOCKET) return env.MEMORY_CLI_SOCKET;
  if (env.XDG_RUNTIME_DIR) {
    const p = join(env.XDG_RUNTIME_DIR, "memory-cli", "cli.sock");
    if (existsSync(p)) return p;
  }
  const home = env.MEMORY_HOME || join(env.HOME || homedir(), "memory");
  const compose = join(home, "run", "cli", "cli.sock");
  if (existsSync(compose)) return compose;
  return "/run/memory-cli/cli.sock";
}

export const GATEWAY_UID = 61004;

export function socketOwnerProblem(socket, env = process.env) {
  const home = env.MEMORY_HOME || join(env.HOME || homedir(), "memory");
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  if (real(dirname(socket)) !== real(join(home, "run", "cli"))) return null;
  let st;
  try { st = lstatSync(socket); } catch { return null; }
  const want = env.MEMORY_CLI_SOCKET_UID !== undefined && env.MEMORY_CLI_SOCKET_UID !== "" ? Number(env.MEMORY_CLI_SOCKET_UID) : GATEWAY_UID;
  if (!st.isSocket()) return `${socket} is not a socket: the command line does not connect (was the gateway socket replaced?)`;
  if (st.uid !== want) return `socket ${socket} is owned by uid ${st.uid}, not by the gateway (uid ${want}): the command line does not connect, as something other than the gateway may have replaced the socket; check the folder ${dirname(socket)} and restart the gateway`;
  return null;
}

export function edgeFloorLine(edge) {
  if (!edge || typeof edge !== "object") return null;
  if (edge.status === "applied") return `Edge anchors: the second-factor boundary is written, document number ${edge.serial}`;
  if (edge.status === "same") return `Edge anchors: document number ${edge.serial} is already written, the boundary is unchanged`;
  if (edge.status === "none") return "Edge anchors: the gateway's anchor folder holds no edge document (or the database is too old for edge anchors), the boundary is unchanged";
  if (edge.status === "failed") return `ERROR: the edge anchors are refused (${edge.code ?? "?"}): the second-factor boundary is not written from them, the previous anchors_applied row of kind edge stays in force; details are in the alert anchors_rejected`;
  return `Edge anchors: unknown outcome (${String(edge.status).slice(0, 40)})`;
}

export function call(socket, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({ socketPath: socket, method, path, headers: { ...headers, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

export function promptHidden(questions, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const answers = [];
    const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
    rl._writeToOutput = (s) => { if (s.includes("\n") || s.includes("\r")) output.write("\n"); };
    output.write(questions[0]);
    rl.on("line", (line) => {
      answers.push(line);
      if (answers.length < questions.length) output.write(questions[answers.length]);
      else rl.close();
    });
    rl.once("close", () => (answers.length === questions.length ? resolve(answers) : reject(new Error("input closed"))));
  });
}

export function anchorFiles(dir, { withRoot = true } = {}) {
  const files = {};
  for (const name of readdirSync(dir)) if (ANCHOR_FILE.test(name) && (withRoot || name !== "anchor-signers.pub")) files[name] = readFileSync(join(dir, name), "utf8");
  return files;
}

export function readAll(input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    input.on("data", (c) => chunks.push(Buffer.from(c)));
    input.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    input.once("error", reject);
  });
}

const optAll = (rest, name) => rest.flatMap((x, i) => (x === name && rest[i + 1] !== undefined ? [rest[i + 1]] : []));

const USAGE = `usage: memory-admin <command>
  health
  anchors verify [<folder>] [--root]   (default: MEMORY_ANCHORS_DIR or ~/memory/anchors)
  anchors reload
  anchors draft [--out <file>] [--signers <file|->] [--accept k1,k2] [--set <name>[=JSON]]… [--floor basic|advanced] [--retire]
  sessions revoke-all
  breakglass open --reason ${REASONS.join("|")}
  breakglass close
  breakglass status
  edge on|off
  system-key issue|rotate                (only through a wrapper that saves the key: the key goes into its pipe, never to a terminal)
  security-mode status
  security-mode cancel-downgrade
  recover keys
  recover set <name>[=JSON]… [--confirm-clear]   (without =JSON the value is asked without echo; null for a required setting needs --confirm-clear)
  recover grant --login <login> --role memory_admin|security_auditor --basis <number of the request or decision>
  recover revoke <grant>
  provision apply <file|-> [--dry-run]   (prisma-provision/1; - — the file from standard input)`;

export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.stdout ?? process.stdout, err = io.stderr ?? process.stderr;
  const input = io.stdin ?? process.stdin;
  const [cmd, sub, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const socket = socketPath(env);
  const owner = socketOwnerProblem(socket, env);
  if (owner) { err.write(`${owner}\n`); return 3; }
  const headers = env.SSH_CONNECTION ? { "x-memory-ssh-from": String(env.SSH_CONNECTION).slice(0, 200) } : {};
  const usage = () => { err.write(`${USAGE}\n`); return 2; };

  let method, path, body;
  if (cmd === "health" && sub === undefined) [method, path] = ["GET", "/cli/health"];
  else if (cmd === "anchors" && sub === "verify") {
    const dir = rest.find((x) => !x.startsWith("--")) ?? env.MEMORY_ANCHORS_DIR ?? join(homedir(), "memory", "anchors");
    const withRoot = rest.includes("--root");
    let files;
    try { files = anchorFiles(dir, { withRoot }); } catch { err.write(`no anchor folder: ${dir}\n`); return 2; }
    if (!Object.keys(files).some((n) => /^trust-anchors(-inner)?\.json$/.test(n))) { err.write(`the folder ${dir} holds neither trust-anchors-inner.json nor trust-anchors.json\n`); return 2; }
    if (withRoot && !files["anchor-signers.pub"]) { err.write(`--root: the folder ${dir} holds no anchor-signers.pub\n`); return 2; }
    [method, path, body] = ["POST", "/cli/anchors/verify", withRoot ? { files, root: "files" } : { files }];
  } else if (cmd === "anchors" && sub === "reload") [method, path, body] = ["POST", "/cli/anchors/reload", {}];
  else if (cmd === "anchors" && sub === "draft") {
    const signers = opt("--signers"), accept = opt("--accept"), sets = optAll(rest, "--set"), floor = opt("--floor"), retire = rest.includes("--retire");
    if (floor !== undefined && floor !== "basic" && floor !== "advanced") { err.write("--floor is basic or advanced\n"); return 2; }
    if (retire && floor === "advanced") { err.write("--retire and --floor advanced cannot go together: a retirement document sets no floor\n"); return 2; }
    if (!signers && !accept && !sets.length && !floor && !retire) [method, path] = ["GET", "/cli/anchors/draft"];
    else {
      const hidden = sets.filter((x) => !x.includes("="));
      if (signers === "-" && hidden.length) { err.write("--signers - and --set without a value both read stdin: give the signers file by its path\n"); return 2; }
      const draftBody = {};
      if (signers) {
        try { draftBody.signers_pub = signers === "-" ? await readAll(input) : readFileSync(signers, "utf8"); }
        catch { err.write(`cannot read the signers file: ${signers}\n`); return 2; }
      }
      if (accept) draftBody.accept = accept.split(",").map((x) => x.trim()).filter(Boolean);
      if (sets.length) {
        draftBody.set = {};
        for (const x of sets.filter((y) => y.includes("="))) {
          const i = x.indexOf("=");
          try { draftBody.set[x.slice(0, i)] = JSON.parse(x.slice(i + 1)); } catch { err.write(`--set ${x.slice(0, i)}=…: the value is JSON (a string in quotes)\n`); return 2; }
        }
        if (hidden.length) {
          let answers;
          try { answers = await promptHidden(hidden.map((k) => `New value of ${k} (not shown): `), { input, output: err }); }
          catch { err.write("value input interrupted\n"); return 2; }
          hidden.forEach((k, i) => { draftBody.set[k] = answers[i]; });
        }
      }
      if (floor) draftBody.security_mode_min = floor;
      if (retire) draftBody.retire = true;
      [method, path, body] = ["POST", "/cli/anchors/draft", draftBody];
    }
  }
  else if (cmd === "recover" && sub === "keys") [method, path] = ["GET", "/cli/recover/keys"];
  else if (cmd === "recover" && sub === "set") {
    const args = rest.filter((x) => !x.startsWith("--"));
    if (!args.length) return usage();
    const items = [];
    for (const x of args.filter((y) => y.includes("="))) {
      const i = x.indexOf("="), path = x.slice(0, i), dot = path.indexOf(".");
      if (dot < 1) { err.write(`${path}: the setting is <section>.<name>\n`); return 2; }
      try { items.push({ category: path.slice(0, dot), key: path.slice(dot + 1), value: JSON.parse(x.slice(i + 1)) }); }
      catch { err.write(`${path}=…: the value is JSON (a string in quotes, null for the default)\n`); return 2; }
    }
    const hidden = args.filter((y) => !y.includes("="));
    if (hidden.some((p) => p.indexOf(".") < 1)) { err.write("the setting is <section>.<name>\n"); return 2; }
    if (hidden.length) {
      let answers;
      try { answers = await promptHidden(hidden.map((k) => `New value of ${k} (not shown): `), { input, output: err }); }
      catch { err.write("value input interrupted\n"); return 2; }
      hidden.forEach((p, i) => { const dot = p.indexOf("."); items.push({ category: p.slice(0, dot), key: p.slice(dot + 1), value: answers[i] }); });
    }
    if (rest.includes("--confirm-clear")) for (const it of items) if (it.value === null) it.confirm_clear = true;
    [method, path, body] = ["POST", "/cli/recover/settings", { items }];
  } else if (cmd === "recover" && sub === "grant") {
    const login = opt("--login"), role = opt("--role"), basis = opt("--basis");
    if (!login || !["memory_admin", "security_auditor"].includes(role ?? "") || !basis) return usage();
    [method, path, body] = ["POST", "/cli/recover/grant", { login, role_code: role, basis_ref: basis }];
  } else if (cmd === "recover" && sub === "revoke") {
    const id = rest.find((x) => !x.startsWith("--"));
    if (!id) return usage();
    [method, path, body] = ["POST", "/cli/recover/revoke", { grant_id: id }];
  }
  else if (cmd === "provision" && sub === "apply") {
    // exactly one file: a second one would be ignored silently (a typo in a setup call)
    const files = rest.filter((x) => !x.startsWith("--"));
    const src = files[0];
    if (files.length !== 1 || rest.some((x) => x.startsWith("--") && x !== "--dry-run")) return usage();
    let text;
    try { text = src === "-" ? await readAll(input) : readFileSync(src, "utf8"); } catch { err.write(`cannot read the provisioning file: ${src}\n`); return 2; }
    let doc;
    try { doc = JSON.parse(text); } catch { err.write(`${src}: not JSON\n`); return 2; }
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.format !== PROVISION_FORMAT || !Array.isArray(doc.items)) {
      err.write(`${src}: expected {"format": "${PROVISION_FORMAT}", "items": [{"category", "key", "value"}, …]}\n`);
      return 2;
    }
    // only the format and the items go to the gateway ("$comment" and other fields of the file stay here)
    [method, path, body] = ["POST", "/cli/provision", { format: doc.format, items: doc.items, ...(rest.includes("--dry-run") ? { dry_run: true } : {}) }];
  }
  else if (cmd === "sessions" && sub === "revoke-all") [method, path, body] = ["POST", "/cli/sessions/revoke-all", {}];
  else if (cmd === "breakglass" && sub === "open") {
    const reason = opt("--reason");
    if (!REASONS.includes(reason ?? "")) return usage();
    let halfA, halfB;
    try { [halfA, halfB] = await promptHidden(["Half A (holder A): ", "Half B (holder B): "], { input, output: err }); }
    catch { err.write("half input interrupted\n"); return 2; }
    [method, path, body] = ["POST", "/cli/breakglass/open", { half_a: halfA, half_b: halfB, reason_code: reason, ssh_connection: env.SSH_CONNECTION ?? null }];
  } else if (cmd === "breakglass" && sub === "close") [method, path, body] = ["POST", "/cli/breakglass/close", {}];
  else if (cmd === "breakglass" && (sub === "status" || sub === undefined)) [method, path] = ["GET", "/cli/breakglass"];
  else if (cmd === "edge" && (sub === "on" || sub === "off")) [method, path, body] = ["POST", "/cli/edge", { state: sub }];
  else if (cmd === "system-key" && (sub === "issue" || sub === "rotate")) {
    if (out.isTTY) { err.write("system-key prints the key only into the pipe of a wrapper that saves it, never to a terminal: run the system-key wrapper of your installation\n"); return 2; }
    [method, path, body] = ["POST", `/cli/system-key/${sub}`, {}];
  }
  else if (cmd === "security-mode" && (sub === "status" || sub === undefined)) [method, path] = ["GET", "/cli/security-mode"];
  else if (cmd === "security-mode" && sub === "cancel-downgrade") [method, path, body] = ["POST", "/cli/security-mode/cancel-downgrade", {}];
  else return usage();

  let res;
  try { res = await call(socket, method, path, body, headers); }
  catch (e) { err.write(`command-line socket not reachable (${socket}): ${e.code ?? e.message}\n`); return 3; }
  if (res.status >= 200 && res.status < 300) {
    const text = `${JSON.stringify(res.body, null, 2)}\n`;
    const changed = res.headers?.["x-memory-anchors-changed-in-db"], proposed = res.headers?.["x-memory-anchors-proposed"];
    if (changed) err.write(`WARNING: the database holds another value than the anchors (the draft keeps the previous pin, except for --accept): ${changed}\n`);
    if (proposed) err.write(`New pins (--set), which the signers check against the change request: ${proposed}\n`);
    if (cmd === "anchors" && sub === "verify" && res.body?.root) err.write(`Checked against the root: ${res.body.root === "files" ? "anchor-signers.pub from the folder (--root)" : "the gateway's installed anchor-signers.pub"}\n`);
    const edgeLine = cmd === "anchors" && sub === "reload" ? edgeFloorLine(res.body?.edge) : null;
    if (edgeLine) err.write(`${edgeLine}\n`);
    const summary = cmd === "provision" ? provisionSummary(res.body) : null;
    if (summary) err.write(`${summary}\n`);
    const file = cmd === "anchors" && sub === "draft" ? opt("--out") : undefined;
    if (file) {
      try { writeFileSync(file, text, { flag: "wx" }); } catch (e) { err.write(`${e.code === "EEXIST" ? "the file exists already, not overwritten" : "cannot write the file"}: ${file}\n`); return 2; }
      err.write(`draft written: ${file} (number ${res.body?.serial})\n`);
    }
    else out.write(text);
    return 0;
  }
  const b = res.body && typeof res.body === "object" ? res.body : { code: `http_${res.status}`, message: String(res.body ?? "") };
  err.write(`${b.code ?? `http_${res.status}`}: ${b.message ?? ""}${b.details?.reason ? ` (${b.details.reason})` : ""}\n`);
  // provisioning refused: the keys and reasons; what was already written before the refusal (the group "always" goes first)
  if (cmd === "provision") {
    for (const r of Array.isArray(b.details?.refused) ? b.details.refused : []) err.write(`refused: ${r.key} (${r.reason})\n`);
    if (Array.isArray(b.details?.written) && b.details.written.length) err.write(`written before the refusal: ${b.details.written.join(", ")}\n`);
  }
  const edgeLine = cmd === "anchors" && sub === "reload" ? edgeFloorLine(b.details?.edge) : null;
  if (edgeLine) err.write(`${edgeLine}\n`);
  return 1;
}

const runAsMain = () => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.message ?? e}\n`); process.exitCode = 1; });
}
