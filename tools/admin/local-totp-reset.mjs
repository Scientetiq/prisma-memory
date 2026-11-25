#!/usr/bin/env node
// Console recovery for a local administrator. Secrets go to a terminal only; destinations are literal loopback or unix.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: local-totp-reset.mjs <login> [--socket <path> | --url <loopback-http-url>] [--code-file <path>] [--remove]";
function destination(opt, env) {
  if (opt.socket && opt.url) throw new Error("arguments");
  const socket = opt.socket ?? (!opt.url ? env.MEMORY_ADMIN_SOCKET : undefined);
  if (socket) {
    if (!socket.startsWith("/") || /[\0\r\n]/.test(socket)) throw new Error("socket");
    return { socketPath: socket };
  }
  if (!opt.url) {
    for (const path of [env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/memory-admin/api.sock` : null, "/run/memory-admin/api.sock"]) {
      if (path && existsSync(path)) return { socketPath: path };
    }
  }
  const u = new URL(opt.url ?? "http://127.0.0.1:8080");
  if (u.protocol !== "http:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash ||
      !(u.hostname === "[::1]" || /^127(?:\.(?:\d{1,3})){3}$/.test(u.hostname))) throw new Error("destination");
  return { hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || 80 };
}
function post(to, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request({ ...to, path: "/api/v1/admin-auth/totp/reset", method: "POST", headers: { "content-type": "application/json", "content-length": data.length } }, res => {
      let size = 0; const chunks = [];
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 256 * 1024) { res.destroy(); resolve({ status: 0, body: null }); }
        else chunks.push(chunk);
      });
      res.on("error", () => resolve({ status: 0, body: null }));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { resolve({ status: 0, body: null }); }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject); req.end(data);
  });
}
export async function main(argv, env = process.env, out = process.stdout, err = process.stderr) {
  const opt = {}, args = [], names = { "--socket": "socket", "--url": "url", "--code-file": "codeFile" };
  for (let n = 0; n < argv.length; n++) {
    const arg = argv[n];
    if (arg === "--remove" && !opt.remove) opt.remove = true;
    else if (names[arg] && !opt[names[arg]] && argv[n + 1] && !argv[n + 1].startsWith("--")) opt[names[arg]] = argv[++n];
    else if (arg.startsWith("--")) { err.write(USAGE + "\n"); return 2; }
    else args.push(arg);
  }
  const login = (args[0] ?? "").trim().toLowerCase();
  if (args.length !== 1 || !login || login.length > 200 || /[\0\r\n]/.test(login)) { err.write(USAGE + "\n"); return 2; }
  if (!opt.remove && out.isTTY !== true) { err.write("Run in a terminal: reset secrets cannot be redirected or logged.\n"); return 2; }
  let code, to;
  try {
    to = destination(opt, env);
    code = (env.MEMORY_FIRST_RUN_CODE ?? "").trim();
    if (!code && opt.codeFile) code = readFileSync(opt.codeFile, "utf8").trim();
  } catch { err.write("Invalid local destination or unreadable install-code file.\n"); return 2; }
  if (!code) { err.write("Set MEMORY_FIRST_RUN_CODE or supply --code-file with the install code.\n"); return 2; }
  let res;
  try { res = await post(to, { code, login, ...(opt.remove ? { remove: true } : {}) }); }
  catch { err.write("The local gateway is unavailable.\n"); return 3; }
  const b = res.body;
  if (res.status !== 200 || !b || b.login !== login) { err.write("The gateway refused the reset or returned an invalid response.\n"); return 1; }
  if (opt.remove) {
    if (b.removed !== true) { err.write("The gateway did not confirm removal.\n"); return 1; }
    out.write("Second factor removed.\n"); return 0;
  }
  if (typeof b.secret_text !== "string" || typeof b.otpauth_uri !== "string" || !b.otpauth_uri.startsWith("otpauth://") ||
      !Array.isArray(b.recovery_codes) || b.recovery_codes.length !== 10 || !b.recovery_codes.every(c => typeof c === "string")) {
    err.write("The gateway returned an invalid reset response.\n"); return 1;
  }
  out.write(`New authenticator secret: ${b.secret_text}\n${b.otpauth_uri}\nRecovery codes (save these now):\n${b.recovery_codes.join("\n")}\n`);
  return 0;
}
const runAsMain = () => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsMain()) process.exit(await main(process.argv.slice(2)));
