"use client";
import { derivedList } from "@/i18n/runtime";
import { peopleUploadForms } from "@/messages/panel-people";
import { rich } from "@/i18n/rich";
// Upload forms of the org table and the org units: the text is pasted or read from a file, the parse is shown at once
// (by the module the server uses too). A file that is not UTF-8 is read in the configured legacy code page.
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ActionForm, type FormAction } from "@/components/action-form";
import { formatDecimal } from "@/i18n/format";
import { CUSTODY_VIEW_TEXT, REACTIVATION_FIELD } from "@/lib/custody-view";
import { deactivationEffects } from "@/lib/labels";
import { DEFAULT_LEGACY_CHARSET, decodeUploadText, type LegacyCharset } from "@/lib/legacy-charset";
import { parseOrgUnitsUpload, parsePeopleUpload, type ParsedUpload, type PeopleBody, type PersonInput } from "@/lib/people-csv";
import type { DeactivationPreview } from "@/lib/types";
import type { DeactivationPreviewState } from "./actions";

async function readTextFile(file: File, legacy: LegacyCharset): Promise<string> {
  return decodeUploadText(await file.arrayBuffer(), legacy);
}

function Preview({ parsed }: { parsed: ParsedUpload<unknown> | null }) {
  if (!parsed || parsed.format === "empty") return null;
  const format = parsed.format === "csv" ? "CSV" : "JSON";
  if (parsed.body) {
    return (
      <div className="notice info" role="status">{rich(peopleUploadForms.parsedAsRowsReadyToSend, {  }, { value0: format, value1: parsed.rows, value2: parsed.warnings.length ? <ul className="lines">{parsed.warnings.slice(0, 10).map((w, i) => <li key={i}>{w}</li>)}</ul> : null })}</div>
    );
  }
  return (
    <div className="notice warn" role="alert">{rich(peopleUploadForms.parsingAsFoundErrorsFixThemBefore, {  }, { value0: format, value1: parsed.errors.length })}<ul className="lines">{parsed.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}</ul>
    </div>
  );
}

function PayloadField<B>({ parse, placeholder, accept, rows, onParsed, legacyCharset = DEFAULT_LEGACY_CHARSET }: { parse: (text: string) => ParsedUpload<B>; placeholder: string; accept: string; rows: number;
  legacyCharset?: LegacyCharset;
  onParsed?: (parsed: ParsedUpload<B> | null) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [parsed, setParsedState] = useState<ParsedUpload<B> | null>(null);
  const [fileNote, setFileNote] = useState("");
  const setParsed = (p: ParsedUpload<B> | null) => { setParsedState(p); onParsed?.(p); };

  const onText = (e: ChangeEvent<HTMLTextAreaElement>) => setParsed(e.target.value.trim() ? parse(e.target.value) : null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !area.current) return;
    if (file.size > 6 * 1024 * 1024) { setFileNote(peopleUploadForms.theFileIsLargerThanMBSplit); return; }
    const text = await readTextFile(file, legacyCharset);
    area.current.value = text;
    setParsed(text.trim() ? parse(text) : null);
    setFileNote(peopleUploadForms.fileRead(file.name));
  }

  return (
    <>
      <label className="field field-wide">
        <span className="field-label">{peopleUploadForms.uploadText}</span>
        <textarea ref={area} name="payload" rows={rows} onChange={onText} placeholder={placeholder} spellCheck={false} required />
      </label>
      <div className="form-row">
        <label className="btn">{rich(peopleUploadForms.readFromFile, {  }, { value0: <input type="file" accept={accept} onChange={onFile} hidden /> })}</label>
        {fileNote ? <span className="muted">{fileNote}</span> : null}
      </div>
      <Preview parsed={parsed} />
    </>
  );
}



const SAMPLE_NAMES = 5;

export function deactivationSummary(p: DeactivationPreview): string {
  const names = p.sample.slice(0, SAMPLE_NAMES).map((x) => x.display_name || x.login);
  return peopleUploadForms.deactivationSummary(p.will_deactivate, p.active_total, names, p.will_deactivate - names.length,
    Boolean(p.needs_confirmation), `${formatDecimal(Math.round((p.share ?? 0.2) * 1000) / 10)}%`);
}

