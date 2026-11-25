import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { AdminTabs } from "@/components/admin-tabs";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw, type Result } from "@/lib/api";
import { authcheckStateText, CONFIRM_CONFIRM, confirmationState, disabledByText, disabledText, EXTERNAL_TABS, externalPause, LIFT_CONFIRM, PAUSE_CONFIRM, PERSON_OFF_CONFIRM, type AuthcheckStatusView, type ExternalConfirmation, type ExternalPerson } from "@/lib/external-access";
import { pickTab } from "@/lib/admin-tabs";
import { param, type SearchParams } from "@/lib/paging";
import { settingHref } from "@/lib/setting-labels";
import { confirmRequestAction, disablePersonAction, liftPauseAction, pauseAction } from "./actions";
import { PANEL_EXTERNAL_MESSAGES, STATES } from "@/messages/panel-external";
import { rich } from "@/i18n/rich";

export function generateMetadata(): Metadata { return { title: PANEL_EXTERNAL_MESSAGES.externalAccess }; }

const PAGE = 50;
export { STATES } from "@/messages/panel-external";

export default async function ExternalAdminPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const tab = pickTab(param(sp, "tab"), EXTERNAL_TABS, "people");
  let body;
  if (tab === "people") {
    const raw = param(sp, "state");
    const state = (raw === "off" || raw === "all" ? raw : "on") as keyof typeof STATES;
    const cursor = param(sp, "cursor");
    const res = await tryGw<{ items: ExternalPerson[]; next_cursor: string | null }>("/api/v1/admin/external/people",
      { query: { state, limit: String(PAGE), ...(cursor ? { cursor } : {}) } });
    body = <PeopleTab res={res} state={state} cursor={cursor} />;
  } else if (tab === "confirmations") {
    body = <ConfirmationsTab res={await tryGw<{ items: ExternalConfirmation[] }>("/api/v1/admin/external/confirmations")} />;
  } else {
    body = <LoginTab res={await tryGw<AuthcheckStatusView>("/api/v1/admin/external/status")} />;
  }
  return (
    <PageFrame title={PANEL_EXTERNAL_MESSAGES.externalAccess2} lead={PANEL_EXTERNAL_MESSAGES.colleaguesEnableAccessFromOutside}>
      <AdminTabs path="/admin/external" tabs={EXTERNAL_TABS} active={tab} fallback="people" label={PANEL_EXTERNAL_MESSAGES.externalAccessPageSections} />
      {body}
    </PageFrame>
  );
}

function PeopleTab({ res, state, cursor }: { res: Result<{ items: ExternalPerson[]; next_cursor: string | null }>; state: keyof typeof STATES; cursor: string }) {
  return (
    <Section title={PANEL_EXTERNAL_MESSAGES.colleagues} id="people" icon="users"
      actions={<span className="pager-links">{(Object.keys(STATES) as Array<keyof typeof STATES>).map((k) => k === state
        ? <b key={k}>{STATES[k]}</b> : <Link key={k} prefetch={false} href={`/admin/external?state=${k}`}>{STATES[k]}</Link>)}</span>}>
      {!res.ok ? <LoadError result={res} what={PANEL_EXTERNAL_MESSAGES.colleaguesWithExternalAccess} /> : !res.data.items.length ? <Empty icon="globe">{state === "on" ? PANEL_EXTERNAL_MESSAGES.noOneHasEnabledExternal : PANEL_EXTERNAL_MESSAGES.noOne}</Empty> : (
        <>
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{PANEL_EXTERNAL_MESSAGES.colleague}</th><th>{PANEL_EXTERNAL_MESSAGES.access}</th><th>{PANEL_EXTERNAL_MESSAGES.connections}</th><th>{PANEL_EXTERNAL_MESSAGES.directory}</th><th>{PANEL_EXTERNAL_MESSAGES.actions}</th></tr></thead>
              <tbody>
                {res.data.items.map((p) => (
                  <tr key={p.person_id}>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.colleague2}>{p.display_name}</td>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.access2}>
                      <Badge tone={p.enabled ? "ok" : "muted"}>{p.enabled ? PANEL_EXTERNAL_MESSAGES.enabled : PANEL_EXTERNAL_MESSAGES.disabled}</Badge>
                      {p.enabled && p.enabled_at ? <div className="cell-sub">{rich(PANEL_EXTERNAL_MESSAGES.since, null, { value1: <LocalTime iso={p.enabled_at} relative={false} /> })}</div> : null}
                      {!p.enabled && p.disabled_at ? <div className="cell-sub">{disabledText(p.disabled_code)} · {disabledByText(p.disabled_by)} · <LocalTime iso={p.disabled_at} /></div> : null}
                    </td>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.connections2}>
                      {p.connections_active}
                      {p.last_external_login_at ? <div className="cell-sub">{rich(PANEL_EXTERNAL_MESSAGES.externalSignIn, null, { value1: <LocalTime iso={p.last_external_login_at} /> })}</div> : null}
                    </td>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.directory2}>
                      {p.ad_checked_at ? <>{p.ad_ok ? PANEL_EXTERNAL_MESSAGES.ok : <Badge tone="warn">{PANEL_EXTERNAL_MESSAGES.checkFailed}</Badge>}<div className="cell-sub">{rich(PANEL_EXTERNAL_MESSAGES.checked, null, { value1: <LocalTime iso={p.ad_checked_at} /> })}</div></> : <span className="muted">{PANEL_EXTERNAL_MESSAGES.notCheckedYet}</span>}
                    </td>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.actions2}>
                      {p.enabled ? (
                        <ActionForm action={disablePersonAction} submitLabel={PANEL_EXTERNAL_MESSAGES.disable} pendingLabel="…" compact danger confirm={PERSON_OFF_CONFIRM(p.display_name)}>
                          <input type="hidden" name="person_id" value={p.person_id} />
                        </ActionForm>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <CursorPager path="/admin/external" params={{ state }} cursorName="cursor" cursor={cursor} nextCursor={res.data.next_cursor} prevCursor={null}
            shown={res.data.items.length} noun={PANEL_EXTERNAL_MESSAGES.colleagues2} />
        </>
      )}
    </Section>
  );
}

