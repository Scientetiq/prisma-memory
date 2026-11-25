import { rich } from "@/i18n/rich";
import { LANE_TITLES, TOGGLES, DESPITE_ON_CONFIRM, TEXT } from "@/messages/panel-open-check";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import type { ConfirmSpec } from "@/components/confirm-dialog";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { CursorPager } from "@/components/pager";
import { Badge, Code, Empty, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw, type Result } from "@/lib/api";
import { shortId, truncate } from "@/lib/format";
import { OPEN_CHECK_EXTRA_KINDS, OPEN_CHECK_KIND_TITLES } from "@/lib/labels";
import { TEXT as FORM_TEXT } from "@/messages/open-check-form";
import { effectivePacks, NDA_MAX, ndaCaseNote, OPEN_CHECK_PACK_NAMES, OPEN_CHECK_PACK_TITLES, TEST_TEXT_MAX } from "@/lib/open-check-form";
import { param, type SearchParams } from "@/lib/paging";
import { despiteToggles, type DespiteToggle } from "@/lib/show-anyway";
import type { DespiteShownList, OpenCheckRuleView, OpenCheckView, SettingsResponse } from "@/lib/types";
import { addRuleAction, deleteRuleAction, hideShownAction, saveNdaAction, setDespiteToggleAction, setOpenCheckEnabledAction, setOpenCheckPacksAction, setOpenCheckTimeoutAction, testTextAction, toggleRuleAction } from "./actions";
import { RecheckSection } from "./recheck-section";
import { RECHECK_PAGE, type RecheckView } from "./recheck-view";

export function generateMetadata(): Metadata { return { title: TEXT.openCheck }; }



interface RunnerLaneView { threads: number; up: number; running: number; queued: number; failing: boolean; retry_in_ms?: number }
type RunnerView = { ok: boolean; lanes: Partial<Record<string, RunnerLaneView>>; last_failure_at: string | null };


function laneLine(name: string, l: RunnerLaneView): string {
  const who = name === "test" ? TEXT.testTextReceives : TEXT.recordsReceive;
  const state = !l.failing ? "" : (l.retry_in_ms ?? 0) > 0 ? TEXT.theWorkerCannotStartCheckServerIsBusy(String(who)) : TEXT.theLastStartFailedTheNextCheckWill;
  return TEXT.ofWorkersUpRunningQueued(String(LANE_TITLES[name] ?? name), String(l.up), String(l.threads), String(l.running), String(l.queued), String(state));
}

export default async function OpenCheckPage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  await guardAuditorPage();
  const sp = (await searchParams) ?? {};
  const asked = param(sp, "dsc").replace(/[^0-9]/g, "").slice(0, 9);
  const shownAt = (cursor: string) => tryGw<DespiteShownList>("/api/v1/admin/despite/shown", { query: { limit: SHOWN_PAGE, ...(cursor ? { cursor } : {}) } });
  const rcc = param(sp, "rcc").replace(/[^0-9]/g, "").slice(0, 9);
  const [res, settings, page, recheck] = await Promise.all([
    tryGw<OpenCheckView>("/api/v1/admin/open-check"),
    tryGw<SettingsResponse>("/api/v1/admin/settings"),
    shownAt(asked),
    tryGw<RecheckView>("/api/v1/admin/open-check/recheck", { query: { limit: RECHECK_PAGE, ...(rcc ? { cursor: rcc } : {}) } }),
  ]);
  const unknown = asked !== "" && page.ok && page.data.total == null;
  const shown = unknown ? await shownAt("") : page, cursor = unknown ? "" : asked;
  // rule packs: the stored value from the settings list; no item — the gateway is older than the setting
  const packsItem = settings.ok ? settings.data.items.find((i) => i.category === "open_check" && i.key === "packs") : undefined;

  return (
    <PageFrame title={TEXT.openCheck} lead={TEXT.theServerChecksEveryRecordEnteringOpenData}>
      {!res.ok ? (
        <>
          <LoadError result={res} what={TEXT.theOpenCheck} />
          {res.status === 404 ? <Notice tone="warn">{rich(TEXT.theGatewayDoesNotKnowTheRouteIt, { v0: () => (<code className="code">/api/v1/admin/open-check</code>) })}</Notice> : null}
        </>
      ) : <OpenCheckBody v={res.data} packs={packsItem ? { value: packsItem.value } : null} despite={<DespiteSection settings={settings} shown={shown} cursor={cursor} rules={res.data.rules ?? []} />}
                          recheck={<RecheckSection res={recheck} cursor={rcc} />} />}
    </PageFrame>
  );
}

