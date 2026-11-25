import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACTS_DIR } from "./contracts.ts";

export const NOTICE_KINDS = ["optin_enabled", "optin_disabled", "connection_new", "connection_revoked_reuse", "refresh_reuse_rejected",
  "budget_exhausted", "idle_reminder", "idle_off", "ad_revoked"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const isNoticeKind = (v: unknown): v is NoticeKind => typeof v === "string" && (NOTICE_KINDS as readonly string[]).includes(v);

export interface NoticeVars { program?: string; time?: string; network?: string }
export interface NoticeText { banner: { title: string; text: string } | null; mail: { subject: string; body: string } | null }

interface NoticesContract { format: string; substitutions: string[]; notices: Record<string, NoticeText> }

let cached: NoticesContract | undefined;
export function noticesContract(): NoticesContract {
  cached ??= JSON.parse(readFileSync(resolve(CONTRACTS_DIR, "edge/notices.json"), "utf8")) as NoticesContract;
  return cached;
}

/** Write the instant in UTC as YYYY-MM-DD HH:MM UTC. */
export function noticeTime(d: Date): string {
  const iso = d.toISOString();
  const separator = iso.indexOf("T");
  return `${iso.slice(0, separator)} ${iso.slice(separator + 1, separator + 6)} UTC`;
}

export function noticeNetwork(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip.trim());
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!ip.includes(":")) return "";
  const [head, rest] = ip.trim().toLowerCase().split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [], r = rest ? rest.split(":") : [];
  const groups = rest === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - r.length)).fill("0"), ...r];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return "";
  const n = groups.map((g) => parseInt(g, 16));
  return `${n[0]!.toString(16)}:${n[1]!.toString(16)}:${n[2]!.toString(16)}:${(n[3]! & 0xff00).toString(16)}::/56`;
}

const fill = (s: string, v: NoticeVars): string =>
  s.replace(/\{(program|time|network)\}/g, (_, k: keyof NoticeVars) => (v[k] ?? "").replace(/[\r\n]+/g, " ").slice(0, 200));

export function noticeText(kind: NoticeKind, vars: NoticeVars = {}): NoticeText {
  const n = noticesContract().notices[kind];
  if (!n) throw new Error(`notices.json: no notice of type ${kind}`);
  return {
    banner: n.banner ? { title: fill(n.banner.title, vars), text: fill(n.banner.text, vars) } : null,
    mail: n.mail ? { subject: fill(n.mail.subject, vars), body: fill(n.mail.body, vars) } : null,
  };
}

type Queryable = { query(sql: string, params?: unknown[]): Promise<unknown> };

export async function queueExternalNotice(db: Queryable, personId: string, kind: NoticeKind, vars: NoticeVars,
                                          o: { mail?: boolean; dedupeKey?: string } = {}): Promise<void> {
  const t = noticeText(kind, vars);
  const mail = o.mail !== false && t.mail !== null;
  const data = { vars: { program: vars.program, time: vars.time, network: vars.network }, banner: t.banner !== null,
                 ...(mail ? { mail: t.mail } : {}), ...(o.dedupeKey ? { dedupe_key: o.dedupeKey } : {}) };
  await db.query("SELECT external_notice($1, $2, $3::jsonb, $4)", [personId, kind, JSON.stringify(data), mail]);
}
