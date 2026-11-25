import type { NightCapReport } from "./types";
import { formatDate } from "../i18n/format";
import { instanceTz } from "../i18n/runtime";

import { nightCap as m } from "../messages/night-cap";

export function tokensText(n: number): string {
  return m.tokenAmount(n);
}


export function nightCapLines(nc: NightCapReport | null | undefined, tz = instanceTz()): Array<{ text: string; tone: "info" | "warn" }> {
  if (nc === undefined) return [];
  if (nc === null) return [{ text: m.unavailable, tone: "warn" }];
  const out: Array<{ text: string; tone: "info" | "warn" }> = [
    { text: m.workedTokens(nc.last_night.tokens, nc.cap), tone: "info" },
  ];
  if (nc.last_night.capped && nc.last_night.capped_at) {
    const at = formatDate(new Date(nc.last_night.capped_at), { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    out.push({ text: m.capped(at, nc.waiting), tone: "warn" });
  } else if (nc.waiting) {
    out.push({ text: m.waiting(nc.waiting), tone: "info" });
  }
  return out;
}
