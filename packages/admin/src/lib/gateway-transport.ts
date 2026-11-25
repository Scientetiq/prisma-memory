import { TRANSPORT_TEXT } from "../messages/gateway-transport";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { webRole, type WebRole } from "./web-role";

export type Plane = "admin" | "workplace";
export type GatewayBase = { kind: "http"; origin: string } | { kind: "unix"; socket: string };

const DEFAULT_URL = "http://gateway:8080";

export const isAdminPlanePath = (path: string): boolean => /^\/api\/v1\/(?:admin(?:-auth)?(?:\/|$|\?)|first-run(?:$|\?)|admin-login(?:$|\?))/.test(path);

export function planeOfPath(path: string, role: WebRole = webRole(), adminSession = false): Plane {
  if (isAdminPlanePath(path)) return "admin";
  // Health: the panel role asks the admin listener; with the role all, a call that carries an administrator session does too.
  if (/^\/api\/v1\/health(?:$|\?)/.test(path) && (role === "panel" || (role === "all" && adminSession))) return "admin";
  return "workplace";
}

export function parseBase(raw: string): GatewayBase {
  const v = raw.trim();
  if (v.startsWith("unix:")) {
    const socket = v.slice(5);
    if (!socket.startsWith("/")) throw new Error(TRANSPORT_TEXT.absoluteSocket);
    return { kind: "unix", socket };
  }
  const u = new URL(v);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(TRANSPORT_TEXT.addressScheme);
  return { kind: "http", origin: v.replace(/\/+$/, "") };
}

export function gatewayBase(plane: Plane, role: WebRole = webRole(), env: Record<string, string | undefined> = process.env): GatewayBase {
  if (plane === "workplace") {
    if (role === "panel") throw new Error(TRANSPORT_TEXT.panelOnly);
    return parseBase(env.GATEWAY_URL || DEFAULT_URL);
  }
  if (role === "workplace") throw new Error(TRANSPORT_TEXT.workplaceOnly);
  const admin = env.GATEWAY_ADMIN_URL || (role === "all" ? env.GATEWAY_URL || DEFAULT_URL : "");
  if (!admin) throw new Error(TRANSPORT_TEXT.adminAddressRequired);
  return parseBase(admin);
}

export const adminPlaneSeparate = (env: Record<string, string | undefined> = process.env): boolean => !!(env.GATEWAY_ADMIN_URL ?? "").trim();

export interface TransportInit {
  method?: string;
  headers?: Record<string, string>;
  /** JSON text, or bytes of a body with its own type (multipart). */
  body?: string | Uint8Array<ArrayBuffer>;
  signal?: AbortSignal;
}

export function unixFetch(socket: string, path: string, init: TransportInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) { reject(init.signal.reason ?? new Error("aborted")); return; }
    const headers: Record<string, string> = { host: "localhost", ...init.headers };
    if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));
    const req = request({ socketPath: socket, path, method: init.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const x of v) h.append(k, x);
          else if (v !== undefined) h.set(k, String(v));
        }
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304 || (status >= 100 && status < 200);
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: h }));
      });
    });
    req.on("error", reject);
    init.signal?.addEventListener("abort", () => req.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted")), { once: true });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

const httpsAgent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: true });

// No time limit of its own: every caller hands in a signal. Headers go out as the caller gave them.
export function httpsFetch(
  origin: string,
  path: string,
  init: TransportInit = {},
  tls?: { ca?: string | string[] },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const { body, method = "GET", signal } = init;
    if (signal?.aborted) { reject(signal.reason); return; }

    const fail = (cause: unknown) => reject(new TypeError("fetch failed", { cause }));
    let activeRequest: ClientRequest | undefined;
    try {
      const url = new URL(origin + path);
      if (url.username || url.password || url.origin !== new URL(origin).origin) throw new TypeError();
      // The name checked against the certificate comes from the target URL above. A caller's Host header is applied after this line and never reaches the check — keep this order.
      const req = httpsRequest(url, { method, agent: httpsAgent, rejectUnauthorized: true, ca: tls?.ca });
      activeRequest = req;
      let response: IncomingMessage | undefined;
      const onAbort = () => {
        const reason = signal?.reason;
        const error = reason instanceof Error ? reason : new Error("aborted");
        req.destroy(error);
        response?.destroy(error);
        reject(reason);
      };
      req.on("error", fail);
      req.once("close", () => signal?.removeEventListener("abort", onAbort));
      signal?.addEventListener("abort", onAbort, { once: true });

      req.once("response", (res) => {
        response = res;
        try {
          const headers = new Headers();
          for (const [name, values] of Object.entries(res.headersDistinct)) {
            for (const value of values ?? []) headers.append(name, value);
          }
          const status = res.statusCode ?? 502;
          const empty = status === 204 || status === 205 || status === 304 || req.method === "HEAD";
          if (empty) {
            res.on("error", () => {});
            res.resume();
          }
          const stream = empty ? null : Readable.toWeb(res, {
            strategy: { highWaterMark: res.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
          }) as unknown as ReadableStream<Uint8Array>;
          resolve(new Response(stream, { status, statusText: res.statusMessage, headers }));
        } catch (cause) {
          req.destroy();
          fail(cause);
        }
      });
      req.once("upgrade", (_res, socket) => {
        socket.destroy();
        fail(new TypeError());
      });

      for (const [name, value] of Object.entries(init.headers ?? {})) req.setHeader(name, value);
      if (body !== undefined) req.setHeader("content-length", String(Buffer.byteLength(body)));
      if (!req.hasHeader("accept-encoding")) req.setHeader("accept-encoding", "identity");
      req.end(body);
    } catch (cause) {
      activeRequest?.destroy();
      fail(cause);
    }
  });
}

export function gatewayFetch(base: GatewayBase, path: string, init: TransportInit & { cache?: RequestCache } = {}): Promise<Response> {
  if (base.kind === "unix") return unixFetch(base.socket, path, init);
  const target = base.origin + path;
  const url = URL.canParse(target) ? new URL(target) : undefined;
  const baseOrigin = URL.canParse(base.origin) ? new URL(base.origin).origin : undefined;
  if (url && (url.username || url.password || url.origin !== baseOrigin)) return Promise.reject(new TypeError("fetch failed", { cause: new TypeError() }));
  if (url?.protocol === "https:") return httpsFetch(base.origin, path, init);
  return fetch(base.origin + path, { method: init.method ?? "GET", headers: init.headers, body: init.body, cache: init.cache ?? "no-store", signal: init.signal, redirect: "manual" });
}
