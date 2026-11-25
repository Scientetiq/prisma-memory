import { parentPort } from "node:worker_threads";
import { openCheck, openCheckConfig, type OpenCheckSettings, type OpenCheckText } from "./open-check.ts";

interface Job { id: number; settings: OpenCheckSettings; texts: OpenCheckText[]; force: boolean }

parentPort!.on("message", (m: Job) => {
  try {
    parentPort!.postMessage({ id: m.id, findings: openCheck(openCheckConfig(m.settings), m.texts, { force: m.force }) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: String((e as Error)?.message ?? e).slice(0, 200) || "unknown check error" });
  }
});
parentPort!.postMessage({ ready: true });
