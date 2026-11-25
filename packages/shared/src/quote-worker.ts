import { parentPort, workerData } from "node:worker_threads";
import { findQuote, NormalizedTranscript, parseTranscriptText } from "./pipeline-text/index.ts";

interface Job { transcript: string; quote: string; fuzzyThreshold: number }

try {
  const job = workerData as Job;
  const nt = new NormalizedTranscript(parseTranscriptText(job.transcript));
  const m = findQuote(job.quote, nt, { fuzzyThreshold: job.fuzzyThreshold });
  if (!m) parentPort!.postMessage({ found: null });
  else {
    const [timeFrom, timeTo] = nt.timeRange(m.wordFrom, m.wordTo);
    parentPort!.postMessage({ found: { kind: m.kind, ratio: m.ratio, time_from: timeFrom, time_to: timeTo } });
  }
} catch (e) {
  parentPort!.postMessage({ error: String((e as Error)?.message ?? e).slice(0, 200) || "unknown quote search error" });
}
