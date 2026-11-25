import { unprocessedPage as msg } from "@/messages/panel-unprocessed";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { mailBreak } from "@/components/mail-break";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { CursorPager } from "@/components/pager";
import { ActionForm } from "@/components/action-form";
import { AdminTabs } from "@/components/admin-tabs";
import { Badge, Code, Empty, Field, LoadError, Section, TableWrap, type Tone } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { pickTab, UNPROCESSED_TABS } from "@/lib/admin-tabs";
import { tryGw } from "@/lib/api";
import { shortId, truncate } from "@/lib/format";
import { MOVE_VIA_TITLES, RECORD_TYPE_TITLES, STAGE_STATUS_TITLES } from "@/lib/labels";
import { multiParam, offsetOf, PAGE_SIZE, param, type SearchParams } from "@/lib/paging";
import { formatCount } from "@/lib/plain";
import { despiteRefused } from "@/lib/show-anyway";
import { onlyTerminal, reasonHref, stageErrorInfo, stageErrorTitle } from "@/lib/stage-errors";
import { converterWaitLine, errorsLine, isConverterWait, isTooSlow, isWaitingModel, STAGE_TITLES, stageErrors, STAGES_TEXT, waitingLine } from "@/lib/stages";
import { LlmStateBlock } from "@/components/llm-state-block";
import { ConverterBlock } from "@/components/converter-block";
import { waitingConverterRows } from "@/lib/converter-state";
import { retryWhen } from "@/lib/meeting-state";
import { TzField } from "@/components/tz-field";
import type { ClassMove, ConverterState, LlmGateState, Page, SettingsResponse, UnprocessedResponse } from "@/lib/types";
import { checkConverterNowAction, clearHoldsAction, holdConverterAction, probeConverterAction, probeNowAction, reconcileAction, resumeConverterAction, retryFailedAction, retryMoveAction,
         retryRecordAction } from "./actions";

export function generateMetadata(): Metadata { return { title: msg.processing }; }

const STATUSES = ["pending", "running", "failed"] as const;
const STATUS_TONES: Record<string, Tone> = { pending: "neutral", running: "info", failed: "danger", done: "ok", skipped: "muted" };
const RETRY_STAGES = ["converted", "indexed", "summary", "events", "entities", "described"];
const FILTER_STAGES = [...RETRY_STAGES, "moved"];

