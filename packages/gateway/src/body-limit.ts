import type { Context, MiddlewareHandler } from "hono";
import { tooLarge } from "@memory/shared";

/** Count bytes on demand, without buffering or pulling a body before authentication. */
export function streamingBodyLimit(maxSize: number, onError: (c: Context) => Response): MiddlewareHandler {
  return async (c, next) => {
    const req = c.req.raw;
    if (!req.body) return next();
    const declared = req.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxSize) {
      void req.body.cancel().catch(() => undefined);
      return onError(c);
    }
    const reader = req.body.getReader();
    let bytes = 0, exceeded = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); return; }
          bytes += chunk.value.byteLength;
          if (bytes > maxSize) {
            exceeded = true;
            void reader.cancel().catch(() => undefined);
            controller.error(tooLarge("Request body exceeds the allowed size"));
            return;
          }
          controller.enqueue(chunk.value);
        } catch (e) { controller.error(e); }
      },
      cancel(reason) { return reader.cancel(reason); },
    }, { highWaterMark: 0 });
    c.req.raw = new Request(req, { body, duplex: "half" } as RequestInit);
    try {
      await next();
      // A body parser may catch the stream error and turn it into a validation error.
      if (exceeded) c.res = onError(c);
    } finally {
      // Authentication/Origin refusals leave the stream untouched; release the sender.
      if (!body.locked) void body.cancel().catch(() => undefined);
    }
  };
}
