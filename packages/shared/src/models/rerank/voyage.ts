// Voyage's native rerank format. No SDK, retries or independent transport.
import { connectionRerankCapabilities } from "../capabilities.ts";
import type { RerankAdapter } from "../types.ts";
import { checkDocuments, checkRerankReply, decodeScores, rerankUsage } from "./common.ts";

export const voyageRerank: RerankAdapter = {
  async rerank(io, req) {
    const caps = connectionRerankCapabilities(io.connection);
    checkDocuments(req.documents, caps);
    if (!req.documents.length) return [];
    const reply = await io.post(caps.path, { model: req.model, query: req.query, documents: req.documents,
      ...(caps.top_param ? { [caps.top_param]: req.documents.length } : {}) }, { timeoutMs: caps.timeout_ms });
    let ok = false;
    try {
      checkRerankReply(io, reply);
      const scores = decodeScores(reply.json?.data, req.documents.length, "relevance_score", caps.score);
      ok = true; return scores;
    } finally { io.report(rerankUsage(ok, reply.json, req.query, req.documents, caps.usage_unit)); }
  },
};
