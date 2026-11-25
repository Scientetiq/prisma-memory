// Cohere v2, Jina and OpenRouter share a response shape; the legacy gateway keeps its original wire and outcomes.
import { PlatformError } from "../../platform-error.ts";
import { withReplyDetail } from "../transport.ts";
import { connectionRerankCapabilities } from "../capabilities.ts";
import type { ModelIo, RerankAdapter } from "../types.ts";
import { checkDocuments, checkRerankReply, decodeScores, rerankUsage } from "./common.ts";
export { rerankUsage } from "./common.ts";

export const cohereFormatRerank: RerankAdapter = {
  async rerank(io: ModelIo, req) {
    const caps = connectionRerankCapabilities(io.connection);
    if (!io.connection.legacy) { checkDocuments(req.documents, caps); if (!req.documents.length) return []; }
    const body = io.connection.legacy ? { model: req.model, query: req.query, documents: req.documents, top_n: req.documents.length }
      : { ...caps.extra_body, model: req.model, query: req.query, documents: req.documents,
        ...(caps.top_param ? { [caps.top_param]: req.documents.length } : {}) };
    const reply = await io.post(io.connection.legacy ? "/rerank" : caps.path, body,
      { timeoutMs: io.connection.legacy ? req.timeoutMs : caps.timeout_ms });
    const { status, json } = reply;
    const results = json?.results;
    if (!io.connection.legacy) {
      let ok = false;
      try {
        checkRerankReply(io, reply);
        const scores = decodeScores(results, req.documents.length, "relevance_score", caps.score);
        ok = true; return scores;
      } finally { io.report(rerankUsage(ok, json, req.query, req.documents, caps.usage_unit)); }
    }
    io.report(rerankUsage(status < 400 && Array.isArray(results), json, req.query, req.documents));
    if (status === 429) throw withReplyDetail(new PlatformError("busy", io.texts.busy("rerank"), 429), reply);
    if (status >= 400 || !Array.isArray(results)) throw withReplyDetail(new PlatformError("http", io.texts.failed("rerank", status, json), status), reply);
    // original document indices are kept
    return results.map((r: any) => ({ index: Number(r.index), score: Number(r.relevance_score) }));
  },
};
