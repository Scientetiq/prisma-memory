#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = "usage: first-admin.mjs <login of the person card> [--socket <path>] [--url <gateway address>] [--env-file <file>]";

export function envFileValue(text, key) {
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    if (t.slice(0, t.indexOf("=")).trim() !== key) continue;
    return t.slice(t.indexOf("=") + 1).trim().replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return "";
}

export function firstRunCode(env = process.env, envFile = join(homedir(), "memory", ".env")) {
  if ((env.MEMORY_FIRST_RUN_CODE ?? "").trim()) return env.MEMORY_FIRST_RUN_CODE.trim();
  try { return envFileValue(readFileSync(envFile, "utf8"), "MEMORY_FIRST_RUN_CODE"); } catch { return ""; }
}

export function target(opt, env = process.env, exists = existsSync) {
  if (opt.socket) return { socket: opt.socket };
  // an address given with --url is used as it is: a socket found on this machine never replaces it
  if (opt.url) return { url: opt.url };
  const sockets = [env.MEMORY_ADMIN_SOCKET, env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "memory-admin", "api.sock") : null, "/run/memory-admin/api.sock"];
  for (const s of sockets) if (s && exists(s)) return { socket: s };
  return { url: env.MEMORY_BASE_URL ?? "http://127.0.0.1:8080" };
}

/** A loopback host name of a URL: 127.0.0.0/8, ::1 (with or without brackets) or localhost. */
export function loopbackHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

const FULL_ADDRESS = "refused: the gateway address must be a full address that starts with https://, or with http:// for this machine only (for example http://127.0.0.1:8080)";

/** Why the gateway address is refused, or "": https:// to any host, plain http:// only to this machine. */
export function urlRefusal(address) {
  let u;
  try { u = new URL(address); } catch { return FULL_ADDRESS; }
  if (u.protocol === "https:") return "";
  if (u.protocol !== "http:") return FULL_ADDRESS;
  if (loopbackHost(u.hostname)) return "";
  return `refused: plain http:// is allowed only to this machine (127.0.0.1, ::1 or localhost), not to ${u.hostname}: the install code and the login would cross the network unencrypted; give an https:// address, or the socket of the admin listener (--socket <path>)`;
}

/** The target as a message shows it: the socket path, or the scheme, host and port of the address (no user part, path or query). */
export function shown(to) {
  if (to.socket) return to.socket;
  try { const u = new URL(to.url); return `${u.protocol}//${u.host}`; } catch { return "the given address"; }
}

const UNTRUSTED = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_UNTRUSTED"]);

/** What to do when the certificate check gave this error code because the gateway's certificate is not trusted, or "". */
export function certificateHint(code) {
  return UNTRUSTED.has(code) ? "the gateway's certificate is not trusted by this machine: start the command with NODE_EXTRA_CA_CERTS set to the file that holds its CA certificate (PEM), or use the socket of the admin listener (--socket <path>)" : "";
}

/** The request of post(): node:https for https:// with the certificate always verified, node:http for this machine and the socket. */
export function requestFor(to, headers) {
  // agent: false gives the request a connection of its own, straight to the target: the shared agent would hand it to a
  // proxy named in the environment (NODE_USE_ENV_PROXY with HTTP_PROXY or HTTPS_PROXY), a host the operator did not name
  const base = { method: "POST", path: "/api/v1/first-run", headers, agent: false };
  if (to.socket) return { send: httpRequest, opts: { ...base, socketPath: to.socket } };
  const u = new URL("/api/v1/first-run", to.url);
  const tls = u.protocol === "https:";
  const opts = { ...base, host: u.hostname.replace(/^\[(.*)\]$/, "$1"), port: u.port || (tls ? 443 : 80) };
  // rejectUnauthorized is given here, so NODE_TLS_REJECT_UNAUTHORIZED cannot turn the certificate check off
  return tls ? { send: httpsRequest, opts: { ...opts, rejectUnauthorized: true } } : { send: httpRequest, opts };
}

/** POST /api/v1/first-run {code, person}: {status, body}. */
export function post(to, body) {
  return new Promise((resolve, reject) => {
    const refused = to.socket ? "" : urlRefusal(to.url);
    if (refused) { reject(new Error(refused)); return; }
    const data = Buffer.from(JSON.stringify(body));
    const headers = { "content-type": "application/json", "content-length": data.length };
    const { send, opts } = requestFor(to, headers);
    const req = send(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

export async function main(argv, env = process.env, out = process.stdout, err = process.stderr) {
  const opt = {}, args = [];
  const NAMES = { "--socket": "socket", "--url": "url", "--env-file": "envFile" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (NAMES[a]) { const v = argv[++i]; if (!v) { err.write(`${USAGE}\n`); return 2; } opt[NAMES[a]] = v; }
    else if (a.startsWith("--")) { err.write(`${USAGE}\n`); return 2; }
    else args.push(a);
  }
  const person = (args[0] ?? "").trim().toLowerCase();
  if (args.length !== 1 || !person.includes("@")) { err.write(`${USAGE}\n`); return 2; }
  if (opt.socket && opt.url) { err.write("refused: --socket and --url name two different targets; give only one of them\n"); return 2; }
  const to = target(opt, env);
  const refused = to.socket ? "" : urlRefusal(to.url);
  if (refused) { err.write(`${refused}\n`); return 2; }
  const code = firstRunCode(env, opt.envFile ?? join(homedir(), "memory", ".env"));
  if (!code) { err.write("no install code: neither MEMORY_FIRST_RUN_CODE in the environment nor a line in ~/memory/.env (--env-file)\n"); return 2; }
  let res;
  try { res = await post(to, { code, person }); }
  catch (e) {
    err.write(`gateway not reachable (${shown(to)}): ${e.code ?? e.message}\n`);
    if (certificateHint(e.code)) err.write(`${certificateHint(e.code)}\n`);
    return 3;
  }
  if (res.status === 201) { out.write(`${JSON.stringify(res.body)}\n`); return 0; }
  const b = res.body && typeof res.body === "object" ? res.body : {};
  err.write(`${b.code ?? res.status}: ${b.message ?? String(res.body ?? "").slice(0, 200)}\n`);
  if (res.status === 404 && !to.socket)
    err.write("the main listener accepts the command only from this same machine (loopback); a gateway in a container sees the bridge address, so give the socket of the admin listener: --socket <path>\n");
  return 1;
}

const runAsMain = () => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsMain()) process.exit(await main(process.argv.slice(2)));
