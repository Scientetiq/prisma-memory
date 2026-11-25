import { rich } from "../../../../i18n/rich";
import { TEXT } from "../../../../messages/panel-smtp";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { CursorPager } from "@/components/pager";
import { SectionSettingsForm, type SectionSettingView } from "@/components/section-settings-form";
import { TestAfterSave } from "@/components/test-after-save";
import { Badge, Empty, Field, LoadError, Notice, Section, TableWrap, type Tone } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { truncate } from "@/lib/format";
import { hrefWith, offsetOf, PAGE_SIZE, param, type SearchParams } from "@/lib/paging";
import { MAIL_KIND_TITLES, MAIL_STATUS_TITLES, SMTP_ERROR_TITLES } from "@/lib/smtp-form";
import { formatCount } from "@/lib/plain";
import type { LoginStatus, SettingsResponse } from "@/lib/types";
import { cancelMailAction, retryMailAction, saveSmtpAction, testSmtpAction } from "./actions";

export function generateMetadata(): Metadata { return { title: TEXT.mailSMTP }; }

interface MailRow {
  id: string; kind: string; to_address: string; subject: string; status: string; attempts: number; next_attempt_at: string;
  last_error_code: string | null; last_error: string | null; created_by: string | null; created_at: string; sent_at: string | null;
}
interface MailPage { items: MailRow[]; next_cursor: string | null; counts: Record<string, number>; enabled: boolean; max_attempts: number; keep_days: number; last_sent_at?: string | null }

const STATUS_TONES: Record<string, Tone> = { pending: "neutral", sending: "info", sent: "ok", failed: "danger", cancelled: "muted" };
const STATUSES = ["pending", "sending", "sent", "failed", "cancelled"];
const COUNT_TONES: Record<string, "ok" | "muted" | "danger" | "neutral"> = { pending: "neutral", sending: "neutral", sent: "ok", failed: "danger", cancelled: "muted" };