function ConfirmationsTab({ res }: { res: Result<{ items: ExternalConfirmation[] }> }) {
  return (
    <Section title={PANEL_EXTERNAL_MESSAGES.firstTimeAccessConfirmations} id="confirmations" icon="id-card"
      hint={PANEL_EXTERNAL_MESSAGES.firstTimeAccessRequiresThe}>
      {!res.ok ? <LoadError result={res} what={PANEL_EXTERNAL_MESSAGES.requests} /> : !res.data.items.length ? <Empty icon="id-card">{PANEL_EXTERNAL_MESSAGES.noRequests}</Empty> : (
        <TableWrap cards>
          <table className="board">
            <thead><tr><th>{PANEL_EXTERNAL_MESSAGES.colleague3}</th><th>{PANEL_EXTERNAL_MESSAGES.request}</th><th>{PANEL_EXTERNAL_MESSAGES.status}</th><th>{PANEL_EXTERNAL_MESSAGES.actions3}</th></tr></thead>
            <tbody>
              {res.data.items.map((c) => {
                const st = confirmationState(c);
                return (
                  <tr key={c.id}>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.colleague4}>{c.display_name}</td>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.request2}><LocalTime iso={c.requested_at} />{c.requested_network ? <div className="cell-sub">{rich(PANEL_EXTERNAL_MESSAGES.fromNetwork, null, { value1: c.requested_network })}</div> : null}</td>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.status2}><Badge tone={st.tone}>{st.title}</Badge>
                      {c.confirmed_by ? <div className="cell-sub">{disabledByText(c.confirmed_by)}{c.expires_at && !c.used_at ? <>{rich(PANEL_EXTERNAL_MESSAGES.until, null, { value1: <LocalTime iso={c.expires_at} relative={false} /> })}</> : null}</div> : null}
                    </td>
                    <td data-label={PANEL_EXTERNAL_MESSAGES.actions4}>
                      {st.canConfirm ? (
                        <ActionForm action={confirmRequestAction} submitLabel={PANEL_EXTERNAL_MESSAGES.confirm} pendingLabel="…" compact confirm={CONFIRM_CONFIRM(c.display_name)}>
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
      )}
    </Section>
  );
}

function LoginTab({ res }: { res: Result<AuthcheckStatusView> }) {
  const v = res.ok ? authcheckStateText(res.data) : null;
  const pause = externalPause(res.ok ? res.data.status?.pause_until ?? null : null);
  return (
    <>
      <Section title={PANEL_EXTERNAL_MESSAGES.signInCheckService} id="service" icon="shield" actions={v ? <Badge tone={v.tone}>{v.title}</Badge> : null}
        hint={PANEL_EXTERNAL_MESSAGES.anInternalServiceThatChecks}>
        {!res.ok ? <LoadError result={res} what={PANEL_EXTERNAL_MESSAGES.signInCheckServiceStatus} /> : (
          <>
            {v!.lines.map((l) => <p key={l}>{l}</p>)}
            {res.data.status?.last_sweep_at ? <p className="hint">{rich(PANEL_EXTERNAL_MESSAGES.lastDirectoryCheck, null, { value1: <LocalTime iso={res.data.status.last_sweep_at} /> })}</p> : null}
            <p className="hint">{rich(PANEL_EXTERNAL_MESSAGES.externalSignInItselfIs, null, { value1: <Link href={settingHref("edge", "login_enabled")} prefetch={false}>{PANEL_EXTERNAL_MESSAGES.externalAccessSettings}</Link> })}</p>
          </>
        )}
      </Section>
      <Section title={PANEL_EXTERNAL_MESSAGES.pauseExternalSignIn} id="pause" icon="clock"
        hint={PANEL_EXTERNAL_MESSAGES.newExternalSignInsAre2}>
        {!pause ? <p>{PANEL_EXTERNAL_MESSAGES.noPauseIsActive}</p> : pause.forever ? <Notice tone="warn">{pause.text}</Notice>
          : <Notice tone="warn">{rich(PANEL_EXTERNAL_MESSAGES.externalSignInPausedUntil, null, { value1: <LocalTime iso={pause.until} relative={false} /> })}</Notice>}
        <ActionForm action={pauseAction} submitLabel={PANEL_EXTERNAL_MESSAGES.pause} pendingLabel="…" confirm={PAUSE_CONFIRM}>
          <label className="field" htmlFor="pause-minutes">
            <span className="field-label">{PANEL_EXTERNAL_MESSAGES.numberOfMinutes}</span>
            <input id="pause-minutes" name="minutes" type="number" min={1} max={1440} defaultValue={60} required />
          </label>
        </ActionForm>
        <ActionForm action={liftPauseAction} submitLabel={PANEL_EXTERNAL_MESSAGES.liftManualPause} pendingLabel="…" quiet confirm={LIFT_CONFIRM}>{null}</ActionForm>
      </Section>
    </>
  );
}
