import { instanceLocale } from "@memory/i18n/context";
import { circleOf, type CustodyBasis, type CustodyPolicy } from "./custody.ts";
import { renderMail, type MailText } from "./mail-render.ts";
import { MAIL_RE } from "./smtp.ts";
import { showcaseSql } from "./test-logins.ts";

/**
 * Mail to the new custodian (template custody.handed, messages/mail-custody.ts), in the instance language. `link` — the
 * full address of the page /custody/{slug} or null (then words: "in the workspace…"); `meetings` — how many meetings of
 * the former employee passed to the custodian (the line about meetings only when n > 0).
 */
export function custodyMail(a: { name: string; basis: CustodyBasis; link: string | null; meetings: number }): MailText {
  return renderMail("custody.handed", instanceLocale(), a);
}

/** Mail to the previous custodian when the administrator handed the records to someone else (template custody.off). */
export function custodyOffMail(a: { name: string }): MailText {
  return renderMail("custody.off", instanceLocale(), a);
}

export const custodyMailable = (p: { active: boolean; demo: boolean; login: string | null }): boolean =>
  !!p.login && p.active && !p.demo && circleOf(p.login) === "staff" && MAIL_RE.test(p.login);

export const CUSTODY_MAIL_STALE = "custody_not_current";
export const CUSTODY_MAIL_STALE_TEXT = "The e-mail was not sent because custody no longer matches it. The employee may have returned, the custodian may have changed or left, read access may be off, or the waiting period may still be in effect";

export function custodyMailKey(key: string | null | undefined): { off: boolean; space: string; person: string; at: string } | null {
  const m = /^(custody|custody_off):([0-9a-f-]{36}):([0-9a-f-]{36}):(\S+)$/i.exec(key ?? "");
  return m ? { off: m[1] === "custody_off", space: m[2]!.toLowerCase(), person: m[3]!.toLowerCase(), at: m[4]! } : null;
}

type CustodyMailQueryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export async function custodyMailCurrent(control: CustodyMailQueryable, instanceId: string, dedupeKey: string | null | undefined,
                                         policy: Pick<CustodyPolicy, "read" | "afterDays">): Promise<boolean> {
  return (await custodyMailRecipient(control, instanceId, dedupeKey, policy)) !== null;
}

export async function custodyMailRecipient(control: CustodyMailQueryable, instanceId: string, dedupeKey: string | null | undefined,
                                           policy: Pick<CustodyPolicy, "read" | "afterDays">): Promise<string | null> {
  const k = custodyMailKey(dedupeKey);
  if (!k || policy.read === "off") return null;
  const r = (await control.query(
    `SELECT c.custodian_id, s.archived_at, s.archived_at <= now() - make_interval(days => $3::int) AS due,
            k.login AS c_login, k.active AS c_active, ${showcaseSql("k")} AS c_demo
       FROM personal_custody c
       JOIN people p ON p.id = c.person_id AND NOT p.active
       JOIN spaces s ON s.id = c.space_id AND s.kind = 'personal' AND s.owner_id = p.id AND s.archived_at IS NOT NULL
       LEFT JOIN people k ON k.id = c.custodian_id
      WHERE c.instance_id = $1 AND c.space_id = $2`, [instanceId, k.space, policy.afterDays])).rows[0];
  if (!r) return null;
  const frozen = new Date(r.archived_at).toISOString();
  const to = (x: { active: unknown; demo: unknown; login: unknown }): string | null => {
    const login = typeof x.login === "string" ? x.login : null;
    return custodyMailable({ active: x.active === true, demo: x.demo === true, login }) ? login!.trim().toLowerCase() : null;
  };
  if (!k.off)
    return r.custodian_id === k.person && frozen === k.at && r.due === true ? to({ active: r.c_active, demo: r.c_demo, login: r.c_login }) : null;
  if (!r.custodian_id || r.custodian_id === k.person) return null;
  const first = (await control.query("SELECT status FROM mail_outbox WHERE instance_id = $1 AND dedupe_key = $2",
                                     [instanceId, `custody:${k.space}:${k.person}:${frozen}`])).rows[0] as { status: string } | undefined;
  if (first && first.status !== "sent") return null;
  const prev = (await control.query(`SELECT p.login, p.active, ${showcaseSql("p")} AS demo FROM people p WHERE p.id = $1 AND p.instance_id = $2`,
                                    [k.person, instanceId])).rows[0];
  return prev ? to(prev) : null;
}

export async function custodyMailForget(control: CustodyMailQueryable, instanceId: string, dedupeKey: string | null | undefined): Promise<void> {
  const k = custodyMailKey(dedupeKey);
  if (!k || k.off) return;
  await control.query("UPDATE personal_custody SET notified_id = NULL WHERE instance_id = $1 AND space_id = $2 AND notified_id = $3", [instanceId, k.space, k.person]);
}
