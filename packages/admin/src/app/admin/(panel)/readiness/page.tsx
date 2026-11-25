import { PAGE_TEXT } from "../../../../messages/panel-readiness";
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
import { MODE_TEXT } from "../security-mode/view";
import { enableAdvancedAction } from "./actions";
import { ProfileConfirm } from "./profile-confirm";
import { canEnableAdvanced, checkBadge, FLAG_TITLES, type Check, type ReadinessView, valueText, warningLines, wouldRequireLine } from "./view";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.readiness }; }

function CheckTable({ checks, mode, label }: { checks: readonly Check[]; mode: ReadinessView["mode"]; label: string }) {
  return (
    <TableWrap cards>
      <table className="board" aria-label={label}>
        <thead><tr><th>{PAGE_TEXT.check}</th><th>{PAGE_TEXT.status}</th><th>{PAGE_TEXT.details}</th></tr></thead>
        <tbody>
          {checks.map((c) => {
            const b = checkBadge(c, mode);
            return (
              <tr key={c.id} id={`check-${c.id}`} className={b.tone === "muted" ? "muted" : undefined}>
                <td data-label={PAGE_TEXT.check2}>{c.title}</td>
                <td data-label={PAGE_TEXT.status2}><Badge tone={b.tone}>{b.title}</Badge></td>
                <td data-label={PAGE_TEXT.details2}>{c.detail ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function GateWarnings({ g }: { g: ReadinessView["gate"][number] }) {
  const lines = warningLines(g);
  return lines.length ? <ul className="plain" aria-label={PAGE_TEXT.warnings}>{lines.map((w) => <li key={w}><Badge tone="warn">{PAGE_TEXT.worthKnowing}</Badge> {w}</li>)}</ul> : null;
}

export default async function ReadinessPage() {
  await guardAuditorPage(true);
  const [res, session] = await Promise.all([tryGw<ReadinessView>("/api/v1/admin/readiness", { query: { target: "advanced" } }), readSession()]);
  return (
    <PageFrame title={PAGE_TEXT.readiness2} allowAuditor
      lead={PAGE_TEXT.whatIsReadyAndWhatNeedsAttentionSeparatePanel}>
      {!res.ok ? <LoadError result={res} what={PAGE_TEXT.readinessChecks} /> : (() => {
        const v = res.data;
        const m = MODE_TEXT[v.mode];
        const dry = v.dry_run;
        const would = wouldRequireLine(dry?.would_require_30d);
        return (
          <>
            <Section title={PAGE_TEXT.securityMode}>
              <p>{rich(PAGE_TEXT.value1Value2Tag3DetailsAndReturnTag3, { tag3: (children) => <Link prefetch={false} href="/admin/security-mode">{children}</Link> }, { value1: <Badge tone={m.tone}>{m.title}</Badge>, value2: m.line })}</p>
            </Section>

            <Section title={PAGE_TEXT.checks}>
              <CheckTable checks={v.checks} mode={v.mode} label={PAGE_TEXT.checks2} />
            </Section>

            <Section title={PAGE_TEXT.externalPerimeterGates} hint={PAGE_TEXT.anExternalAccessFlagCanOnlyBeEnabledWhen}>
              {!v.gate.length ? <Empty icon="circle-check">{PAGE_TEXT.gatesCouldNotBeReadCheckTheGatewayLog}</Empty> : (
                <TableWrap cards>
                  <table className="board" aria-label={PAGE_TEXT.externalPerimeterGates2}>
                    <thead><tr><th>{PAGE_TEXT.flag}</th><th>{PAGE_TEXT.now}</th><th>{PAGE_TEXT.unmetRequirements}</th></tr></thead>
                    <tbody>
                      {v.gate.map((g) => (
                        <tr key={g.flag} id={`gate-${g.flag}`}>
                          <td data-label={PAGE_TEXT.flag2}>{FLAG_TITLES[g.flag] ?? g.flag}<div className="cell-sub"><code className="code">{g.flag}</code></div></td>
                          <td data-label={PAGE_TEXT.now2}>{g.open ? <Badge tone="warn">{PAGE_TEXT.enabled}</Badge> : <Badge tone="muted">{PAGE_TEXT.disabled}</Badge>}</td>
                          <td data-label={PAGE_TEXT.unmetRequirements2}>{!g.failed.length && !g.profile?.length ? <><Badge tone="ok">{PAGE_TEXT.allRequirementsMet}</Badge><GateWarnings g={g} /></> : (
                            <>
                              {g.failed.length ? <ul className="plain">{g.failed.map((f) => <li key={f.reason}>{f.title}</li>)}</ul> : null}
                              <GateWarnings g={g} />
                              {g.profile?.length ? (
                                <>
                                  <p className="hint">{PAGE_TEXT.weakerThanTheDefaultWithoutHumanConfirmationThePerimeter}</p>
                                  <ProfileConfirm keys={g.profile} canConfirm={session?.role === "memory_admin"} label={PAGE_TEXT.confirmDeviationsValue1(g.flag)} />
                                </>
                              ) : null}
                            </>
                          )}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Section>

            {v.before ? (
              <Section title={PAGE_TEXT.pathToAdvancedBeforeEnabling} id="before" hint={PAGE_TEXT.everyCheckMustBeReadyTheGatewayRefusesTo}>
                <CheckTable checks={v.before} mode="advanced" label={PAGE_TEXT.beforeEnabling} />
              </Section>
            ) : null}

            {dry ? (
              <Section title={PAGE_TEXT.enablementDryRun} id="dry-run" fold={{ open: false, state: PAGE_TEXT.flagsValue1SystemKeysValue2(dry.flags.length, dry.system_keys.length) }}
                hint={PAGE_TEXT.whatWouldChangeIfYouEnabledItNowNothing}>
                <h3 className="sub-title">{PAGE_TEXT.flags}</h3>
                {!dry.flags.length ? <p className="hint">{PAGE_TEXT.allFlagsAreAlreadyStrict}</p> : (
                  <TableWrap><table className="board" aria-label={PAGE_TEXT.flags2}>
                    <thead><tr><th>{PAGE_TEXT.setting}</th><th>{PAGE_TEXT.now3}</th><th>{PAGE_TEXT.after}</th></tr></thead>
                    <tbody>{dry.flags.map((f) => <tr key={f.key}><td><code className="code">{f.key}</code></td><td>{valueText(f.before)}</td><td>{valueText(f.after)}</td></tr>)}</tbody>
                  </table></TableWrap>
                )}
                <h3 className="sub-title">{rich(PAGE_TEXT.systemKeysToRevokeValue1, null, { value1: dry.system_keys.length })}</h3>
                {dry.system_keys.length ? (
                  <TableWrap><table className="board" aria-label={PAGE_TEXT.systemKeys}>
                    <thead><tr><th>{PAGE_TEXT.key}</th><th>{PAGE_TEXT.lastUse}</th><th>{PAGE_TEXT.address}</th></tr></thead>
                    <tbody>{dry.system_keys.map((k) => <tr key={k.id}><td><code className="code">{k.prefix ?? k.id.slice(0, 8)}</code></td><td>{k.last_used_at ? <LocalTime iso={k.last_used_at} /> : PAGE_TEXT.neverUsed}</td><td>{k.last_ip ?? "—"}</td></tr>)}</tbody>
                  </table></TableWrap>
                ) : null}
                {would.unreadable
                  ? <Notice tone="warn">{rich(PAGE_TEXT.auditUnreadable, { strong: (children) => <strong>{children}</strong> })}</Notice>
                  : <p>{rich(PAGE_TEXT.actionsInTheLast30DaysThatWouldHave, { tag1: (children) => <strong>{children}</strong> }, { value2: would.count })}</p>}
                {dry.scripts.length ? (
                  <>
                    <h3 className="sub-title">{PAGE_TEXT.systemKeyCallersOver30Days}</h3>
                    <TableWrap><table className="board" aria-label={PAGE_TEXT.scripts}>
                      <thead><tr><th>{PAGE_TEXT.address2}</th><th>{PAGE_TEXT.client}</th><th>{PAGE_TEXT.calls}</th><th>{PAGE_TEXT.last}</th></tr></thead>
                      <tbody>{dry.scripts.map((x, i) => <tr key={`${x.ip}-${x.client}-${i}`}><td>{x.ip ?? "—"}</td><td>{x.client ?? "—"}</td><td>{x.calls}</td><td>{x.last_at ? <LocalTime iso={x.last_at} /> : "—"}</td></tr>)}</tbody>
                    </table></TableWrap>
                  </>
                ) : null}
                {dry.sessions.length ? <p>{rich(PAGE_TEXT.sessionsToCloseValue1, null, { value1: dry.sessions.map((x) => `${x.login} (${x.sessions})`).join(", ") })}</p> : null}
                {dry.profile.length ? (
                  <>
                    <p>{PAGE_TEXT.confirmSettingsDeviations}</p>
                    <ProfileConfirm keys={dry.profile.filter((p) => typeof p.digest === "string").map((p) => ({ ...p, digest: p.digest!, secret: false }))}
                      canConfirm={session?.role === "memory_admin"} label={PAGE_TEXT.confirmDeviationsFromDefaults} />
                  </>
                ) : null}
              </Section>
            ) : null}

            {v.mode === "basic" ? (
              <Section title={PAGE_TEXT.enableAdvanced} hint={PAGE_TEXT.inOneStepStrictSignInAndSignatureFlags}>
                {session?.role === "security_auditor" ? <p className="hint">{PAGE_TEXT.aMemoryAdministratorCanEnableAdvancedMode}</p>
                  : !canEnableAdvanced(v) ? <Notice tone="warn" role="status">{PAGE_TEXT.cannotEnableYetSomeBeforeEnablingChecksAreNot}</Notice> : (
                  <ActionForm action={enableAdvancedAction} submitLabel={PAGE_TEXT.enableAdvanced2} pendingLabel={PAGE_TEXT.enabling} danger
                    confirm={{ question: PAGE_TEXT.enableAdvancedMode, change: PAGE_TEXT.secondSignaturesSecurityKeySignInOnlyAndRevocation, undo: PAGE_TEXT.returningRequiresARequestSignedByASecondAdministrator, verb: PAGE_TEXT.enable, danger: true,
                               ack: { name: "ack", label: PAGE_TEXT.iUnderstandSystemKeysAndOtherSessionsWillStop } }}>
                    <Field label={PAGE_TEXT.reason} hint={PAGE_TEXT.optionalRecordedInTheModeHistory}>
                      <input name="reason" maxLength={500} />
                    </Field>
                    <label className="check ack-fallback">{rich(PAGE_TEXT.value1IUnderstandSystemKeysAndOtherSessionsWill, null, { value1: <input type="checkbox" name="ack" /> })}</label>
                  </ActionForm>
                )}
              </Section>
            ) : null}

            {v.completion ? (
              <Section title={v.mode === "advanced" ? PAGE_TEXT.completeAdvancedSetup : PAGE_TEXT.afterEnablingCompletion} id="completion"
                hint={PAGE_TEXT.afterEnablingInternalAnchorsWithAnAdvancedModeFloor}>
                <CheckTable checks={v.completion} mode="advanced" label={PAGE_TEXT.completion} />
              </Section>
            ) : null}
          </>
        );
      })()}
    </PageFrame>
  );
}
