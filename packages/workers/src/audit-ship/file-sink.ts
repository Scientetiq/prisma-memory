// The file sink: JSONL in the directory observability.audit_ship_target.file_dir, one file per day of the event by
// UTC (audit-YYYY-MM-DD.jsonl). A write is accepted only after fsync: the cursor moves after it. The directory
// gets mode 0750, files 0640: the lines hold no content, but it is a journal.
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { lineText, type ShipLine } from "./line.ts";
import { ShipSinkError, type ShipSink } from "./sink.ts";

/** File of a day. */
export const fileOfDay = (day: string): string => `audit-${day}.jsonl`;

export function fileSink(dir: string): ShipSink {
  return {
    kind: "file",
    async write(lines: readonly ShipLine[]): Promise<void> {
      if (!lines.length) return;
      const byDay = new Map<string, string[]>();
      for (const l of lines) {
        const day = l.at.slice(0, 10);
        let list = byDay.get(day);
        if (!list) byDay.set(day, (list = []));
        list.push(lineText(l));
      }
      try { await mkdir(dir, { recursive: true, mode: 0o750 }); }
      catch (e) { throw new ShipSinkError("file_dir_unavailable", (e as Error).message); }
      for (const [day, texts] of byDay) {
        let fh;
        try {
          fh = await open(join(dir, fileOfDay(day)), "a", 0o640);
          await fh.write(texts.join("\n") + "\n");
          await fh.sync();
        } catch (e) {
          throw new ShipSinkError("file_write_failed", (e as Error).message);
        } finally {
          await fh?.close().catch(() => undefined);
        }
      }
    },
    async close(): Promise<void> { /* files are closed after each write */ },
  };
}
