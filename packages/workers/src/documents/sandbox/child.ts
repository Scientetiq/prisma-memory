import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serialize } from "node:v8";
import {
  isFailureCode,
  isPacket,
  type ChildPacket,
  type ParseRequest,
  type Parser,
  type ParserContext,
} from "./protocol.ts";

process.on("disconnect", () => process.exit());

const ready: ChildPacket = { type: "ready" };
if (process.platform === "linux") {
  try {
    writeFileSync("/proc/self/oom_score_adj", "1000");
    ready.oomScoreAdjusted = true;
  } catch {
    ready.oomScoreAdjusted = false;
  }
}

const parserModule = await import(pathToFileURL(process.argv[2]).href);
if (typeof parserModule.parse !== "function") process.exit(1);
const parse: Parser = parserModule.parse;
const ctx: ParserContext = { maxResultBytes: Number(process.argv[3]) };
const maxResultBytes = ctx.maxResultBytes;

function send(packet: ChildPacket): void {
  process.send?.(packet, (error) => {
    if (error) process.exit(1);
  });
}

async function run({ id, job }: ParseRequest): Promise<void> {
  try {
    const data = serialize(await parse(job, ctx));
    if (data.byteLength > maxResultBytes) {
      send({ type: "failure", id, code: "resource_limit" });
      return;
    }
    send({ type: "result", id, data });
  } catch (error) {
    const code = isPacket(error) ? error.code : undefined;
    send({ type: "failure", id, code: isFailureCode(code) ? code : "parser_failed" });
  }
}

process.on("message", (request: ParseRequest) => void run(request));
send(ready);
