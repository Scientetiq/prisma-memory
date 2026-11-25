import { shipText } from "@/messages/panel-audit-ship";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, LoadError, Notice, Section } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { readSession } from "@/lib/session";
import { reconcileAction } from "./actions";
import { AUDIT_SHIP_TEXT, lagText, MODE_TITLES, shipErrorText, shipState, type AuditShipStatus } from "./view";

export function generateMetadata(): Metadata { return { title: shipText.auditExport }; }

export default async function AuditShipPage() {
  await guardAuditorPage(true);
  const [res, session] = await Promise.all([tryGw<AuditShipStatus>("/api/v1/admin/audit-ship"), readSession()]);
  const auditor = session?.role === "security_auditor";
  return (
    <PageFrame title={shipText.auditExport2} lead={AUDIT_SHIP_TEXT.lead} allowAuditor>
      {!res.ok ? <LoadError result={res} what={shipText.auditExportStatus} /> : (() => {
        const s = res.data, st = shipState(s);
        return (
          <>
            <Section title={shipText.export}>
              <dl className="kv">
                <dt>{shipText.mode}</dt><dd>{MODE_TITLES[s.mode] ?? s.mode} <Badge tone={st.tone}>{st.title}</Badge></dd>
                {s.mode !== "off" ? (
                  <>
                    <dt>{shipText.lag}</dt><dd>{lagText(s.lag_sec)}</dd>
                    <dt>{shipText.lastSuccessfulRun}</dt><dd>{s.last_ok_at ? <LocalTime iso={s.last_ok_at} /> : shipText.noneYet}</dd>
                    {s.last_error_code ? (
                      <><dt>{shipText.error}</dt><dd>{shipErrorText(s.last_error_code)}{s.last_error_at ? <>{rich(shipText.since, null, { value1: (<LocalTime iso={s.last_error_at} relative={false} />) })}</> : null}</dd></>
                    ) : null}
                  </>
                ) : null}
              </dl>
              {s.mode === "off" ? <Notice tone="info" role="status">{shipText.auditExportIsOffEnableObservabilityAudit}</Notice> : null}
              {s.last_error_code ? <Notice tone="warn" role="status">{shipText.whileExportIsUnavailableEventsStayIn}</Notice> : null}
            </Section>
            {s.mode !== "off" ? (
              <Section title={shipText.dailyReconciliation} hint={shipText.onceADayExportedEventsAreChecked}>
                <dl className="kv">
                  <dt>{shipText.lastReconciledDay}</dt><dd>{s.reconciled_day ?? shipText.notReconciledYet}</dd>
                  {s.reconciled_day ? <><dt>{shipText.result}</dt><dd>{s.mismatch ? <Badge tone="danger">{shipText.mismatchMissingEventsResent}</Badge> : <Badge tone="ok">{shipText.matched}</Badge>}</dd></> : null}
                </dl>
                {auditor ? <p className="hint">{shipText.aMemoryAdministratorCanRunReconciliationOutside}</p> : (
                  <ActionForm action={reconcileAction} submitLabel={shipText.reconcileNow} pendingLabel={shipText.queuing} quiet>{null}</ActionForm>
                )}
              </Section>
            ) : null}
          </>
        );
      })()}
    </PageFrame>
  );
}
