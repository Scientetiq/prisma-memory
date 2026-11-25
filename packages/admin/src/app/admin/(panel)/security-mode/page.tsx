import { ATTEST_OPTIONS, PAGE_TEXT } from "../../../../messages/panel-security-mode";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, Empty, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { readSession } from "@/lib/session";
import { approveDowngradeAction, approveRetireDowngradeAction, attestAction, cancelDowngradeAction, executeDowngradeAction, requestDowngradeAction } from "./actions";
import { DOWNGRADE_REASON_MIN, downgradeButtons, MODE_TEXT, PENDING_BADGES, type ModeState } from "./view";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.securityMode }; }


export default async function SecurityModePage() {
  await guardAuditorPage(true);
  const [res, session] = await Promise.all([tryGw<ModeState>("/api/v1/admin/security-mode"), readSession()]);
  const me = { login: session?.login ?? null, role: session?.role ?? null };
  const admin = me.role === "memory_admin";
  return (
    <PageFrame title={PAGE_TEXT.securityMode2} allowAuditor
      lead={PAGE_TEXT.basicIsTheDefaultModeAgentsWorkWithoutHuman}>
      {!res.ok ? <LoadError result={res} what={PAGE_TEXT.securityMode3} /> : (() => {
        const s = res.data;
        const m = MODE_TEXT[s.mode];
        const p = s.pending;
        const retireOpt = { retirePossible: s.retire_possible === true };
        return (
          <>
            <Section title={PAGE_TEXT.now}>
              <p><Badge tone={m.tone}>{m.title}</Badge> {m.line}</p>
              {s.floor === "advanced" && s.setting !== "advanced" ? <Notice tone="warn">{PAGE_TEXT.theAnchorsSetAnAdvancedModeFloorAdvancedApplies}</Notice> : null}
              {s.mode === "basic" ? <p className="hint">{rich(PAGE_TEXT.switchToAdvancedTag1ReadinessEnableAdvancedTag1, { tag1: (children) => <Link prefetch={false} href="/admin/readiness?target=advanced">{children}</Link> }, null)}</p> : null}
            </Section>

            {s.mode === "advanced" || p ? (
              <Section title={PAGE_TEXT.returnToBasic} hint={PAGE_TEXT.aMemoryAdministratorSubmitsAReasonAnotherMemoryAdministrator(s.downgrade_delay_hours)}>
                {p ? (
                  <TableWrap cards>
                    <table className="board">
                      <thead><tr><th>{PAGE_TEXT.request}</th><th>{PAGE_TEXT.status}</th><th>{PAGE_TEXT.executeNoEarlierThan}</th><th>{PAGE_TEXT.actions}</th></tr></thead>
                      <tbody>
                        <tr id={`pending-${p.id}`}>
                          <td data-label={PAGE_TEXT.request2}><span className="cell-main">{p.reason}</span>
                            <div className="cell-sub">{rich(PAGE_TEXT.requestedByValue1Value2, null, { value1: p.requested_by ?? "—", value2: p.requested_at ? <> · <LocalTime iso={p.requested_at} /></> : null })}</div></td>
                          <td data-label={PAGE_TEXT.status2}><Badge tone={PENDING_BADGES[p.state].tone}>{PENDING_BADGES[p.state].title}</Badge>
                            {p.approved_by ? <div className="cell-sub">{rich(PAGE_TEXT.signedByValue1Value2, null, { value1: p.approved_by, value2: p.approved_at ? <> · <LocalTime iso={p.approved_at} /></> : null })}</div> : null}
                            {p.approved_anchors_serial ? <div className="cell-sub">{rich(PAGE_TEXT.signedWithRetirementDocumentNoValue1Value2, null, { value1: p.approved_anchors_serial, value2: p.approved_at ? <> · <LocalTime iso={p.approved_at} /></> : null })}</div> : null}</td>
                          <td data-label={PAGE_TEXT.executeNoEarlierThan2}>{p.not_before ? <LocalTime iso={p.not_before} /> : "—"}</td>
                          <td data-label={PAGE_TEXT.actions2}><div className="row-actions">
                            {downgradeButtons(p, me, retireOpt).includes("approve") ? (
                              <ActionForm action={approveDowngradeAction} submitLabel={PAGE_TEXT.sign} pendingLabel="…" compact
                                confirm={{ question: PAGE_TEXT.signTheReturnToBasic, change: PAGE_TEXT.reasonValue1AfterTheDelayTheModeReturnsTo(p.reason), verb: PAGE_TEXT.sign2 }}>
                                <input type="hidden" name="id" value={p.id} />
                              </ActionForm>) : null}
                            {downgradeButtons(p, me, retireOpt).includes("approve_retire") ? (
                              <ActionForm action={approveRetireDowngradeAction} submitLabel={PAGE_TEXT.signWithRetirementDocument} pendingLabel="…" compact
                                confirm={{ question: PAGE_TEXT.signTheReturnWithTheAppliedRetirementDocument, change: PAGE_TEXT.noSecondAdministratorHasKeysTheSignatureWillBe, verb: PAGE_TEXT.sign3 }}>
                                <input type="hidden" name="id" value={p.id} />
                              </ActionForm>) : null}
                            {downgradeButtons(p, me, retireOpt).includes("execute") ? (
                              <ActionForm action={executeDowngradeAction} submitLabel={PAGE_TEXT.executeReturn} pendingLabel="…" compact danger
                                confirm={{ question: PAGE_TEXT.returnToBasicMode, change: PAGE_TEXT.flagsWillReturnToTheirPreviousValuesOpenSecond, verb: PAGE_TEXT.return, danger: true }}>
                                <input type="hidden" name="id" value={p.id} />
                              </ActionForm>) : null}
                            {downgradeButtons(p, me, retireOpt).includes("cancel") ? (
                              <ActionForm action={cancelDowngradeAction} submitLabel={PAGE_TEXT.cancel} pendingLabel="…" compact quiet>
                                <input type="hidden" name="id" value={p.id} />
                              </ActionForm>) : null}
                            {!downgradeButtons(p, me, retireOpt).length ? <span className="muted">—</span> : null}
                          </div></td>
                        </tr>
                      </tbody>
                    </table>
                  </TableWrap>
                ) : admin ? (
                  <ActionForm action={requestDowngradeAction} submitLabel={PAGE_TEXT.requestReturn} pendingLabel={PAGE_TEXT.submitting} danger
                    confirm={{ question: PAGE_TEXT.requestAReturnToBasic, change: PAGE_TEXT.aHighAlertWillBeSentToAllAdministrators, verb: PAGE_TEXT.submit, danger: true }}>
                    <Field label={PAGE_TEXT.reason} hint={PAGE_TEXT.atLeastValue1CharactersVisibleToTheSignerAnd(DOWNGRADE_REASON_MIN)}>
                      <textarea name="reason" rows={3} minLength={DOWNGRADE_REASON_MIN} maxLength={500} required />
                    </Field>
                    <label className="check">{rich(PAGE_TEXT.value1IUnderstandAfterReturningThereAreNoSecond, null, { value1: <input type="checkbox" name="ack" /> })}</label>
                  </ActionForm>
                ) : <p className="hint">{PAGE_TEXT.aMemoryAdministratorCanRequestAReturn}</p>}
              </Section>
            ) : null}

            <Section title={PAGE_TEXT.modeChangeHistory}>
              {!s.changes.length ? <Empty icon="circle-check">{PAGE_TEXT.theModeHasNotChangedBasicSinceInstallation}</Empty> : (
                <TableWrap cards>
                  <table className="board">
                    <thead><tr><th>{PAGE_TEXT.when}</th><th>{PAGE_TEXT.change}</th><th>{PAGE_TEXT.who}</th><th>{PAGE_TEXT.revoked}</th></tr></thead>
                    <tbody>
                      {s.changes.map((c, i) => (
                        <tr key={`${c.at}-${i}`}>
                          <td data-label={PAGE_TEXT.when2}>{c.at ? <LocalTime iso={c.at} /> : "—"}</td>
                          <td data-label={PAGE_TEXT.change2}>{c.from ?? "—"} → {c.to}{c.reason ? <div className="cell-sub">{c.reason}</div> : null}</td>
                          <td data-label={PAGE_TEXT.who2}>{c.by ?? "—"}</td>
                          <td data-label={PAGE_TEXT.revoked2}>{c.to === "advanced" ? PAGE_TEXT.keysValue1SessionsValue2(c.keys_revoked, c.sessions_revoked) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Section>

            {admin ? (
              <Section title={PAGE_TEXT.humanConfirmations} id="attest" fold={{ open: false }}
                hint={PAGE_TEXT.whatTheGatewayCannotCheckItselfKeysBoundTo}>
                <ActionForm action={attestAction} submitLabel={PAGE_TEXT.confirm} pendingLabel="…" resetOnSuccess>
                  <Field label={PAGE_TEXT.whatAreYouConfirming}>
                    <select name="kind" defaultValue="">
                      <option value="" disabled>{PAGE_TEXT.select}</option>
                      {ATTEST_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.title}</option>)}
                    </select>
                  </Field>
                  <Field label={PAGE_TEXT.subjects} hint={PAGE_TEXT.onePerLineUpTo50AdministratorLoginsSHA}>
                    <textarea name="subjects" rows={4} spellCheck={false} required />
                  </Field>
                  <Field label={PAGE_TEXT.note} hint={PAGE_TEXT.optionalUpTo300CharactersAnITTicketReference}>
                    <input name="note" maxLength={300} />
                  </Field>
                </ActionForm>
              </Section>
            ) : null}
          </>
        );
      })()}
    </PageFrame>
  );
}