function OpenCheckBody({ v, packs, despite, recheck }: { v: OpenCheckView; packs?: { value: unknown } | null; despite?: ReactNode; recheck?: ReactNode }) {
  const disabled = new Set(v.disabled_rules ?? []);
  const rules = [...(v.rules ?? [])].sort((a, b) => Number(b.builtin) - Number(a.builtin));
  const refused = v.refused_24h ?? { total: 0, by_kind: {} };
  const byKind = Object.entries(refused.by_kind ?? {}).filter(([, n]) => n > 0).sort(([, a], [, b]) => b - a);
  const nda = v.nda_customers ?? [];
  const caseNotes = nda.flatMap((n) => { const note = ndaCaseNote(n); return note ? [TEXT.ndaCaseEntry(n, note)] : []; });
  const runner = (v as OpenCheckView & { runner?: RunnerView }).runner;

  return (
    <>
      <Section title={TEXT.status} id="state">
        {v.enabled
          ? <Notice tone="ok" role="status">{rich(TEXT.openCheckIsOnARecordWithA, { v0: () => (<code className="code">open_check</code>) })}</Notice>
          : <Notice tone="warn" role="status">{TEXT.openCheckIsOffRecordsEnterOpenData}</Notice>}
        <p className="hint">{TEXT.aCheckThatExceedsItsTimeLimitRejects}</p>
        <ActionForm action={setOpenCheckTimeoutAction} submitLabel={TEXT.saveTimeout} pendingLabel={TEXT.saving} quiet>
          <Field label={TEXT.checkTimeoutPerRecordSeconds} hint={<>{rich(TEXT.from1To120CurrentlyMeasuredFromThe, { v0: () => (v.timeout_sec ?? 10), v1: () => (<code className="code" title={TEXT.settingNameInTheDatabaseAndAPI}>open_check.timeout_sec</code>) })}</>}>
            <input type="text" name="timeout_sec" inputMode="numeric" defaultValue={String(v.timeout_sec ?? 10)} required maxLength={5} autoComplete="off" />
          </Field>
        </ActionForm>
        <p className="hint">{TEXT.ifTheCheckServerIsBusyTheQueue}</p>
        {runner?.lanes ? (
          <p className="hint">{rich(TEXT.gatewayCheckWorkers, { v0: () => (TEXT.runnerList(Object.entries(runner.lanes).flatMap(([n, l]) => (l ? [laneLine(n, l)] : [])))) })}</p>
        ) : null}
        <ActionForm action={setOpenCheckEnabledAction} submitLabel={v.enabled ? TEXT.turnOffCheck : TEXT.turnOnCheck} pendingLabel={TEXT.saving}
          danger={v.enabled} confirm={v.enabled ? TEXT.turnOffTheCheckRecordsWillEnterOpen : undefined}>
          <input type="hidden" name="enabled" value={v.enabled ? "false" : "true"} />
        </ActionForm>
        <p className="hint">{FORM_TEXT.textInsideImagesAndScannedPagesIsNot}</p>
        {packs ? <PacksForm value={packs.value} /> : null}
      </Section>

      {despite}

      <Section title={TEXT.rules} id="rules" hint={TEXT.builtInRulesArePartOfMemoryS}>
        {!rules.length ? <Empty>{TEXT.theGatewayReturnedNoRules}</Empty> : (
          <TableWrap>
            <table className="board">
              <thead><tr><th>{TEXT.rule}</th><th>{TEXT.kind}</th><th>{TEXT.status2}</th><th /></tr></thead>
              <tbody>
                {rules.map((r) => <RuleRow key={r.name} r={r} off={r.builtin && disabled.has(r.name)} gated={r.builtin && !r.active && !disabled.has(r.name)} />)}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      <Section title={TEXT.addRule} id="add" hint={TEXT.customRulesCatchWhatBuiltInRulesMiss}>
        <ActionForm action={addRuleAction} submitLabel={TEXT.addRule} pendingLabel={TEXT.saving} resetOnSuccess quiet>
          <div className="form-grid">
            <Field label={TEXT.name} hint={TEXT.latinLettersDigitsAndFrom2To64}>
              <input type="text" name="name" required minLength={2} maxLength={64} pattern="[A-Za-z0-9_]{2,64}" spellCheck={false} autoComplete="off" placeholder={TEXT.ruleNameExample} />
            </Field>
            <Field label={TEXT.kind2} hint={TEXT.rejectionsAreGroupedByKindInReports}>
              <select name="kind" defaultValue="custom">
                {OPEN_CHECK_EXTRA_KINDS.map((k) => <option key={k} value={k}>{TEXT.kindWithCode(OPEN_CHECK_KIND_TITLES[k], k)}</option>)}
              </select>
            </Field>
            <Field label={TEXT.pattern} wide hint={TEXT.javaScriptRegularExpressionFlagsIAndUUp}>
              <input type="text" name="pattern" required maxLength={1000} spellCheck={false} autoComplete="off" placeholder={TEXT.projectSFalcon} />
            </Field>
            <Field label={TEXT.reason} wide hint={TEXT.upTo200CharactersTheRecordSAuthor}>
              <input type="text" name="reason" required maxLength={200} autoComplete="off" placeholder={TEXT.projectCodeName} />
            </Field>
          </div>
        </ActionForm>
      </Section>

      <Section title={TEXT.customersWithAStrictNDA} id="nda" hint={TEXT.oneNamePerLineWithoutALegalForm}>
        <details className="hint-details">
          <summary>{TEXT.howShouldNamesBeWritten}</summary>
          <p className="hint">{TEXT.namesAreMatchedAcrossGrammaticalFormsLegalForms}</p>
        </details>
        <ActionForm action={saveNdaAction} submitLabel={TEXT.saveList} pendingLabel={TEXT.saving} quiet>
          <Field label={TEXT.customers(String(nda.length))} wide hint={TEXT.oneNamePerLine3LettersOr2(String(NDA_MAX))}>
            <textarea name="nda" rows={Math.min(14, Math.max(4, nda.length + 2))} defaultValue={nda.join("\n")} spellCheck={false} placeholder={TEXT.lLCForgetMeNotJSCNorthWind} />
          </Field>
        </ActionForm>
        {caseNotes.length ? <p className="hint">{rich(TEXT.howNamesAreMatchedTryAmbiguousNamesIn, { v0: () => (TEXT.ndaCaseList(caseNotes.slice(0, 8))), v1: () => (caseNotes.length > 8 ? TEXT.andMore(String(caseNotes.length - 8)) : "") })}</p> : null}
      </Section>

      {recheck}

      <Section title={TEXT.testText} id="test" hint={TEXT.theSameCheckAsForARecordEntering}>
        <ActionForm action={testTextAction} submitLabel={TEXT.testText} pendingLabel={TEXT.checking} quiet>
          <Field label={TEXT.text} wide>
            <textarea name="text" rows={5} required maxLength={TEST_TEXT_MAX} spellCheck={false} placeholder={TEXT.pasteANoteOrDocumentExcerpt} />
          </Field>
        </ActionForm>
      </Section>

      <Section title={TEXT.rejectionsInThePastDay} id="refused" hint={TEXT.rejectionsOfWritesToOpenDataInThe}>
        <div className="stat-tiles">
          <div className="stat-tile"><div className={refused.total ? "v warn" : "v"}>{refused.total}</div><div className="k">{TEXT.rejectionsInThePastDay2}</div></div>
          {byKind.map(([k, n]) => (
            <div className="stat-tile" key={k}><div className="v">{n}</div><div className="k">{OPEN_CHECK_KIND_TITLES[k] ?? k}</div></div>
          ))}
        </div>
        <p className="hint">{rich(TEXT.forWritePathsRulesSpacesAndPeopleOver, { v0: () => (<Link href="/admin/report#open-check" prefetch={false}>{TEXT.report}</Link>) })}</p>
      </Section>
    </>
  );
}

/** Rule packs (open_check.packs): core is always on; removing a pack weakens the check. */
function PacksForm({ value }: { value: unknown }) {
  const on = new Set<string>(effectivePacks(value));
  return (
    <ActionForm action={setOpenCheckPacksAction} submitLabel={/* i18n */ TEXT.saveRulePacks} pendingLabel={TEXT.pending} quiet>
      <fieldset className="field">
        <legend className="field-label">{/* i18n */ TEXT.rulePacks}</legend>
        <input type="hidden" name="pack" value="core" />
        {OPEN_CHECK_PACK_NAMES.map((p) => (
          <label key={p} className="check">
            <input type="checkbox" name="pack" value={p} defaultChecked={on.has(p)} disabled={p === "core"} /> {OPEN_CHECK_PACK_TITLES[p]}
          </label>
        ))}
        <span className="field-hint">{/* i18n */ TEXT.builtInRulesAreGroupedInPacksA} <code className="code" title={TEXT.settingNameInTheDatabaseAndTheAPI}>open_check.packs</code></span>
      </fieldset>
    </ActionForm>
  );
}

function RuleRow({ r, off, gated = false }: { r: OpenCheckRuleView; off: boolean; gated?: boolean }) {
  return (
    <tr className={r.active ? undefined : "off"}>
      <td>
        {r.reason} <Code>{r.name}</Code>
        {!r.builtin && r.pattern ? <div className="cell-sub"><Code title={r.pattern}>{truncate(r.pattern, 60)}</Code></div> : null}
      </td>
      <td>
        {OPEN_CHECK_KIND_TITLES[r.kind] ?? r.kind}
        <div className="cell-sub">{r.builtin ? TEXT.builtIn : TEXT.addedInThePanel}</div>
      </td>
      <td>{r.active ? <Badge tone="ok">{TEXT.active}</Badge> : <Badge tone="muted" title={gated ? /* i18n */ TEXT.notInTheSelectedRulePacks : r.builtin ? TEXT.turnedOffInOpenCheckDisabledRules : undefined}>{TEXT.off}</Badge>}</td>
      <td>
        {gated ? null : r.builtin ? (
          <ActionForm action={toggleRuleAction} submitLabel={off ? TEXT.turnOn : TEXT.turnOff} pendingLabel={TEXT.pending} compact quiet>
            <input type="hidden" name="name" value={r.name} />
            <input type="hidden" name="off" value={off ? "false" : "true"} />
          </ActionForm>
        ) : (
          <ActionForm action={deleteRuleAction} submitLabel={TEXT.delete} pendingLabel={TEXT.pending} compact quiet confirm={TEXT.deleteRuleRecordsWithThisContentWillBe(String(r.name))}>
            <input type="hidden" name="name" value={r.name} />
          </ActionForm>
        )}
      </td>
    </tr>
  );
}

const SHOWN_PAGE = 50;




function hideSpec(n: number): ConfirmSpec {
  return {
    question: TEXT.hideThemFromAgents,
    change: TEXT.shownInTeamsAndProjectsAgentsWillNo(String(n)),
    undo: TEXT.anythingAgentsHaveAlreadyReadStaysWithThem,
    verb: TEXT.hideFromAgents,
    danger: true,
    ack: { name: "confirm", label: TEXT.iUnderstandAIAgentsWillNoLongerSee },
  };
}

function DespiteSection({ settings, shown, cursor, rules }: { settings: Result<SettingsResponse>; shown: Result<DespiteShownList>; cursor: string; rules: readonly OpenCheckRuleView[] }) {
  const t = settings.ok ? despiteToggles(settings.data.items) : null;
  const known = t !== null && t.enabled !== null && t.projects !== null && t.scansText !== null;
  const reason = new Map(rules.map((r) => [r.name, r.reason]));
  const total = shown.ok ? shown.data.total ?? 0 : 0;
  const inTrash = shown.ok ? shown.data.in_trash ?? 0 : 0;
  const trashLine = inTrash > 0 && t?.projects === false
    ? <p className="hint">{TEXT.anotherInTrashDoNotNeedHidingIf(String(inTrash))}</p> : null;
  const showing = shown.ok ? shown.data.showing ?? 0 : 0;
  const showingLine = showing > 0 && t?.projects === false
    ? <p className="hint">{TEXT.stillMovingShowingBeganBeforeItWasTurned(String(showing))}</p> : null;
  return (
    <Section title={TEXT.makeAvailableToAgents} id="despite" hint={TEXT.theAuthorOfARecordTheCheckKept}>
      {t?.projects !== false ? <p className="hint">{TEXT.showingInTeamsAndProjectsWasEnabledBy}</p> : null}
      {!settings.ok ? <LoadError result={settings} what={TEXT.settings} />
        : !known ? <Notice tone="warn">{TEXT.theGatewayDoesNotKnowTheMakeAvailable}</Notice> : (
        <TableWrap>
          <table className="board">
            <thead><tr><th>{TEXT.switch}</th><th>{TEXT.status2}</th><th /></tr></thead>
            <tbody>
              {TOGGLES.map((x) => {
                const on = t![x.id] === true;
                return (
                  <tr key={x.id} className={on ? undefined : "off"}>
                    <td>{x.title} <Code title={TEXT.settingNameInTheDatabaseAndAPI}>{x.key}</Code><div className="cell-sub">{x.hint}</div></td>
                    <td>{on ? <Badge tone="ok">{TEXT.on}</Badge> : <Badge tone="muted">{TEXT.off}</Badge>}</td>
                    <td>
                      <ActionForm action={setDespiteToggleAction} submitLabel={on ? TEXT.turnOff : TEXT.turnOn} pendingLabel={TEXT.pending} compact quiet confirm={on ? undefined : DESPITE_ON_CONFIRM[x.id]}>
                        <input type="hidden" name="toggle" value={x.id} />
                        <input type="hidden" name="value" value={on ? "false" : "true"} />
                      </ActionForm>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {!shown.ok ? (shown.status === 404 ? null : <LoadError result={shown} what={TEXT.recordsShownInTeamsAndProjects} />)
        : t?.projects !== false ? (total > 0 || cursor ? (
          <div className="despite-shown" id="despite-shown">
            <p className="hint">{rich(TEXT.turnOffShowingInTeamsAndProjectsFirst2, { v0: () => (<strong>{rich(TEXT.shownInTeamsAndProjects, { v0: () => (total) })}</strong>) })}</p>
          </div>
        ) : null)
        : total > 0 || cursor || showing > 0 ? (
          <div className="despite-shown" id="despite-shown">
            {total > 0 || cursor
              ? <p className="hint">{rich(TEXT.hideThemFromAgentsEachRecordSAuthor, { v0: () => (<strong>{rich(TEXT.shownInTeamsAndProjects, { v0: () => (total) })}</strong>) })}</p>
              : <p className="hint">{TEXT.noRecordsShownInTeamsOrProjectsAre}</p>}
            {shown.data.items.length ? (
              <TableWrap>
                <table className="board">
                  <thead><tr><th>{TEXT.record}</th><th>{TEXT.space}</th><th>{TEXT.author}</th><th>{TEXT.whenShown}</th><th>{TEXT.whatWasAccepted}</th></tr></thead>
                  <tbody>
                    {shown.data.items.map((r) => (
                      <tr key={r.record_id}>
                        <td><Code title={r.record_id}>{shortId(r.record_id)}</Code></td>
                        <td>{r.space_slug ? <Code>{r.space_slug}</Code> : TEXT.missingValue}</td>
                        <td>{r.author_login ?? TEXT.missingValue}</td>
                        <td>{r.shown_at ? <LocalTime iso={r.shown_at} /> : TEXT.missingValue}</td>
                        <td>{TEXT.shownRuleReasons(r.rules.map((x) => reason.get(x) ?? x))}{r.text_only ? <div className="cell-sub">{TEXT.textOnlyScan}</div> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            ) : null}
            {shown.data.items.length || cursor ? (
              <CursorPager path="/admin/open-check" params={{}} cursorName="dsc" cursor={cursor} nextCursor={shown.data.next_cursor}
                prevCursor={cursor ? String(Math.max(0, Number(cursor) - SHOWN_PAGE)) : null} shown={shown.data.items.length} anchor="despite-shown" noun={TEXT.records} />
            ) : null}
            <ActionForm action={hideShownAction} submitLabel={TEXT.hideFromAgents} pendingLabel={TEXT.hiding} danger confirm={hideSpec(total)} disabled={total === 0 && !cursor}>
              <label className="check ack-fallback">{rich(TEXT.iUnderstandAIAgentsWillNoLongerSee2, { v0: () => (<input type="checkbox" name="confirm" />) })}</label>
            </ActionForm>
            {showingLine}
            {trashLine}
          </div>
        ) : t?.projects === false ? <><p className="hint">{TEXT.noRecordsAreShownInTeamsOrProjects}</p>{trashLine}</> : null}
    </Section>
  );
}
