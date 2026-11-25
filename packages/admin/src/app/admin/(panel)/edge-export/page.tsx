import { rich } from "@/i18n/rich";
import { TEXT } from "@/messages/panel-edge-export";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { AdminTabs } from "@/components/admin-tabs";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, Empty, LoadError, Notice, Section } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { EDGE_EXPORT_TABS, pickTab } from "@/lib/admin-tabs";
import { tryGw, type Result } from "@/lib/api";
import { EDGE_STATUS_TEXT, CANARY_HOLD_RELEASE_CONFIRM, CANARY_HOLDS_RELEASE_ALL_CONFIRM, edgeExportView, type CanaryHold, type EdgeExportStatus } from "@/lib/edge-status";
import { param, type SearchParams } from "@/lib/paging";
import { settingHref } from "@/lib/setting-labels";
import { exportOffAction, recreateCanariesAction, releaseAllCanaryHoldsAction, releaseCanaryHoldAction, unkillAction } from "./actions";

export function generateMetadata(): Metadata { return { title: TEXT.edgeExport }; }

export default async function EdgeExportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const tab = pickTab(param(sp, "tab"), EDGE_EXPORT_TABS, "export");
  const res = await tryGw<EdgeExportStatus>("/api/v1/admin/edge-export/status");
  const holds = tab === "canaries" ? await tryGw<{ items: CanaryHold[] }>("/api/v1/admin/edge-export/canary-holds") : null;
  return (
    <PageFrame title={TEXT.edgeExport} lead={TEXT.theEdgeIsAReadOnlyExternalCopy}>
      <AdminTabs path="/admin/edge-export" tabs={EDGE_EXPORT_TABS} active={tab} fallback="export" label={TEXT.edgeExportSections}
        counts={res.ok && res.data.killed_at ? { canaries: { n: 1, tone: "danger" } } : {}} />
      {!res.ok ? <LoadError result={res} what={TEXT.exportStatus} /> : tab === "export" ? <ExportTab s={res.data} /> : <CanariesTab s={res.data} holds={holds} />}
    </PageFrame>
  );
}

function ExportTab({ s }: { s: EdgeExportStatus }) {
  const v = edgeExportView(s);
  const { killed, reconcile } = v;
  return (
    <>
      <Section title={TEXT.sendingToTheEdge} id="export" icon="globe" actions={<Badge tone={v.tone}>{v.state}</Badge>}>
        {killed ? <Notice tone="danger">{rich(TEXT.exportShutDownAutomaticallySeeCanariesAndAutomatic, { v0: () => (killed.why) })}</Notice> : null}
        <p>{TEXT.statusSentence(v.freshness)}</p>
        <p className="hint">{rich(TEXT.enableItInUsingAnAdministratorSPersonal, { v0: () => (<Link href={settingHref("edge", "export_enabled")} prefetch={false}>{TEXT.externalAccessSettings}</Link>) })}</p>
        {s.export_enabled ? (
          <ActionForm action={exportOffAction} submitLabel={TEXT.turnOffExport} pendingLabel={TEXT.turningOff} danger confirm={EDGE_STATUS_TEXT.exportOffConfirm}>{null}</ActionForm>
        ) : null}
      </Section>
      <Section title={TEXT.queues} id="queues" icon="inbox" hint={TEXT.revocationRemovesClosedHiddenOrDeletedRecordsFrom}>
        <p>{TEXT.statusSentence(v.queues)}</p>
        {s.last_full_sync_at ? <p className="hint">{rich(TEXT.lastFullExportOfAllOpenRecords, { v0: () => (<LocalTime iso={s.last_full_sync_at} />) })}</p> : <p className="hint">{TEXT.noFullExportHasRunYet}</p>}
      </Section>
      <Section title={TEXT.reconciliation} id="reconcile" icon="refresh" hint={TEXT.aSeparateServiceComparesTheEdgeContentsWith}>
        {reconcile ? (
          <p>{rich(TEXT.lastReconciliationExtraRecordsMissingRecords, { v0: () => (<LocalTime iso={reconcile.at} />), v1: () => (reconcile.extra), v2: () => (reconcile.missing) })}</p>
        ) : <Empty>{TEXT.noReconciliationHasRunYet}</Empty>}
      </Section>
      <Section title={TEXT.exportServices} id="services" icon="server">
        {v.services.length ? (
          <ul className="plain-list">
            {v.services.map((x) => <li key={x.title}>{rich(TEXT.serviceStatus(x.title), {
              state: () => x.fresh ? <Badge tone="ok">{TEXT.running}</Badge> : <Badge tone="warn">{TEXT.noRecentResponse}</Badge>,
              heartbeat: () => <span className="muted small">{rich(TEXT.lastHeartbeat, { v0: () => (<LocalTime iso={x.at} />) })}</span>,
            })}</li>)}
          </ul>
        ) : <Empty>{TEXT.exportServicesHaveNotStartedYet}</Empty>}
      </Section>
    </>
  );
}

