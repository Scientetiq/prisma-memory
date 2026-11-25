import { PY_DIGIT_CLASS, PY_WS_CLASS, pyInt, pyRstrip, pySplitlines, pyStrip } from "./pytext.ts";

export interface Segment {
  startSec: number | null;
  endSec: number | null;
  text: string;
  speaker: string | null;
}

const D = PY_DIGIT_CLASS;
const TS = new RegExp(
  `^[${PY_WS_CLASS}]*\\[(?:([${D}]{1,2}):)?([${D}]{1,2}):([${D}]{2})\\][${PY_WS_CLASS}]*(?:([^:\\n]{1,40}):(?!//)[${PY_WS_CLASS}]*)?([^\\n]*)$`,
  "u",
);

export function parseTranscriptText(text: string): Segment[] {
  const segs: Segment[] = [];
  for (const raw of pySplitlines(text)) {
    const line = pyRstrip(raw);
    if (!pyStrip(line)) continue;
    const m = TS.exec(line);
    const last = segs[segs.length - 1];
    if (m) {
      const [, h, mnt, sec, speaker, body] = m;
      const start = (h ? pyInt(h) : 0) * 3600 + pyInt(mnt as string) * 60 + pyInt(sec as string);
      if (last && last.endSec === null) last.endSec = start;
      segs.push({ startSec: start, endSec: null, text: pyStrip(body as string), speaker: speaker ? pyStrip(speaker) : null });
    } else if (last) {
      last.text = pyStrip(last.text + " " + pyStrip(line));
    } else {
      segs.push({ startSec: null, endSec: null, text: pyStrip(line), speaker: null });
    }
  }
  return segs;
}