export default async function UnprocessedPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const tab = pickTab(param(sp, "tab"), UNPROCESSED_TABS, "records");
  const statuses = multiParam(sp, "status", STATUSES);
  const askedClass = param(sp, "class"), cursor = param(sp, "cursor");
  const cls = askedClass === "open" || askedClass === "closed" ? askedClass : "";
  const askedStage = param(sp, "stage");
  const stage = FILTER_STAGES.includes(askedStage) ? askedStage : "";
  const owner = param(sp, "owner").trim().toLowerCase().slice(0, 254), space = param(sp, "space").trim().toLowerCase().slice(0, 63);
  const errorContains = param(sp, "error").trim().slice(0, 200);
  const askedCode = param(sp, "error_code").trim();
  const errorCode = /^[^:\s]{1,60}$/.test(askedCode) ? askedCode : "";
  const askedTerminal = param(sp, "terminal");
  const terminal = askedTerminal === "true" || askedTerminal === "false" ? askedTerminal : "";
  const status = statuses.join(",");
  const params = { tab: tab === "records" ? "" : tab, status, class: cls, stage, owner, space, error: errorContains, error_code: errorCode, terminal, cursor };
  const offset = offsetOf(cursor);
  const filtered = !!(status || cls || stage || owner || space || errorContains || errorCode || terminal);

  const [res, moves, gate, settings, converter] = await Promise.all([
    tryGw<UnprocessedResponse>("/api/v1/admin/unprocessed", { query: { status, class: cls, stage, owner, space, error_contains: errorContains, error_code: errorCode, terminal,
                                                                        limit: PAGE_SIZE, cursor: cursor || undefined } }),
    tab === "moves" ? tryGw<Page<ClassMove> & { total?: number | null }>("/api/v1/admin/class-moves", { query: { status: "failed,pending,copying,verifying", latest: "true", limit: 50 } }) : null,
    tryGw<LlmGateState>("/api/v1/admin/llm-gate"),
    tryGw<SettingsResponse>("/api/v1/admin/settings"),
    tryGw<ConverterState>("/api/v1/admin/converter"),
  ]);
  const retriesLimit = Number((settings.ok ? settings.data.items.find((i) => i.category === "processing" && i.key === "retries")?.value as { limit?: number } | undefined : undefined)?.limit ?? 3);
  const waitingTotal = gate.ok ? gate.data.waiting.waiting_model + gate.data.waiting.too_slow : 0;
  const now = new Date();
  const lastMoves = moves?.ok ? moves.data.items : [];
  const movesTotal = moves?.ok ? moves.data.total ?? lastMoves.length : 0;
  const counts = res.ok ? Object.entries(res.data.counts).sort(([a], [b]) => a.localeCompare(b)) : [];
  const items = res.ok ? res.data.items : [];
  const reasons = res.ok ? res.data.reasons ?? [] : [];
  const tooSlowTotal = gate.ok ? gate.data.waiting.too_slow : 0;
  const terminalTotal = res.ok ? res.data.failed_terminal ?? 0 : 0;
  const failedTotal = Math.max(0, counts.filter(([k]) => k.endsWith(":failed")).reduce((a, [, n]) => a + n, 0) - tooSlowTotal - terminalTotal);
  const convWaiting = res.ok ? res.data.waiting_converter : undefined;
  const convRows = waitingConverterRows(convWaiting);

  return (
    <PageFrame title={msg.processing} lead={msg.recordsWithAtLeastOnePipelineStageWaiting}>
      <LlmStateBlock state={gate} clearHolds={clearHoldsAction} probeNow={probeNowAction} />
      <ConverterBlock state={converter} actions={{ hold: holdConverterAction, resume: resumeConverterAction, probe: probeConverterAction }} />

      <AdminTabs path="/admin/unprocessed" tabs={UNPROCESSED_TABS} active={tab} fallback="records" label={msg.processingSections}
        counts={{ retry: { n: failedTotal, tone: "danger" } }} />

      {tab === "records" ? (<>
      <Section title={msg.runningAndFailedStages} id="stages" hint={msg.countsAcrossAllRecordsOfBothDataClasses}>
        {!res.ok ? <LoadError result={res} what={msg.processingList} /> : !counts.length ? <Empty>{msg.theQueueIsEmptyAllStagesAreComplete}</Empty> : (
          <TableWrap>
            <table className="board">
              <thead><tr><th>{msg.stage}</th><th>{msg.status}</th><th className="num">{msg.records}</th></tr></thead>
              <tbody>
                {counts.map(([key, n]) => {
                  const [st, stt] = key.split(":");
                  return (
                    <tr key={key}>
                      <td><Link href={`/admin/unprocessed?status=${encodeURIComponent(stt ?? "")}&stage=${encodeURIComponent(st ?? "")}#items`} prefetch={false} title={st}>{STAGE_TITLES[st ?? ""] ?? st}</Link></td>
                      <td><Badge tone={STATUS_TONES[stt ?? ""] ?? "neutral"}>{STAGE_STATUS_TITLES[stt ?? ""] ?? stt}</Badge></td>
                      <td className="num">{n}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      {convRows.length ? (
        <Section title={msg.waitingForTheConverter(formatCount(convWaiting?.total ?? 0))} id="converter-waiting"
          hint={msg.waitingGuidance(convWaiting?.oldest_since ? retryWhen(convWaiting.oldest_since, now) : "")}
          actions={<ActionForm action={checkConverterNowAction} submitLabel={msg.checkNow} pendingLabel="…" compact quiet>{null}</ActionForm>}>
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{msg.whyWaiting}</th><th className="num">{msg.count}</th><th /></tr></thead>
              <tbody>
                {convRows.map((r) => (
                  <tr key={r.kind}>
                    <td data-label={msg.whyWaiting}>{r.title}</td>
                    <td className="num" data-label={msg.count}>{formatCount(r.count)}</td>
                    <td className="acts"><Link href={r.href} prefetch={false}>{msg.showTheseRecords}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Section>
      ) : null}

      {reasons.length ? (
        <Section title={msg.errorReasons} id="reasons" hint={msg.failedStagesGroupedByReasonIdenticalErrorsShare}>
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{msg.reason}</th><th>{msg.stage}</th><th className="num">{msg.count}</th><th>{msg.whatToDo}</th><th /></tr></thead>
              <tbody>
                {reasons.map((r) => {
                  const info = stageErrorInfo(r.code);
                  return (
                    <tr key={`${r.stage}|${r.code}|${r.terminal}`}>
                      <td data-label={msg.reason}><span title={r.code || undefined}>{info.title}</span>{r.terminal ? <div className="cell-sub">{msg.finalRejectionRetryingWillProduceTheSameResult}</div> : null}</td>
                      <td data-label={msg.stage}>{STAGE_TITLES[r.stage] ?? r.stage}</td>
                      <td className="num" data-label={msg.count}>{formatCount(r.count)}</td>
                      <td className="cell-sub" data-label={msg.whatToDo}>{info.advice}</td>
                      <td className="acts"><Link href={reasonHref(r)} prefetch={false}>{msg.showTheseRecords}</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        </Section>
      ) : null}

      <Section title={msg.records2} id="items">
        <form method="get" action="/admin/unprocessed#items" className="filter-form">
          <div className="field field-row">
            <span className="field-label">{msg.stageStatus}</span>
            <div className="checks">
              {STATUSES.map((s) => <label className="check" key={s}><input type="checkbox" name="status" value={s} defaultChecked={statuses.includes(s)} /> {STAGE_STATUS_TITLES[s]}</label>)}
            </div>
            <span className="field-hint">{msg.nothingSelectedAnyUnfinishedStage}</span>
          </div>
          <label className="field">
            <span className="field-label">{msg.stage}</span>
            <select name="stage" defaultValue={stage}>
              <option value="">{msg.any}</option>
              {FILTER_STAGES.map((st) => <option key={st} value={st}>{STAGE_TITLES[st] ?? st}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{msg.dataClass}</span>
            <select name="class" defaultValue={cls}>
              <option value="">{msg.both}</option>
              <option value="open">{msg.open}</option>
              <option value="closed">{msg.closed}</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">{msg.owner}</span>
            <input type="search" name="owner" defaultValue={owner} placeholder={msg.login} maxLength={254} autoCapitalize="none" spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{msg.space}</span>
            <input type="search" name="space" defaultValue={space} placeholder={msg.spaceAddress} maxLength={63} autoCapitalize="none" spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{msg.reasonContains}</span>
            <input type="search" name="error" defaultValue={errorContains} placeholder={msg.forExampleTimeout} maxLength={200} />
          </label>
          {errorCode ? <input type="hidden" name="error_code" value={errorCode} /> : null}
          {terminal ? <input type="hidden" name="terminal" value={terminal} /> : null}
          <button type="submit" className="btn">{msg.show}</button>
          {filtered ? <Link href="/admin/unprocessed#items" prefetch={false} className="quiet">{msg.reset}</Link> : null}
        </form>
        {errorCode || terminal ? (
          <p className="hint">
            {errorCode ? <>{rich(msg.reason3, null, { value: <span title={errorCode}>{stageErrorInfo(errorCode).title}</span> })}</> : null}
            {terminal === "true" ? msg.finalRejectionsOnly : terminal === "false" ? msg.excludeFinalRejections : null}
            <Link href={`/admin/unprocessed?${new URLSearchParams(Object.entries({ ...params, error_code: "", terminal: "", cursor: "" }).filter(([, v]) => v)).toString()}#items`} prefetch={false}>{msg.removeThisCondition}</Link>
          </p>
        ) : null}

        {!res.ok ? null : !items.length ? (
          <>
            <Empty icon="inbox">{cursor ? msg.thereAreNoRecordsOnThisPage : msg.noRecordsMatchTheFilters}</Empty>
            {cursor ? <CursorPager path="/admin/unprocessed" params={params} cursorName="cursor" cursor={cursor} nextCursor={null} prevCursor={String(Math.max(0, offset - PAGE_SIZE))} shown={0} anchor="items" /> : null}
          </>
        ) : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead>
                  <tr><th>{msg.record}</th><th>{msg.stagesAndReason}</th><th><span className="vis-hidden">{msg.action}</span></th><th>{msg.class}</th><th>{msg.owner}</th><th>{msg.space}</th><th>{msg.received}</th></tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td data-label={msg.record}>
                        <Code title={r.id}>{shortId(r.id)}</Code> {RECORD_TYPE_TITLES[r.type] ?? r.type}
                        <div className="cell-sub ell" title={r.path}>{r.path}</div>
                      </td>
                      <td data-label={msg.stagesAndReason} className="stages-cell">
                        {r.stages.map((s) => (
                          <div key={s.stage}>
                            <span className="stage-name" title={s.stage}>{STAGE_TITLES[s.stage] ?? s.stage}</span> <Badge tone={STATUS_TONES[s.status] ?? "neutral"}>{STAGE_STATUS_TITLES[s.status] ?? s.status}</Badge>
                            {stageErrors(s) ? <div className="cell-sub">{errorsLine(stageErrors(s), retriesLimit)}</div> : null}
                            {isWaitingModel(s) ? <div className="cell-sub">{waitingLine(s, now)}</div> : null}
                            {isTooSlow(s) ? <div className="cell-sub">{STAGES_TEXT.tooSlowText}</div> : null}
                            {s.terminal ? <div className="cell-sub" title={msg.theWorkerMarkedThisRejectionAsFinalThe}>{msg.retryingWillProduceTheSameRejection}</div> : null}
                            {isConverterWait(s) ? <div className="cell-sub" title={s.last_error ?? undefined}>{converterWaitLine(s.last_error ?? "", now)}</div> : null}
                            {s.last_error && !isWaitingModel(s) && !isTooSlow(s) && !isConverterWait(s) ? (() => {
                              const e = stageErrorTitle(s.last_error);
                              return <div className="cell-sub danger-text" title={s.last_error}>{e.title ?? truncate(s.last_error, 160)}</div>;
                            })() : null}
                          </div>
                        ))}
                      </td>
                      <td className="acts" data-label="">
                        {r.stages.some((s) => s.status === "failed" || isWaitingModel(s)) ? (
                          <ActionForm action={retryRecordAction} submitLabel={onlyTerminal(r) ? msg.retryAnyway : msg.retry} pendingLabel="…" compact quiet>
                            <input type="hidden" name="id" value={r.id} />
                          </ActionForm>
                        ) : r.stages.some(isConverterWait) ? (
                          <ActionForm action={checkConverterNowAction} submitLabel={msg.checkNow} pendingLabel="…" compact quiet>
                            <input type="hidden" name="id" value={r.id} />
                          </ActionForm>
                        ) : null}
                      </td>
                      <td data-label={msg.class}><VisibilityBadge cls={r.class} tech /></td>
                      <td data-label={msg.owner}>{r.owner ? <Link href={`/admin/people/${encodeURIComponent(r.owner)}`} prefetch={false}>{mailBreak(r.owner)}</Link> : <span className="muted">—</span>}</td>
                      <td data-label={msg.space}>{r.space ? <Link href={`/admin/spaces/${encodeURIComponent(r.space)}`} prefetch={false}>{r.space}</Link> : <span className="muted">—</span>}</td>
                      <td data-label={msg.received}><LocalTime iso={r.ingested_at} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/unprocessed" params={params} cursorName="cursor" cursor={cursor} nextCursor={res.data.next_cursor ?? null}
              prevCursor={offset ? String(Math.max(0, offset - PAGE_SIZE)) : null} shown={items.length} anchor="items" />
          </>
        )}
      </Section>
      </>) : null}

      {tab === "retry" ? (
      <Section title={msg.retryAllFailedStages} id="retry" hint={msg.returnsFailedStagesToTheNowQueueEmpty}>
        {!res.ok ? null : !failedTotal && !waitingTotal && !terminalTotal ? <Empty>{msg.noFailedStagesOrStagesWaitingForThe}</Empty> : (
          <ActionForm action={retryFailedAction} submitLabel={failedTotal ? msg.retryAllFailedStages2(failedTotal) : msg.retry} pendingLabel={msg.starting} confirm={msg.retryStagesMatchingTheSelectedFilters}>
            {waitingTotal ? (
              <label className="check">{rich(msg.includeStagesWaitingForTheModelNightStages, null, { value: <input type="checkbox" name="include_waiting" />, value2: waitingTotal })}</label>
            ) : null}
            {terminalTotal ? (
              <label className="check" title={msg.finalRejectionTheSameInputProducesTheSame}>{rich(msg.includeFinalRejectionsRetryingProducesTheSameResult, null, { value: <input type="checkbox" name="include_terminal" />, value2: terminalTotal })}</label>
            ) : null}
            <div className="form-grid">
              <Field label={msg.stage} hint={msg.thisStageOnly}>
                <select name="stage" defaultValue="">
                  <option value="">{msg.any}</option>
                  {RETRY_STAGES.map((st) => <option key={st} value={st}>{STAGE_TITLES[st] ?? st}</option>)}
                </select>
              </Field>
              <Field label={msg.dataClass}>
                <select name="class" defaultValue="">
                  <option value="">{msg.both}</option>
                  <option value="open">{msg.open}</option>
                  <option value="closed">{msg.closed}</option>
                </select>
              </Field>
              <Field label={msg.errorContains} hint={msg.partOfTheLastErrorMessageSuchAs}>
                <input type="text" name="error_contains" maxLength={200} placeholder={msg.substring} />
              </Field>
              <Field label={msg.failedAfter} hint={msg.dateAndTimeByYourClock}>
                <input type="datetime-local" name="failed_since" />
                <TzField />
              </Field>
            </div>
          </ActionForm>
        )}
      </Section>

      ) : null}

      {moves ? (
      <Section title={msg.classMovesHeading(moves.ok ? movesTotal : null)} id="moves" hint={msg.openingOrClosingARecordMovesItBetween}
        actions={<ActionForm action={reconcileAction} submitLabel={msg.reconcileNow} pendingLabel="…" compact quiet>{null}</ActionForm>}>
        {!moves.ok ? <LoadError result={moves} what={msg.moves} /> : !lastMoves.length ? <Empty>{msg.noFailedOrRunningMoves}</Empty> : (
          <TableWrap>
            <table className="board">
              <thead><tr><th>{msg.record}</th><th>{msg.destination}</th><th>{msg.status}</th><th>{msg.reason}</th><th>{msg.requested}</th><th /></tr></thead>
              <tbody>
                {lastMoves.map((m) => (
                  <tr key={m.id}>
                    <td><Code title={m.record_id}>{shortId(m.record_id)}</Code></td>
                    <td>
                      <VisibilityBadge cls={m.from_class} tech /> → <VisibilityBadge cls={m.to_class} tech />
                      {m.via && m.via !== "person" ? <div className="cell-sub">{MOVE_VIA_TITLES[m.via] ?? m.via}</div> : null}
                      {m.accepted_rules?.length ? <div className="cell-sub">{rich(msg.accepted, null, { value: m.accepted_rules.join(", ") })}</div> : null}
                      {m.text_only ? <div className="cell-sub">{msg.textOnlyScan}</div> : null}
                      {m.accepted_scope ? <div className="cell-sub">{m.accepted_scope === "solo" ? msg.visibleToTheAuthorOnly : msg.visibleToOthersToo}</div> : null}
                    </td>
                    <td><Badge tone={m.status === "failed" ? "danger" : "info"}>{m.status === "failed" ? msg.error : msg.inProgress}</Badge></td>
                    <td className="muted">{m.status === "failed" && m.error ? truncate(m.error, 160) : "—"}</td>
                    <td><LocalTime iso={m.requested_at} /></td>
                    <td>
                      {m.confirmation === "agent_relayed" && m.status === "failed" ? (
                        <span className="cell-sub">{msg.thePersonMustConfirmAgain}</span>
                      ) : m.status === "failed" && despiteRefused(m) ? (
                        <span className="cell-sub">{msg.theAuthorMustConsentAgain}</span>
                      ) : m.status === "failed" && m.error?.startsWith("parent_other_class") ? (
                        <span className="cell-sub">{msg.movesWithTheSourceRecord}</span>
                      ) : m.status === "failed" && !m.error?.startsWith("never_open:") && !m.error?.startsWith("record_deleted") ? (
                        <ActionForm action={retryMoveAction} submitLabel={msg.retry} pendingLabel="…" compact quiet>
                          <input type="hidden" name="id" value={m.id} />
                        </ActionForm>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>
      ) : null}
    </PageFrame>
  );
}