export default async function SmtpPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const askedStatus = param(sp, "status"), cursor = param(sp, "cursor");
  const status = STATUSES.includes(askedStatus) ? askedStatus : "";
  const params = { status, cursor };
  const offset = offsetOf(cursor);
  const [res, mail, loginStatus] = await Promise.all([
    tryGw<SettingsResponse>("/api/v1/admin/settings"),
    tryGw<MailPage>("/api/v1/admin/mail", { query: { status: status || undefined, limit: PAGE_SIZE, cursor: cursor || undefined } }),
    tryGw<LoginStatus>("/api/v1/admin/login-status"),
  ]);
  const items: SectionSettingView[] = res.ok
    ? res.data.items.filter((i) => i.category === "smtp" || (i.category === "access" && i.key === "workplace_url"))
        .map((i) => ({ key: i.key, category: i.category, value: i.secret ? null : i.value, secret: i.secret, isSet: i.isSet, description: i.description }))
    : [];
  const smtpItems = items.filter((i) => i.category === "smtp");
  const enabled = smtpItems.find((i) => i.key === "enabled")?.value === true;
  const adminEmail = String(smtpItems.find((i) => i.key === "admin_email")?.value ?? "");
  const counts = mail.ok ? mail.data.counts : {};
  const waiting = (counts.pending ?? 0) + (counts.sending ?? 0);
  const smtpStatus = loginStatus.ok ? loginStatus.data.smtp : null;

  return (
    <PageFrame title={TEXT.mailSMTP2} lead={TEXT.mailFromMemoryApprovalRequestsMeetingDeletion}>
      {!res.ok ? <LoadError result={res} what={TEXT.mailSettings2} /> : !smtpItems.length ? (
        <Notice tone="warn">{rich(TEXT.theGatewayDoesNotRecognizeTheSmtp, { code1: (children) => <code className="code">{children}</code> }, null)}</Notice>
      ) : (
        <>
          {enabled
            ? <Notice tone="ok" role="status">{rich(TEXT.mailSendingIsOnQueuedMessagesAre, null, { value1: String(smtpItems.find((i) => i.key === "host")?.value ?? ""), value2: waiting ? TEXT.waitingToBeSent(formatCount(waiting)) : "" })}</Notice>
            : <Notice tone="info" role="status">{rich(TEXT.mailSendingIsOffSetTheServer, null, { value1: waiting ? TEXT.queuedMessagesWaitingForSendingToBe(formatCount(waiting)) : "" })}</Notice>}

          <div className="status-card">
            <dl className="status-facts">
              <div>
                <dt>{TEXT.lastMessageSent}</dt>
                <dd>{mail.ok && mail.data.last_sent_at ? <LocalTime iso={mail.data.last_sent_at} /> : <span className="muted">{mail.ok ? TEXT.noMessagesSent : "—"}</span>}</dd>
              </div>
              <div>
                <dt>{TEXT.lastCheck}</dt>
                <dd>{!smtpStatus?.last_test ? <span className="muted">{smtpStatus ? TEXT.noChecksInTheLastDays : "—"}</span> : (
                  <><LocalTime iso={smtpStatus.last_test.at} />{" — "}{smtpStatus.last_test.ok === true ? <span className="ok-text">{TEXT.messageSent}</span>
                    : smtpStatus.last_test.ok === false ? <span className="danger-text">{rich(TEXT.error, null, { value1: smtpStatus.last_test.code ? `: ${SMTP_ERROR_TITLES[smtpStatus.last_test.code] ?? smtpStatus.last_test.code}` : "" })}</span>
                    : <span>{TEXT.queuedSeeTheMailLogBelowFor}</span>}</>
                )}</dd>
              </div>
              <div>
                <dt>{TEXT.settingsChanged}</dt>
                <dd>{!smtpStatus?.last_settings_change ? <span className="muted">{smtpStatus ? TEXT.unchangedInTheLastDays : "—"}</span>
                  : <><LocalTime iso={smtpStatus.last_settings_change.at} />{smtpStatus.last_settings_change.by ? ` — ${smtpStatus.last_settings_change.by}` : ""}</>}</dd>
              </div>
            </dl>
          </div>

          <Section title={TEXT.mailSettings} hint={TEXT.thePasswordIsStoredEncryptedAndNever}>
            <SectionSettingsForm section="smtp" items={items} action={saveSmtpAction} />
          </Section>

          <Section title={TEXT.sendATestMessage2} id="test" hint={TEXT.usesSavedSettingsIfThereAreUnsaved}>
            <TestAfterSave section="smtp" action={testSmtpAction} label={TEXT.sendATestMessage} saveLabel={TEXT.saveAndSendATestMessage}>
              <div className="form-grid">
                <Field label={TEXT.to} hint={adminEmail ? TEXT.yourWorkEmailAddressAdministratorEmailFrom : TEXT.yourWorkEmailAddressForExampleUser}>
                  <input type="email" name="to" defaultValue={adminEmail} required maxLength={254} autoComplete="off" />
                </Field>
                <Field label={TEXT.delivery}>
                  <select name="via" defaultValue="direct">
                    <option value="direct">{TEXT.immediatelyShowErrors}</option>
                    <option value="queue">{TEXT.throughTheQueue}</option>
                  </select>
                </Field>
              </div>
            </TestAfterSave>
          </Section>
        </>
      )}

      <div data-inpage="">{}
      <Section title={TEXT.mailLog2} id="mail" hint={mail.ok ? TEXT.noMessageBodiesOnlyRecipientSubjectStatus(mail.data.max_attempts, mail.data.keep_days) : undefined}>
        <nav className="tabs" aria-label={TEXT.messageStatus}>
          <Link prefetch={false} href="/admin/smtp#mail" className={!status ? "on" : undefined} aria-current={!status ? "page" : undefined}>{TEXT.all}</Link>
          {STATUSES.map((s) => (
            <Link prefetch={false} key={s} href={hrefWith("/admin/smtp", { status: s }) + "#mail"} className={status === s ? "on" : undefined} aria-current={status === s ? "page" : undefined}>
              {MAIL_STATUS_TITLES[s]}{counts[s] ? <span className={`cnt ${COUNT_TONES[s] ?? "neutral"}`}>{counts[s]}</span> : null}
            </Link>
          ))}
        </nav>
        {!mail.ok ? <LoadError result={mail} what={TEXT.mailLog} /> : !mail.data.items.length ? <Empty>{status ? TEXT.noMessagesWithThisStatus : TEXT.noMessagesYet}</Empty> : (
          <>
            <TableWrap>
              <table className="board cards-mobile">
                <thead><tr><th>{TEXT.message2}</th><th>{TEXT.status2}</th><th className="num">{TEXT.attempts2}</th><th>{TEXT.reason2}</th><th /></tr></thead>
                <tbody>
                  {mail.data.items.map((m) => (
                    <tr key={m.id}>
                      <td data-label={TEXT.message}>
                        {truncate(m.subject, 80)}
                        <div className="muted small">{MAIL_KIND_TITLES[m.kind] ?? m.kind} · {m.to_address} · <LocalTime iso={m.created_at} /></div>
                      </td>
                      <td data-label={TEXT.status}>
                        <Badge tone={STATUS_TONES[m.status] ?? "neutral"}>{MAIL_STATUS_TITLES[m.status] ?? m.status}</Badge>
                        {m.status === "sent" && m.sent_at ? <div className="muted small"><LocalTime iso={m.sent_at} /></div> : null}
                        {m.status === "pending" && m.attempts > 0 ? <div className="muted small">{rich(TEXT.retry2, null, { value1: <LocalTime iso={m.next_attempt_at} /> })}</div> : null}
                      </td>
                      <td className="num" data-label={TEXT.attempts}>{m.attempts}</td>
                      <td className="muted" data-label={TEXT.reason}>{m.last_error ? <>{m.last_error_code ? <Badge tone="muted">{SMTP_ERROR_TITLES[m.last_error_code] ?? m.last_error_code}</Badge> : null} {truncate(m.last_error, 200)}</> : "—"}</td>
                      <td>
                        {m.status === "failed" || m.status === "cancelled" ? (
                          <ActionForm action={retryMailAction} submitLabel={TEXT.retry} pendingLabel={TEXT.text3} compact quiet>
                            <input type="hidden" name="id" value={m.id} />
                          </ActionForm>
                        ) : m.status === "pending" ? (
                          <ActionForm action={cancelMailAction} submitLabel={TEXT.cancel} pendingLabel={TEXT.text2} compact quiet confirm={TEXT.cancelThisMessageItWillNotBe}>
                            <input type="hidden" name="id" value={m.id} />
                          </ActionForm>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/smtp" params={params} cursorName="cursor" cursor={cursor} nextCursor={mail.data.next_cursor}
              prevCursor={cursor ? String(Math.max(0, offset - PAGE_SIZE)) : null} shown={mail.data.items.length} anchor="mail" />
          </>
        )}
      </Section>
      </div>
    </PageFrame>
  );
}
