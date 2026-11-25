import { rich } from "@/i18n/rich";
import { ALL_CONFIRM, TEXT } from "@/messages/panel-open-check";
import { ActionForm } from "@/components/action-form";
import type { ConfirmSpec } from "@/components/confirm-dialog";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { Badge, Code, LoadError, Notice, Section, TableWrap, Field } from "@/components/ui";
import type { Result } from "@/lib/api";
import { shortId } from "@/lib/format";
import { OPEN_CHECK_KIND_TITLES } from "@/lib/labels";
import { setRecheckBatchAction, setRecheckOnChangeAction, startRecheckAction } from "./recheck-actions";
import { countsLine, RECHECK_BATCH_RANGE, RECHECK_PAGE, RECHECK_REASON_TITLES, RECHECK_STATE_TITLES, RECHECK_WHY_TITLES, type RecheckView } from "./recheck-view";



export function RecheckSection({ res, cursor }: { res: Result<RecheckView>; cursor: string }) {
  if (!res.ok) return res.status === 404 ? null : (
    <Section title={TEXT.nDAListRecheck} id="recheck"><LoadError result={res} what={TEXT.theNDAListRecheck} /></Section>
  );
  const v = res.data, h = v.holds, last = v.last, running = v.running;
  return (
    <Section title={TEXT.nDAListRecheck} id="recheck" hint={TEXT.whenNamesAreAddedToTheListMemory}>
      <TableWrap>
        <table className="board">
          <tbody>
            <tr className={v.enabled ? undefined : "off"}>
              <td>{rich(TEXT.checkOpenRecordsWhenNamesAreAdded, { v0: () => (<code className="code" title={TEXT.settingNameInTheDatabaseAndAPI}>open_check.recheck_on_nda_change</code>) })}</td>
              <td>{v.enabled ? <Badge tone="ok">{TEXT.on}</Badge> : <Badge tone="muted">{TEXT.off}</Badge>}</td>
              <td>
                <ActionForm action={setRecheckOnChangeAction} submitLabel={v.enabled ? TEXT.turnOff : TEXT.turnOn} pendingLabel={TEXT.pending} compact quiet
                  confirm={v.enabled ? TEXT.turnOffNewNamesWillBeCheckedOnly : undefined}>
                  <input type="hidden" name="value" value={v.enabled ? "false" : "true"} />
                </ActionForm>
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <ActionForm action={setRecheckBatchAction} submitLabel={TEXT.save} pendingLabel={TEXT.saving} quiet>
        <Field label={TEXT.recordsPerStep2} hint={<>{rich(TEXT.fromToCurrentlySmallerBatchesReduceDatabaseLoad, { v0: () => (RECHECK_BATCH_RANGE[0]), v1: () => (RECHECK_BATCH_RANGE[1]), v2: () => (v.batch), v3: () => (<code className="code" title={TEXT.settingNameInTheDatabaseAndAPI}>open_check.recheck_batch</code>) })}</>}>
          <input type="text" name="batch" inputMode="numeric" defaultValue={String(v.batch)} required maxLength={4} autoComplete="off" />
        </Field>
      </ActionForm>

      {running ? (
        <Notice tone="info" role="status">{rich(TEXT.recheckRunning, { v0: () => (RECHECK_REASON_TITLES[running.reason] ?? running.reason), v1: () => (running.started_at ? <>{rich(TEXT.started, { v0: () => (<LocalTime iso={running.started_at} />) })}</> : null), v2: () => (countsLine(running.counts)) })}</Notice>
      ) : !v.baseline_known ? (
        <p className="hint">{TEXT.recheckHasNotRunYetTheFirstRun}</p>
      ) : null}
      {last?.run ? (
        <p className="hint">{rich(TEXT.lastRecheck, { v0: () => (RECHECK_REASON_TITLES[last.reason ?? ""] ?? last.reason ?? TEXT.missingValue), v1: () => (last.at ? <>{rich(TEXT.finished, { v0: () => (<LocalTime iso={last.at} />) })}</> : null), v2: () => (countsLine(last)) })}</p>
      ) : null}

      <div className="stat-tiles">
        <div className="stat-tile"><div className={h.held ? "v warn" : "v"}>{h.held}</div><div className="k">{TEXT.hiddenAwaitingReview}</div></div>
        <div className="stat-tile"><div className="v">{h.kept}</div><div className="k">{TEXT.keptHidden}</div></div>
        <div className="stat-tile"><div className="v">{h.on_restore}</div><div className="k">{TEXT.inTrashWillReturnHidden}</div></div>
        {h.failed ? <div className="stat-tile"><div className="v warn">{h.failed}</div><div className="k">{TEXT.couldNotHideWillRetry}</div></div> : null}
      </div>

      {v.items.length || cursor ? (
        <div id="recheck-list">
          <TableWrap>
            <table className="board">
              <thead><tr><th>{TEXT.record}</th><th>{TEXT.space}</th><th>{TEXT.author}</th><th>{TEXT.when}</th><th>{TEXT.findings}</th><th>{TEXT.status2}</th></tr></thead>
              <tbody>
                {v.items.map((r) => (
                  <tr key={r.record_id}>
                    <td><Code title={r.record_id}>{shortId(r.record_id)}</Code></td>
                    <td>{r.space ? <Code title={r.space.name}>{r.space.slug}</Code> : TEXT.missingValue}</td>
                    <td>{r.author?.login ?? TEXT.missingValue}</td>
                    <td>{r.held_at ? <LocalTime iso={r.held_at} /> : TEXT.missingValue}</td>
                    <td>{r.why ? RECHECK_WHY_TITLES[r.why] ?? r.why : TEXT.missingValue}{r.kinds.length ? <div className="cell-sub">{TEXT.recheckKinds(r.kinds.map((k) => OPEN_CHECK_KIND_TITLES[k] ?? k))}</div> : null}</td>
                    <td>{RECHECK_STATE_TITLES[r.state] ?? r.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <CursorPager path="/admin/open-check" params={{}} cursorName="rcc" cursor={cursor} nextCursor={v.next_cursor}
            prevCursor={cursor ? String(Math.max(0, Number(cursor) - RECHECK_PAGE)) : null} shown={v.items.length} anchor="recheck-list" noun={TEXT.records} />
        </div>
      ) : null}

      {v.report.spaces.length || v.report.entities.length ? (
        <p className="hint">{rich(TEXT.matchesInNamesAndDescriptionsAreUnchangedBy, { v0: () => (v.report.spaces.length ? <>{rich(TEXT.spaces, { v0: () => (v.report.spaces.map((s) => <Code key={s.slug} title={s.name}>{s.slug}</Code>)) })}</> : null), v1: () => (v.report.spaces.length && v.report.entities.length ? TEXT.reportSeparator() : null), v2: () => (v.report.entities.length ? TEXT.entitiesCompaniesAndDeals(String(v.report.entities.length)) : null) })}</p>
      ) : null}

      <div className="form-row">
        <ActionForm action={startRecheckAction} submitLabel={TEXT.recheckHiddenRecords} pendingLabel={TEXT.starting} quiet disabled={Boolean(running) || !(h.held + h.kept)}>
          <input type="hidden" name="action" value="held" />
        </ActionForm>
        <ActionForm action={startRecheckAction} submitLabel={TEXT.checkEverythingAgain} pendingLabel={TEXT.starting} quiet confirm={ALL_CONFIRM} disabled={Boolean(running)}>
          <input type="hidden" name="action" value="all" />
        </ActionForm>
      </div>
      <p className="hint">{TEXT.recheckHiddenRecordsUsesTheCurrentRulesAnd}</p>
    </Section>
  );
}
