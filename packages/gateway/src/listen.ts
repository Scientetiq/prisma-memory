// The gateway's TLS. The gateway listeners are those of startListeners (admin-plane/listeners.ts):
//   - wrapTls — a wrapper for its wrap parameter. The listeners (the main HTTP on PORT, admin, workplace, command
//     line) stay as they were: unix sockets and an internal HTTP behind a proxy; TLS to them is the proxy's (basic: the shared
//     proxy). The wrapper only checks the kind and the address and changes nothing, so its line in index.ts changes no behaviour;
//   - startHttps — the gateway's HTTPS (advanced only: keys from the internal CA): if access.https_port > 0 and the credentials
//     directory holds https.crt and https.key, it starts one more node:https listener (TLS ≥ 1.2) with the same
//     application as the main listener. HTTP on PORT stays. The request channel (channel.ts) is found the same way, by the socket
//     address and X-Forwarded-For: the HTTPS listener is of kind main. There is no local TLS forwarder: the loop would count as
//     a system address. Without keys or without a port — HTTP only, and health (tls_links) warns.
// Key values are not printed: only the port and the reason go to the log.
import { createServer as createHttpsServer } from "node:https";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import { log, readCredential, type Settings } from "@memory/shared";
import { withListener } from "./admin-plane/listeners.ts";

/** Listener kind — as ListenerKind. */
export type TlsListenerKind = "main" | "admin" | "workplace" | "cli";
/** Listener address — as ListenAddr. */
export type TlsListenAddr = { type: "unix"; path: string } | { type: "tcp"; host: string; port: number };
/** Parameters of createAdaptorServer that the wrapper may replace (createServer, serverOptions). */
export type AdaptorOptions = Parameters<typeof createAdaptorServer>[0];

/** The wrapper for startListeners: the listeners stay unchanged (HTTP and unix sockets; TLS is with the proxy and startHttps). */
export function wrapTls(_kind: TlsListenerKind, _addr: TlsListenAddr, options: AdaptorOptions): AdaptorOptions {
  return options;
}

/** The key and certificate of the gateway's HTTPS in the credentials directory. */
export const HTTPS_CERT = "https.crt";
export const HTTPS_KEY = "https.key";

/** Why the gateway's HTTPS did not start: port 0, no key or certificate, or they cannot be read. */
export type HttpsOff = "port_off" | "keys_missing" | "keys_unreadable";
export interface HttpsPlan { port: number; cert: Buffer; key: Buffer }

/** What to start: the port from access.https_port and the keys from the directory. read — a read stand-in (tests). */
export function httpsPlan(settings: Pick<Settings, "get">, read: (name: string) => Buffer | null = readCredential): HttpsPlan | { off: HttpsOff } {
  const port = settings.get<unknown>("access.https_port", 0);
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) return { off: "port_off" };
  let cert: Buffer | null, key: Buffer | null;
  try { cert = read(HTTPS_CERT); key = read(HTTPS_KEY); } catch { return { off: "keys_unreadable" }; }
  if (!cert || !key) return { off: "keys_missing" };
  return { port, cert, key };
}

/** Whether the gateway's HTTPS is alive in this process (for health tls_links). */
let httpsUp: { port: number } | null = null;
export const httpsListening = (): { port: number } | null => httpsUp;

type FetchFn = (req: Request, env?: any, ctx?: any) => Response | Promise<Response>;

/**
 * Start the gateway's HTTPS by plan, or nothing (null). A key error (wrong pair, not PEM) or a busy port throws: a gateway with
 * an HTTPS port set and bad keys does not start, as with a wrong listener variable.
 */
export async function startHttps(app: { fetch: FetchFn }, settings: Pick<Settings, "get">, o: { hostname?: string; read?: (name: string) => Buffer | null } = {}): Promise<ServerType | null> {
  const plan = httpsPlan(settings, o.read);
  if ("off" in plan) {
    if (plan.off !== "port_off") log.warn("https_off", { reason: plan.off });
    return null;
  }
  const fetch: FetchFn = (req, env, ec) => withListener({ kind: "main", unix: false }, () => app.fetch(req, env, ec));
  const server = createAdaptorServer({
    fetch: fetch as AdaptorOptions["fetch"], createServer: createHttpsServer,
    serverOptions: { cert: plan.cert, key: plan.key, minVersion: "TLSv1.2" },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(plan.port, o.hostname ?? "0.0.0.0", () => { server.off("error", reject); resolve(); });
  });
  httpsUp = { port: plan.port };
  server.once("close", () => { httpsUp = null; });
  log.info("listener_started", { kind: "main", tls: true, host: o.hostname ?? "0.0.0.0", port: plan.port });
  return server;
}
