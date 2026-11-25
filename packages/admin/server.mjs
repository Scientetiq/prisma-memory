import { readFileSync, realpathSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stampPeer } from "./client-peer.mjs";
import { runWithRequestLocale } from "./request-locale.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function httpsPlanOf(env, read = (dir, name) => readFileSync(join(dir, name))) {
  const port = Number(env.HTTPS_PORT ?? 0);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { off: "port_off" };
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) return { off: "keys_missing" };
  let cert, key;
  try { cert = read(dir, "https.crt"); key = read(dir, "https.key"); } catch { return { off: "keys_missing" }; }
  if (!cert?.length || !key?.length) return { off: "keys_missing" };
  return { https: { port, cert, key } };
}

const line = (level, code, fields = {}) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, process: "memory-admin", code, ...fields })}\n`);

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const plan = httpsPlanOf(process.env);
  if (plan.off) {
    if (plan.off !== "port_off") line("warn", "https_off", { reason: plan.off });
    process.argv = [process.argv[0], "next", "start", "-H", "0.0.0.0", "-p", String(port)];
    await import(pathToFileURL(join(HERE, "node_modules", "next", "dist", "bin", "next")).href);
    return;
  }
  const { default: next } = await import("next");
  const app = next({ dev: false, dir: HERE, hostname: "0.0.0.0", port });
  await app.prepare();
  const handle = app.getRequestHandler();
  createHttpServer((req, res) => handle(req, res)).listen(port, "0.0.0.0", () => line("info", "listener_started", { port }));
  createHttpsServer({ cert: plan.https.cert, key: plan.https.key, minVersion: "TLSv1.2" }, (req, res) => {
    stampPeer(req);   // same stamp and proof as the HTTP listener: Next's internal hop keeps the browser's address
    return runWithRequestLocale(req, () => handle(req, res));   // the interface-language scope, as client-peer.mjs gives HTTP
  }).listen(plan.https.port, "0.0.0.0", () => line("info", "listener_started", { port: plan.https.port, tls: true }));
}

function isMain() {
  try { return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
}
if (isMain()) main().catch((e) => { line("error", "start_failed", { error: String(e?.code ?? e?.name ?? "error") }); process.exit(1); });
