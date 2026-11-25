// TEI reports a separate limit for client batches. Metadata and all batches share one search deadline.
import { PlatformError } from "../../platform-error.ts";
import { connectionRerankCapabilities } from "../capabilities.ts";
import type { RerankAdapter } from "../types.ts";
import { checkDocuments, checkRerankReply, decodeScores, orderScores, rerankUsage, type RerankScore } from "./common.ts";

export const teiRerank: RerankAdapter = {
  async rerank(io, req) {
    const caps = connectionRerankCapabilities(io.connection);
    checkDocuments(req.documents, caps);
    if (!req.documents.length) return [];
    const deadline = performance.now() + caps.timeout_ms;
    const remaining = () => {
      const ms = Math.ceil(deadline - performance.now());
      if (ms <= 0) throw new PlatformError("timeout", io.texts.timeout(caps.timeout_ms));
      return ms;
    };
    let batchSize = 32;
    {
      try {
        const info = await io.get("/info", { timeoutMs: Math.min(1000, remaining()) });
        const size = info.json?.max_client_batch_size;
        if (info.status === 200 && Number.isSafeInteger(size) && size > 0) batchSize = Math.min(size, caps.max_documents);
      } catch (e) {
        // A missing metadata route or an old TEI server is usable with the conservative batch size. Security refusals
        // and caller cancellation must still stop the call rather than being converted into a paid request.
        if (!(e instanceof PlatformError) || !["http", "timeout"].includes(e.kind)) throw e;
      }
    }
    const scores: RerankScore[] = [];
    for (let offset = 0; offset < req.documents.length; offset += batchSize) {
      const documents = req.documents.slice(offset, offset + batchSize);
      const reply = await io.post(caps.path, { query: req.query, texts: documents, raw_scores: caps.score === "logit" }, { timeoutMs: remaining() });
      let ok = false;
      try {
        checkRerankReply(io, reply);
        scores.push(...decodeScores(reply.json, documents.length, "score", caps.score).map((r) => ({ ...r, index: r.index + offset })));
        ok = true;
      } finally { io.report(rerankUsage(ok, reply.json, req.query, documents, caps.usage_unit)); }
    }
    return orderScores(scores);
  },
};
