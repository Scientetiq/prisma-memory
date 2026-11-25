import { pageText as M } from "@/messages/ws-consents";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { Badge, Empty, LoadError, Notice, PageHead, Section } from "@/components/ui";
import { meGw } from "@/lib/me-api";
import { requireWorkspace } from "@/lib/me";
import { PREVIEW_TEXT } from "@/lib/preview";
import { consentState, consentTexts, REVOKED_BY, STATE_BADGES, type OboConsent } from "@/app/admin/(panel)/obo-consents/view";
import { SECTION_TITLES } from "@/lib/plain";
import { grantConsentAction, revokeConsentAction } from "./actions";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.consents }; }

export default async function ConsentsPage() {
  const { session } = await requireWorkspace();
  const res = session.preview ? null : await meGw<{ mode: string; items: OboConsent[] }>(session.key, "/api/v1/me/obo-consents");
  const t = consentTexts(res?.ok ? res.data.mode : "consent");
  return (
    <>
      <PageHead title={SECTION_TITLES.consents} lead={M.companyServicesThatCanSearchAnd} />
      {session.preview || !res ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice>
        : !res.ok ? <LoadError result={res} what={M.services} />
        : (
          <>
            <Notice tone={t.tone} role="status">{t.notice}</Notice>
            <Section title={M.services2}>
              {!res.data.items.length ? <Empty icon="bot">{rich(M.noServicesCurrentlyReadOnBehalf, null)}</Empty> : (
                <ul className="agents ag-cards">
                  {res.data.items.map((c) => {
                    const st = consentState(c), b = STATE_BADGES[st];
                    return (
                      <li key={c.service.id} className="ag-card">
                        <div className="ag-main">
                          <b className="ag-name">{c.service.name} <Badge tone={b.tone}>{st === "none" ? M.notAllowed : b.title}</Badge></b>
                          <small>
                            {st === "live" && c.expires_at ? <>{rich(M.allowedUntil, { tag0: () => <LocalTime iso={c.expires_at} short relative={false} /> })}</>
                              : st === "revoked" && c.revoked_at ? <>{c.revoked_by ? REVOKED_BY[c.revoked_by] : M.ended} · <LocalTime iso={c.revoked_at} short /></>
                              : st === "expired" && c.expires_at ? <>{rich(M.expired, { tag0: () => <LocalTime iso={c.expires_at} short relative={false} /> })}</>
                              : t.none}
                          </small>
                        </div>
                        <div className="ag-act">
                          {st === "live" && c.id ? (
                            <>
                              <ActionForm action={grantConsentAction} submitLabel={M.renew} pendingLabel="…" compact quiet>
                                <input type="hidden" name="service_id" value={c.service.id} />
                              </ActionForm>
                              <ActionForm action={revokeConsentAction} submitLabel={M.withdraw} pendingLabel="…" compact danger
                                confirm={{ question: M.revokePermission, change: t.revokeChange(c.service.name), verb: M.withdraw, danger: true }}>
                                <input type="hidden" name="id" value={c.id} />
                                <input type="hidden" name="mode" value={t.mode} />
                              </ActionForm>
                            </>
                          ) : (
                            <ActionForm action={grantConsentAction} submitLabel={M.allow} pendingLabel="…" compact
                              confirm={{ question: M.allowToReadOnYourBehalf(c.service.name), change: M.withinItsPermissionsTheServiceCan, verb: M.allow }}>
                              <input type="hidden" name="service_id" value={c.service.id} />
                            </ActionForm>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </>
        )}
    </>
  );
}
