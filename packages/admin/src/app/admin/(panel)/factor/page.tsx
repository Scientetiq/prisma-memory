import { PAGE_TEXT } from "../../../../messages/panel-factor";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, Empty, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw, type Result } from "@/lib/api";
import { param, type SearchParams } from "@/lib/paging";
import { readSession } from "@/lib/session";
import { settingHref } from "@/lib/setting-labels";
import type { Page, Person } from "@/lib/types";
import { readAdminView } from "@/lib/view-as";
import { ResetForm } from "./reset-form";
import { coverageLine, MODE_TITLE, MODE_TONE, requiredWarning, RESET_MODE_TEXT, type FactorOverview, VIEW_TEXT } from "./view";

export function generateMetadata(): Metadata { return { title: VIEW_TEXT.factorPanelTitle }; }

const SEARCH_LIMIT = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FactorAdminPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(true);
  const sp = await searchParams;
  const [session, view] = await Promise.all([readSession().catch(() => null), readAdminView()]);
  const canReset = session?.role !== "security_auditor" && view !== "auditor";
  const q = param(sp, "q").slice(0, 100);
  const picked = param(sp, "person");
  const [res, mode, found] = await Promise.all([
    tryGw<FactorOverview>("/api/v1/admin/factor/overview"),
    tryGw<{ mode: "basic" | "advanced" }>("/api/v1/admin/security-mode"),
    canReset && q.length >= 2 ? tryGw<Page<Person>>("/api/v1/admin/people", { query: { q, limit: SEARCH_LIMIT, active: "true" } }) : null,
  ]);
  return (
    <PageFrame title={VIEW_TEXT.factorPanelTitle} allowAuditor lead={VIEW_TEXT.factorPanelLead}>
      {!res.ok ? <LoadError result={res} what={PAGE_TEXT.secondFactorStatus} /> : <ModeSection o={res.data} />}
      {canReset ? (
        <Section title={PAGE_TEXT.resetAColleagueSFactor} id="reset" icon="refresh" hint={VIEW_TEXT.resetHint}>
          {mode.ok && (mode.data.mode === "basic" || mode.data.mode === "advanced") ? <p className="hint">{RESET_MODE_TEXT[mode.data.mode]}</p> : null}
          <form method="get" action="/admin/factor#reset" className="form inline-form">
            <input name="q" defaultValue={q} placeholder={PAGE_TEXT.colleagueLoginOrName} aria-label={PAGE_TEXT.findAColleague} minLength={2} maxLength={100} />
            <button type="submit" className="btn">{PAGE_TEXT.find}</button>
          </form>
          {found ? <SearchResults res={found} q={q} picked={UUID_RE.test(picked) ? picked.toLowerCase() : ""} /> : null}
        </Section>
      ) : null}
    </PageFrame>
  );
}

function ModeSection({ o }: { o: FactorOverview }) {
  const warn = requiredWarning(o);
  return (
    <Section title={PAGE_TEXT.mode} id="mode" icon="shield"
      actions={<Link prefetch={false} href={settingHref("edge", "mfa_mode")}>{PAGE_TEXT.changeInSettings}</Link>}>
      {!o.installed ? <Notice tone="info">{rich(PAGE_TEXT.theSecondFactorIsNotInstalledInTheDatabase, null, { value1: MODE_TITLE[o.mode] })}</Notice> : null}
      <p>
        <Badge tone={MODE_TONE[o.mode]}>{MODE_TITLE[o.mode]}</Badge>{" "}
        {o.mode === "required" && o.required_since ? <>{rich(PAGE_TEXT.requiredSinceValue1, null, { value1: <LocalTime iso={o.required_since} relative={false} /> })}</>
          : o.setting_updated_at ? <>{rich(PAGE_TEXT.settingChangedValue1, null, { value1: <LocalTime iso={o.setting_updated_at} /> })}</> : <>{PAGE_TEXT.settingHasNotChanged}</>}
      </p>
      {o.floor !== "off" ? (
        <p>{rich(PAGE_TEXT.minimumModeFromEdgeAnchorsValue1Value2, null, { value1: MODE_TITLE[o.floor], value2: o.setting !== o.mode ? <>{rich(PAGE_TEXT.itIsStricterThanTheSettingValue1SoIt, null, { value1: MODE_TITLE[o.setting] })}</> : null })}</p>
      ) : <p className="hint">{PAGE_TEXT.noMinimumModeFromEdgeAnchors}</p>}
      {o.mode === "required" && o.grace_until ? <p>{rich(PAGE_TEXT.existingApplicationConnectionsIssuedWithoutAFactorHaveA, null, { value1: <LocalTime iso={o.grace_until} relative={false} />, value2: o.grace_connections ? <>{rich(PAGE_TEXT.currentlyValue1, null, { value1: o.grace_connections })}</> : null })}</p> : null}
      <p>{coverageLine(o.coverage)}</p>
      {warn ? <Notice tone="warn">{warn}</Notice> : null}
    </Section>
  );
}

function SearchResults({ res, q, picked }: { res: Result<Page<Person>>; q: string; picked: string }) {
  if (!res.ok) return <LoadError result={res} what={PAGE_TEXT.colleagues} />;
  if (!res.data.items.length) return <Empty icon="users">{PAGE_TEXT.noColleaguesFound}</Empty>;
  const sel = res.data.items.find((p) => p.id.toLowerCase() === picked);
  return (
    <>
      <TableWrap cards>
        <table className="board">
          <thead><tr><th>{PAGE_TEXT.colleague}</th><th>{PAGE_TEXT.login}</th><th>{PAGE_TEXT.actions}</th></tr></thead>
          <tbody>
            {res.data.items.map((p) => (
              <tr key={p.id}>
                <td data-label={PAGE_TEXT.colleague2}>{p.display_name}{p.department ? <div className="cell-sub">{p.department}</div> : null}</td>
                <td data-label={PAGE_TEXT.login2}><code className="code">{p.login}</code></td>
                <td data-label={PAGE_TEXT.actions2}>
                  {sel?.id === p.id ? <b>{PAGE_TEXT.selected}</b>
                    : <Link prefetch={false} href={`/admin/factor?q=${encodeURIComponent(q)}&person=${encodeURIComponent(p.id)}#reset-form`}>{PAGE_TEXT.select}</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {res.data.next_cursor ? <p className="hint">{rich(PAGE_TEXT.showingTheFirstValue1ResultsRefineYourSearch, null, { value1: SEARCH_LIMIT })}</p> : null}
      {sel ? (
        <div id="reset-form">
          <h3>{sel.display_name}</h3>
          <ResetForm personId={sel.id} name={sel.display_name} />
        </div>
      ) : null}
    </>
  );
}