function CanariesTab({ s, holds }: { s: EdgeExportStatus; holds: Result<{ items: CanaryHold[] }> | null }) {
  const v = edgeExportView(s);
  const { killed } = v;
  const found = holds?.ok && Array.isArray(holds.data?.items) ? holds.data.items : [];
  return (
    <>
      <Section title={TEXT.canaryRecords} id="canaries" icon="shield" actions={<Badge tone={v.canaryTone}>{v.canary}</Badge>}
        hint={TEXT.canariesAreServiceRecordsInClosedAndHidden}>
        <p>{rich(TEXT.canariesInPlace, { v0: () => (v.canaries), v1: () => (s.canary_checked_at ? <>{rich(TEXT.lastCheck, { v0: () => (<LocalTime iso={s.canary_checked_at} />) })}</> : null) })}</p>
        <ActionForm action={recreateCanariesAction} submitLabel={TEXT.recreateCanaries} pendingLabel={TEXT.sending} quiet confirm={EDGE_STATUS_TEXT.canariesConfirm}>{null}</ActionForm>
      </Section>
      <Section title={TEXT.automaticShutdown} id="kill" icon="alert">
        {killed ? (
          <>
            <Notice tone="danger">{rich(TEXT.exportShutDownAutomaticallyAtTheEdgeReceives, { v0: () => (<LocalTime iso={killed.at} />), v1: () => (killed.why) })}</Notice>
            <ActionForm action={unkillAction} submitLabel={TEXT.clearAutomaticShutdown} pendingLabel={TEXT.sending} danger
              confirm={TEXT.clearTheAutomaticShutdownInvestigateTheCauseFirst}>
              <input type="hidden" name="killed_at" value={s.killed_at ?? ""} />
              <label className="field field-wide" htmlFor="unkill-reason">
                <span className="field-label">{TEXT.reasonForClearing}</span>
                <textarea id="unkill-reason" name="reason" rows={3} maxLength={500} required />
                <span className="field-hint">{EDGE_STATUS_TEXT.unkillHint}</span>
              </label>
            </ActionForm>
          </>
        ) : <p className="hint">{TEXT.notTriggeredExportFollowsItsSettings}</p>}
      </Section>
      <Section title={TEXT.canaryFindingsOnTheEdge} id="holds" icon="alert"
        hint={TEXT.recordsInWhichReconciliationFoundACanaryMarker}>
        {!holds ? null : !holds.ok ? <LoadError result={holds} what={TEXT.canaryFindings} /> : !found.length ? <Empty>{TEXT.noFindings}</Empty> : (
          <>
            <ul className="plain-list">
              {found.map((h) => (
                <li key={h.record_id}>
                  <code>{h.record_id}</code> <span className="muted small">{rich(TEXT.foundAt, { v0: () => (<LocalTime iso={h.created_at} />) })}</span>
                  <ActionForm action={releaseCanaryHoldAction} submitLabel={TEXT.release} pendingLabel={TEXT.pending} compact quiet confirm={CANARY_HOLD_RELEASE_CONFIRM}>
                    <input type="hidden" name="record_id" value={h.record_id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
            {found.length > 1 ? (
              <ActionForm action={releaseAllCanaryHoldsAction} submitLabel={TEXT.releaseAllFindings} pendingLabel={TEXT.releasing} danger confirm={CANARY_HOLDS_RELEASE_ALL_CONFIRM}>{null}</ActionForm>
            ) : null}
          </>
        )}
      </Section>
    </>
  );
}
