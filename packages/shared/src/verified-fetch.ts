import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

export async function verifiedFetch(url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  redirect: "manual";
}): Promise<Response> {
  const { method, body, signal } = init;
  signal?.throwIfAborted();

  const target = new URL(url);
  const secure = target.protocol === "https:";
  if (!secure && target.protocol !== "http:") throw new TypeError("fetch failed");
  // Match fetch's refusal of URL credentials before node:http turns them into an Authorization header.
  if (target.username || target.password) throw new TypeError("fetch failed");

  const headers = { ...init.headers };
  const headerNames = Object.keys(headers).map((name) => name.toLowerCase());
  if (!headerNames.includes("accept-encoding")) headers["accept-encoding"] = "identity";
  if (body !== undefined && !headerNames.includes("content-length"))
    headers["content-length"] = String(Buffer.byteLength(body));

  return new Promise<Response>((resolve, reject) => {
    const options = { method, headers, agent: false as const };
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const req = secure
      ? httpsRequest(target, {
          ...options, rejectUnauthorized: true, servername: isIP(host) ? undefined : host,
          // Verify the URL's host even when an HTTP Host header is supplied.
          checkServerIdentity: (_servername, cert) => checkServerIdentity(host, cert),
        })
      : httpRequest(target, options);

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", abort);
      return true;
    };
    const fail = (reason: unknown) => {
      if (!finish()) return;
      if (controller) controller.error(reason);
      else reject(reason);
      req.destroy();
    };
    const abort = () => fail(signal?.reason);
    req.on("error", (cause) => fail(new TypeError(controller ? "terminated" : "fetch failed", { cause })));
    req.once("close", () => { if (!controller && !finished) fail(new TypeError("fetch failed")); });
    req.once("response", (res) => {
      res.on("error", (cause) => fail(new TypeError("terminated", { cause })));
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        const status = res.statusCode!;
        const responseInit = { status, statusText: res.statusMessage, headers: responseHeaders };
        if (method.toUpperCase() === "HEAD" || status === 204 || status === 205 || status === 304) {
          resolve(new Response(null, responseInit));
          finish();
          req.destroy();
          return;
        }

        let bodyController!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start: (streamController) => { bodyController = streamController; },
          pull: () => { res.resume(); },
          cancel: () => { if (finish()) req.destroy(); },
        }, { highWaterMark: 0 });
        const response = new Response(stream, responseInit);
        controller = bodyController;
        res.pause();
        res.on("data", (chunk: Buffer) => {
          if (finished) return;
          res.pause();
          bodyController.enqueue(chunk);
        });
        res.once("end", () => { if (finish()) bodyController.close(); });
        resolve(response);
      } catch (cause) {
        fail(new TypeError("fetch failed", { cause }));
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    req.end(body);
  });
}
