import { rich } from "../../../i18n/rich";
import { TEXT } from "../../../messages/panel-home";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { Badge, Empty, LoadError, Section, TableWrap } from "@/components/ui";
import { tryGw } from "@/lib/api";
import { attentionItems } from "@/lib/attention";
import { loadAttentionExtras } from "@/lib/attention-load";
import { AttentionList } from "@/components/attention-list";
import { CHECK_LINKS, checkState, enabledFlags, formatDetailTimes, instanceTz, offText, versionText } from "@/lib/checks";
import { formatShare } from "@/lib/format";
import { getHealth } from "@/lib/gateway";
import { CHECK_TITLES, RECORD_TYPE_TITLES } from "@/lib/labels";
import { readSession } from "@/lib/session";
import { STAGE_STATUS_TITLES, STAGE_TITLES } from "@/lib/stages";
import type { Report, SettingsResponse, UnprocessedResponse } from "@/lib/types";

export function generateMetadata(): Metadata { return { title: TEXT.overview }; }

const QUEUE_STATES = ["pending", "running", "failed"] as const;

export default async function OverviewPage() {
  await guardAuditorPage();
  const session = await readSession();
  const [health, unprocessed, report, settings, extras] = await Promise.all([
    getHealth(session?.token),
    tryGw<UnprocessedResponse>("/api/v1/admin/unprocessed", { query: { limit: 1 } }),
    tryGw<Report>("/api/v1/admin/report", { query: { hours: 24 } }),
    tryGw<SettingsResponse>("/api/v1/admin/settings"),
    loadAttentionExtras(),
  ]);

  const checks = health.reachable ? Object.entries(health.checks ?? {}) : [];
  const flags = enabledFlags(settings.ok ? settings.data : null);
  const counts = unprocessed.ok ? Object.entries(unprocessed.data.counts) : [];
  const byStage = new Map<string, Record<string, number>>();
  for (const [key, n] of counts) {
    const [stage, st] = key.split(":");
    const row = byStage.get(stage ?? "") ?? {};
    row[st ?? ""] = (row[st ?? ""] ?? 0) + n;
    byStage.set(stage ?? "", row);
  }
  const queued = counts.filter(([k]) => k.endsWith(":pending") || k.endsWith(":running")).reduce((a, [, n]) => a + n, 0);
  const failed = counts.filter(([k]) => k.endsWith(":failed")).reduce((a, [, n]) => a + n, 0);
  const missing = settings.ok ? settings.data.missing_required : [];
  const tz = instanceTz(settings.ok ? settings.data : null);
  const total = report.ok ? Object.values(report.data.by_type).reduce((a, t) => a + t.accepted, 0) : null;
  const attention = attentionItems({ checks: health.reachable ? health.checks : null, flags, missing, ...extras, report: report.ok ? report.data : null, tz });
  const gatewayTile = !health.reachable ? { text: TEXT.unreachable, tone: "bad" } : health.status === "ok" ? { text: TEXT.healthy, tone: "good" }
    : health.status === "degraded" ? { text: TEXT.restricted, tone: "warn" } : { text: TEXT.notResponding, tone: "bad" };

  return (
    <PageFrame title={TEXT.overview2} banner="critical" lead={TEXT.instanceStatusAtAGlanceGatewayChecks}>
      <div className="stat-tiles">
        <div className="stat-tile"><div className={`v text ${gatewayTile.tone}`}>{gatewayTile.text}</div><div className="k">{TEXT.gateway}</div></div>
        <div className="stat-tile"><Link href="/admin/unprocessed?status=pending,running#items" prefetch={false}><div className={`v ${queued ? "warn" : ""}`}>{unprocessed.ok ? queued : "—"}</div><div className="k">{TEXT.queuedStages}</div></Link></div>
        <div className="stat-tile"><Link href="/admin/unprocessed?status=failed#items" prefetch={false}><div className={`v ${failed ? "bad" : ""}`}>{unprocessed.ok ? failed : "—"}</div><div className="k">{TEXT.failedStages}</div></Link></div>
        <div className="stat-tile"><div className="v">{total ?? "—"}</div><div className="k">{TEXT.receivedInTheLastHours}</div></div>
        <div className="stat-tile"><div className="v">{report.ok ? formatShare(report.data.processed_share) : "—"}</div><div className="k">{TEXT.processedShare}</div></div>
      </div>

      {attention.length ? (
        <Section title={TEXT.needsAttention}>
          <AttentionList items={attention} />
        </Section>
      ) : null}

      <div className="overview-grid">
        <Section title={TEXT.gatewayChecks} hint={health.reachable ? TEXT.text(versionText(health.version), health.instance ? TEXT.instance(health.instance) : "") : undefined}>
          {!health.reachable ? <div className="notice danger" role="alert">{health.message}</div> : !checks.length ? <Empty>{TEXT.theGatewayDidNotReturnTheList}</Empty> : (
            <ul className="checks-list">
              {checks.map(([k, c]) => {
                const state = checkState(k, c, flags), link = CHECK_LINKS[k], title = CHECK_TITLES[k] ?? k;
                return (
                  <li key={k} className={state}>
                    <Icon name={state === "ok" ? "check" : state === "off" ? "minus" : "x"} />
                    <span>
                      <b>{link ? <Link href={link.href} prefetch={false}>{title}</Link> : title}</b>
                      {state === "fail" ? <span className="danger-text">{TEXT.failedSeeNeedsAttention}</span>
                        : state === "off" ? <span className="muted"> — {offText(c.detail ? formatDetailTimes(c.detail, tz) : "")}</span>
                        : c.detail ? <span className="muted"> — {formatDetailTimes(c.detail, tz)}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title={TEXT.queueByStage} hint={TEXT.stagesThatAreWaitingRunningOrHave}>
          {!unprocessed.ok ? <LoadError result={unprocessed} what={TEXT.queue} /> : !byStage.size ? <Empty>{TEXT.theQueueIsEmptyAllStagesAre}</Empty> : (
            <>
              <TableWrap>
                <table className="board stage-queue">
                  <thead><tr><th>{TEXT.stage}</th>{QUEUE_STATES.map((k) => <th key={k} className="num">{STAGE_STATUS_TITLES[k]}</th>)}</tr></thead>
                  <tbody>
                    {[...byStage.entries()].map(([stage, row]) => (
                      <tr key={stage}>
                        <td><Link href={`/admin/unprocessed?stage=${encodeURIComponent(stage)}#items`} prefetch={false} title={stage}>{STAGE_TITLES[stage] ?? stage}</Link></td>
                        <td className="num">{row.pending ?? 0}</td>
                        <td className="num">{row.running ?? 0}</td>
                        <td className="num">{row.failed ? <span className="danger-text">{row.failed}</span> : 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <p className="hint stage-legend">{rich(TEXT.stageStates, null, { value1: QUEUE_STATES.map((k) => <span key={k}><Badge tone="muted">{STAGE_STATUS_TITLES[k]}</Badge>{" "}</span>) })}</p>
            </>
          )}
          <p className="foot-link"><Link href="/admin/unprocessed" prefetch={false}>{TEXT.processing}</Link></p>
        </Section>
      </div>

      <Section title={TEXT.lastHours} hint={report.ok && report.data.generated_at ? <>{rich(TEXT.generated, null, { value1: <LocalTime iso={report.data.generated_at} /> })}</> : undefined}>
        {!report.ok ? <LoadError result={report} what={TEXT.report} /> : !Object.keys(report.data.by_type).length ? <Empty>{TEXT.noRecordsReceivedInTheLastHours}</Empty> : (
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{TEXT.type2}</th><th className="num">{TEXT.received2}</th><th className="num">{TEXT.processed2}</th><th className="num">{TEXT.failed2}</th><th className="num">{TEXT.queued2}</th></tr></thead>
              <tbody>
                {Object.entries(report.data.by_type).sort(([a], [b]) => a.localeCompare(b)).map(([type, t]) => (
                  <tr key={type}>
                    <td data-label={TEXT.type}>{RECORD_TYPE_TITLES[type] ?? type}</td>
                    <td className="num" data-label={TEXT.received}>{t.accepted}</td>
                    <td className="num" data-label={TEXT.processed}>{t.processed}</td>
                    <td className="num" data-label={TEXT.failed}>{t.failed ? <span className="danger-text">{t.failed}</span> : 0}</td>
                    <td className="num" data-label={TEXT.queued}>{t.queued}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="foot-link"><Link href="/admin/report" prefetch={false}>{TEXT.reportsForOtherPeriods}</Link></p>
      </Section>
    </PageFrame>
  );
}

