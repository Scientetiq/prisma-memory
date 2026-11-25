import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACTS_DIR } from "./contracts.ts";
import { noticeTime } from "./external-notices.ts";

export const SECURITY_MAIL_TEMPLATES = ["factor_locked", "factor_locked_inside", "recovery_used", "factor_enrolled", "factor_replaced",
  "recovery_reissued", "factor_reset", "recovery_reissue"] as const;
export type SecurityMailTemplate = (typeof SECURITY_MAIL_TEMPLATES)[number];

export interface SecurityMailVars { time?: string; count?: number }
export interface SecurityMailText { subject: string; body: string }

interface SecurityMailsContract {
  format: string;
  substitutions: string[];
  mails: Record<string, SecurityMailText & { sender: string }>;
}

let cached: SecurityMailsContract | undefined;
export function securityMailsContract(): SecurityMailsContract {
  cached ??= JSON.parse(readFileSync(resolve(CONTRACTS_DIR, "edge/security-mails.json"), "utf8")) as SecurityMailsContract;
  return cached;
}

const fill = (s: string, v: SecurityMailVars): string =>
  s.replace(/\{(time|count)\}/g, (_, k: keyof SecurityMailVars) => {
    const x = v[k];
    if (k === "count") return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? String(x) : "";
    return typeof x === "string" ? x.replace(/[\r\n]+/g, " ").slice(0, 40) : "";
  });

export function securityMailText(template: SecurityMailTemplate, vars: SecurityMailVars = {}): SecurityMailText {
  const m = securityMailsContract().mails[template];
  if (!m) throw new Error(`security-mails.json: missing e-mail ${template}`);
  const v = { time: noticeTime(new Date()), ...vars };
  return { subject: fill(m.subject, v), body: fill(m.body, v) };
}

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

export async function queueSecurityMail(db: Queryable, personId: string, template: SecurityMailTemplate, vars: SecurityMailVars = {},
                                        dedupe: string | null = null): Promise<boolean> {
  const t = securityMailText(template, vars);
  const { rows } = await db.query("SELECT security_mail($1, $2, $3, $4, $5) AS ok", [personId, template, t.subject, t.body, dedupe]);
  return rows[0]?.ok === true;
}
