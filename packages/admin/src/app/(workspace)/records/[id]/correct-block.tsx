import { correctBlockText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Field, Notice } from "@/components/ui";
import { CORRECTION_KIND_HINTS, CORRECTION_KIND_ORDER, LIMITS, OTHER_KINDS, actorsFieldLabel, correctionKindTitle, dueWordsHint, isCalendarDate, CORRECTIONS_COPY } from "@/lib/corrections";
import { formatDay } from "@/lib/plain";
import type { CorrectionKindOption, EventFields } from "@/lib/types";
import { correctAction } from "../../corrections/actions";

export interface NewerSearch { q: string; items: Array<{ id: string; title: string; type: string; event_kind?: string | null; occurred_at?: string | null }> | null }

export interface CorrectBlockProps {
  id: string;
  kinds: CorrectionKindOption[];
  eventFields: EventFields | null;
  fragmentHtml: string | null;
  note: { title: string; text: string | null; digest: string | null };
  type?: string;
  eventKind?: string | null;
  resetNotice?: boolean;
  openKept?: boolean;
  newer?: NewerSearch | null;
  open?: boolean;
}

function KindFields({ k, p }: { k: CorrectionKindOption; p: CorrectBlockProps }) {
  switch (k.kind) {
    case "extraction_error": {
      const ef = p.eventFields ?? { title: "", statement: "", due: null, actors: [] };
      const words = ef.due && !isCalendarDate(ef.due) ? ef.due : null;
      return (
        <>
          <input type="hidden" name="was_title" value={ef.title} />
          <input type="hidden" name="was_statement" value={ef.statement} />
          <input type="hidden" name="was_due" value={ef.due ?? ""} />
          <input type="hidden" name="was_actors" value={JSON.stringify(ef.actors)} />
          <div className="form-grid">
            <Field label={M.title} wide><input name="title" defaultValue={ef.title} maxLength={LIMITS.title} autoComplete="off" /></Field>
            <Field label={M.statement} wide><textarea name="statement" defaultValue={ef.statement} maxLength={LIMITS.statement} rows={3} /></Field>
            <label className="field">
              <span className="field-label">{rich(M.dueDate, null)}</span>
              {words ? <span className="field-hint corr-due-now">{dueWordsHint(words)}</span> : null}
              <input type="date" name="due" defaultValue={isCalendarDate(ef.due) ? ef.due : undefined} />
            </label>
            <label className="check corr-nodue">{rich(M.noDueDate, { tag0: () => <input type="checkbox" name="no_due" value="1" /> })}</label>
            <Field label={actorsFieldLabel(p.eventKind)} wide><input name="actors" defaultValue={ef.actors.join(", ")} autoComplete="off" /></Field>
          </div>
          {p.fragmentHtml !== null ? (
            <>
              <p className="hint">{CORRECTIONS_COPY.fragmentLead}</p>
              <div className="prose corr-fragment" dangerouslySetInnerHTML={{ __html: p.fragmentHtml }} />
              <Field label={M.phraseFromTheTranscript} hint={M.optionalAnExactPhrase81} wide>
                <textarea name="quote" minLength={LIMITS.quoteMin} maxLength={LIMITS.quoteMax} rows={2} />
              </Field>
            </>
          ) : null}
        </>
      );
    }
    case "wrong":
      return <Field label={M.whatIsCorrectInYourOwn} wide><textarea name="text" required maxLength={LIMITS.text} rows={3} /></Field>;
    case "outdated": {
      const items = p.newer?.items ?? null;
      return (
        <>
          <Field label={M.whatIsCorrectInYourOwn} hint={M.fillInThisFieldOrSpecify} wide><textarea name="text" maxLength={LIMITS.text} rows={3} /></Field>
          {items?.length ? (
            <fieldset className="newer-pick">
              <legend>{rich(M.newerRecord, null)}</legend>
              {items.map((it) => (
                <label key={it.id} className="check">
                  <input type="radio" name="newer_pick" value={it.id} /> {it.title || M.untitled}
                  <span className="muted small">{M.candidateCaption(it.type, it.event_kind ?? null, it.occurred_at ? formatDay(it.occurred_at) : null)}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <details className="newer-manual">
            <summary>{rich(M.pasteARecordLink, null)}</summary>
            <Field label={M.linkToTheNewerRecordPage} wide><input name="newer" autoComplete="off" placeholder={M.linkToTheRecordPage} /></Field>
          </details>
        </>
      );
    }
    case "own_note":
      return (
        <>
          <input type="hidden" name="was_title" value={p.note.title} />
          {p.note.digest ? <input type="hidden" name="was_text" value={p.note.digest} /> : null}
          {k.closed_result ? <input type="hidden" name="closed_result" value="1" /> : null}
          {!k.closed_result && p.openKept ? <input type="hidden" name="open_kept" value="1" /> : null}
          <Field label={M.title} wide><input name="title" defaultValue={p.note.title} maxLength={LIMITS.title} autoComplete="off" /></Field>
          <Field label={M.text} hint={p.note.text === null ? CORRECTIONS_COPY.noteTruncatedHint : undefined} wide>
            <textarea name="text" required defaultValue={p.note.text ?? ""} rows={8} />
          </Field>
        </>
      );
  }
}

function NewerSearchForm({ id, newer }: { id: string; newer: NewerSearch | null | undefined }) {
  return (
    <>
      <form method="get" action={`/records/${id}#correct`} className="filter-form newer-search">
        <label className="field grow">
          <span className="field-label">{rich(M.findANewerRecord, null)}</span>
          <input type="search" name="newer_q" defaultValue={newer?.q ?? ""} minLength={3} maxLength={200} placeholder={M.partOfTheTitle} autoComplete="off" />
        </label>
        <button type="submit" className="btn">{rich(M.search, null)}</button>
      </form>
      {newer?.q && newer.items && !newer.items.length ? <p className="hint">{rich(M.noResultsForTryAnotherWord, null, { value0: newer.q })}</p> : null}
      {newer?.q && newer.items === null ? <p className="hint">{rich(M.searchDidNotRespondPasteA, null)}</p> : null}
    </>
  );
}

function KindForm({ k, p, primary, open }: { k: CorrectionKindOption; p: CorrectBlockProps; primary: boolean; open: boolean }) {
  const closes = k.kind === "own_note" && k.closed_result;
  let lead: ReactNode = <p className="hint">{CORRECTION_KIND_HINTS[k.kind]}</p>;
  if (closes) lead = <Notice tone="warn"><strong>{CORRECTIONS_COPY.closedResultWarning}</strong></Notice>;
  else if (k.kind === "own_note" && p.openKept) lead = <><p className="hint">{CORRECTION_KIND_HINTS[k.kind]}</p><p className="hint">{CORRECTIONS_COPY.openKeptHint}</p></>;
  return (
    <details className="correct-kind" open={open}>
      <summary>{correctionKindTitle(k.kind, p.type, p.eventKind)}</summary>
      {lead}
      {k.kind === "outdated" ? <NewerSearchForm id={p.id} newer={p.newer} /> : null}
      <ActionForm action={correctAction} submitLabel={M.saveCorrection} pendingLabel={M.saving} resetOnSuccess quiet={!primary}>
        <input type="hidden" name="id" value={p.id} />
        <input type="hidden" name="kind" value={k.kind} />
        <KindFields k={k} p={p} />
        {k.mode === "propose" ? <p className="hint corr-warn">{CORRECTIONS_COPY.proposeWarning}</p> : null}
      </ActionForm>
    </details>
  );
}

export function CorrectBlock(p: CorrectBlockProps) {
  const sorted = [...p.kinds].sort((a, b) => CORRECTION_KIND_ORDER.indexOf(a.kind) - CORRECTION_KIND_ORDER.indexOf(b.kind));
  let main = sorted.filter((k) => !OTHER_KINDS.has(k.kind)), other = sorted.filter((k) => OTHER_KINDS.has(k.kind));
  if (!main.length) { main = other; other = []; }
  const searching = Boolean(p.newer?.q);
  return (
    <details className="correct-block" id="correct" open={p.open || searching}>
      <summary>{rich(M.correct, null)}</summary>
      <p className="hint">{CORRECTIONS_COPY.correctLead}</p>
      {p.resetNotice ? <p className="hint corr-warn">{CORRECTIONS_COPY.meetingResetNotice}</p> : null}
      <div className="correct-kinds">
        {main.map((k, i) => <KindForm key={k.kind} k={k} p={p} primary={i === 0} open={main.length === 1 || (searching && k.kind === "outdated")} />)}
        {other.length ? (
          <details className="correct-other" open={searching}>
            <summary>{CORRECTIONS_COPY.otherKindsTitle}</summary>
            {other.map((k) => <KindForm key={k.kind} k={k} p={p} primary={false} open={searching && k.kind === "outdated"} />)}
          </details>
        ) : null}
      </div>
    </details>
  );
}
