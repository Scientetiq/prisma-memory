import { PAGE_TEXT } from "../../../../messages/panel-obo-consents";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, LoadError, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { param, type SearchParams } from "@/lib/paging";
import { revokeConsentAction } from "./actions";
import { consentState, REVOKED_BY, STATE_BADGES, type OboConsent, VIEW_TEXT } from "./view";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.readConsentsOnBehalfOfPeople }; }

const PAGE = 100;

export default async function OboConsentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(false);
  const sp = await searchParams;
  const cursor = param(sp, "cursor");
  const res = await tryGw<{ items: OboConsent[]; next_cursor?: string | null }>("/api/v1/admin/obo-consents",
    { query: { limit: String(PAGE), ...(cursor ? { cursor } : {}) } });
  const items = res.ok ? res.data.items : [];
  const prev = /^\d+$/.test(cursor) ? String(Math.max(0, Number(cursor) - PAGE)) : null;
  return (
    <PageFrame title={PAGE_TEXT.readConsentsOnBehalfOfPeople2} lead={VIEW_TEXT.oboAdminLead}>
      <Section title={PAGE_TEXT.consents}>
        {!res.ok ? <LoadError result={res} what={PAGE_TEXT.consents2} /> : !items.length ? <Empty icon="unlock">{PAGE_TEXT.noConsents}</Empty> : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead><tr><th>{PAGE_TEXT.service}</th><th>{PAGE_TEXT.colleague}</th><th>{PAGE_TEXT.status}</th><th>{PAGE_TEXT.expiry}</th><th>{PAGE_TEXT.actions}</th></tr></thead>
                <tbody>
                  {items.map((c) => {
                    const st = consentState(c), b = STATE_BADGES[st];
                    return (
                      <tr key={c.id ?? `${c.service.id}:${c.person}`}>
                        <td data-label={PAGE_TEXT.service2}>{c.service.name}</td>
                        <td data-label={PAGE_TEXT.colleague2}>{c.person ?? "—"}</td>
                        <td data-label={PAGE_TEXT.status2}><Badge tone={b.tone}>{b.title}</Badge>
                          {c.revoked_at ? <div className="cell-sub">{c.revoked_by ? REVOKED_BY[c.revoked_by] : PAGE_TEXT.closed} · <LocalTime iso={c.revoked_at} /></div> : null}
                        </td>
                        <td data-label={PAGE_TEXT.expiry2}>
                          {c.granted_at ? <>{rich(PAGE_TEXT.grantedValue1, null, { value1: <LocalTime iso={c.granted_at} /> })}</> : "—"}
                          {c.expires_at ? <div className="cell-sub">{rich(PAGE_TEXT.untilValue1, null, { value1: <LocalTime iso={c.expires_at} relative={false} /> })}</div> : null}
                        </td>
                        <td data-label={PAGE_TEXT.actions2}>
                          {st === "live" && c.id ? (
                            <ActionForm action={revokeConsentAction} submitLabel={PAGE_TEXT.revoke} pendingLabel="…" compact danger
                              confirm={{ question: PAGE_TEXT.revokeConsent, change: PAGE_TEXT.value1WillNoLongerBeAbleToReadOn(c.service.name, c.person ?? PAGE_TEXT.thisColleague), verb: PAGE_TEXT.revoke2, danger: true }}>
                              <input type="hidden" name="id" value={c.id} />
                            </ActionForm>
                          ) : <span className="muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/obo-consents" params={{}} cursorName="cursor" cursor={cursor} nextCursor={res.ok ? res.data.next_cursor ?? null : null} prevCursor={prev}
              shown={items.length} noun={PAGE_TEXT.consents3} />
          </>
        )}
      </Section>
    </PageFrame>
  );
}