type Count = { state: "idle" | "loading" } | { state: "ok"; data: DeactivationPreview } | { state: "fail"; message: string };

export function deactivationConfirm(count: Count, effects: string = deactivationEffects()): string {
  const head = count.state === "ok" ? deactivationSummary(count.data)
    : peopleUploadForms.everyoneMissingFromThisUploadWillBe(count.state === "fail" ? peopleUploadForms.theCountCouldNotBeCalculated : peopleUploadForms.theCountIsStillBeingCalculated);
  return peopleUploadForms.continue(head, effects);
}

const UPLOAD_ASKS = derivedList(() => ([
  { name: "confirm_deactivations", label: peopleUploadForms.yesDeactivateICheckedTheFile },
  { name: REACTIVATION_FIELD, label: CUSTODY_VIEW_TEXT.reactivationAskLabel },
] as const));

export function PeopleUploadForm({ action, preview, effects, legacyCharset }: { action: FormAction; preview: (people: Array<Pick<PersonInput, "login" | "employee_id" | "active">>) => Promise<DeactivationPreviewState>;
  /** Code page of a file that is not UTF-8 (locale.legacy_charset). */
  legacyCharset?: LegacyCharset;
  effects?: string }) {
  const [deactivate, setDeactivate] = useState(false);
  const [body, setBody] = useState<PeopleBody | null>(null);
  const [count, setCount] = useState<Count>({ state: "idle" });
  const [edits, setEdits] = useState(0);

  useEffect(() => {
    if (!deactivate || !body) { setCount({ state: "idle" }); return; }
    let stale = false;
    setCount({ state: "loading" });
    const timer = setTimeout(() => {
      preview(body.people.map((p) => ({ login: p.login, employee_id: p.employee_id ?? (p.attrs?.employee_id as string | undefined), active: p.active })))
        .then((r) => { if (!stale) setCount(r.ok ? { state: "ok", data: r.data } : { state: "fail", message: r.message }); })
        .catch(() => { if (!stale) setCount({ state: "fail", message: peopleUploadForms.theGatewayDidNotRespond }); });
    }, 400);
    return () => { stale = true; clearTimeout(timer); };
  }, [deactivate, body, preview]);

  return (
    <ActionForm action={action} submitLabel={peopleUploadForms.uploadOrgTable} pendingLabel={peopleUploadForms.uploading} confirm={deactivate ? deactivationConfirm(count, effects) : undefined}
      ask={UPLOAD_ASKS} askEpoch={edits}>
      <PayloadField parse={parsePeopleUpload} placeholder={peopleUploadForms.loginDisplayNameEmployeeIdDepartmentDepartment} accept=".csv,.tsv,.txt,.json,text/csv,application/json" rows={9} legacyCharset={legacyCharset}
        onParsed={(p) => { setBody(p?.body ?? null); setEdits((n) => n + 1); }} />
      <label className="check check-row">{rich(peopleUploadForms.deactivateEveryoneMissingFromThisUploadDeactivate, { code0: (children) => <code className="code">{children}</code> }, { value0: <input type="checkbox" name="deactivate_missing" checked={deactivate} onChange={(e) => setDeactivate(e.target.checked)} /> })}</label>
      {deactivate && body ? (
        <p className={count.state === "ok" && count.data.will_deactivate ? `notice ${count.data.needs_confirmation ? "danger" : "warn"}` : "hint"} role="status">
          {count.state === "ok" ? deactivationSummary(count.data) : count.state === "fail" ? peopleUploadForms.couldNotCalculateHowManyPeopleThe(count.message) : peopleUploadForms.calculatingHowManyPeopleTheUploadWill}
        </p>
      ) : null}
    </ActionForm>
  );
}



export function OrgUnitsUploadForm({ action, legacyCharset }: { action: FormAction; legacyCharset?: LegacyCharset }) {
  return (
    <ActionForm action={action} submitLabel={peopleUploadForms.uploadOrgUnits} pendingLabel={peopleUploadForms.uploading}>
      <PayloadField parse={parseOrgUnitsUpload} placeholder={peopleUploadForms.message} accept=".json,.txt,application/json" rows={7} legacyCharset={legacyCharset} />
    </ActionForm>
  );
}
