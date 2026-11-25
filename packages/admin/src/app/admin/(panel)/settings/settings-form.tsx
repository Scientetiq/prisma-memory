"use client";
import { FORM_TEXT } from "@/messages/settings-form";
import { startTransition, useActionState, useId, useMemo, useState, type FormEvent } from "react";
import { ResultBox, type FormAction } from "@/components/action-form";
import { ConfirmDialog, type ConfirmSpec } from "@/components/confirm-dialog";
import { DirtyGuard } from "@/components/dirty-guard";
import { Badge } from "@/components/ui";
import { clearControl, clearKeyQuestion, editorKind, emptiedQuestion, emptiedRequired, fieldClear, fieldConfirmClear, fieldMode, fieldOrig, fieldValue, NON_CLEARABLE, parseEditorValue,
         SETTINGS_VALUES_TEXT, secretEdgeSpace, secretInput, stableStringify, toEditorText, type EditorKind, type UnsetMode } from "@/lib/settings-values";

export interface SettingView {
  key: string; value: unknown; secret: boolean; required: boolean; description: string | null; isSet: boolean;
  label?: string; options?: ReadonlyArray<{ value: string; title: string }>; readOnly?: { href: string; page: string };
  policyClass?: "operational" | "anchored" | "policy" | "immutable";
  pinned?: boolean; dbDiffers?: boolean;
  weakenNeedsApproval?: boolean;
}

export function PolicyBadges({ i }: { i: Pick<SettingView, "policyClass" | "pinned" | "dbDiffers" | "weakenNeedsApproval"> }) {
  return (
    <>
      {i.pinned ? <Badge tone="violet" title={FORM_TEXT.pinnedHint}>{FORM_TEXT.pinned}</Badge>
        : i.policyClass === "anchored" ? <Badge tone="muted" title={FORM_TEXT.anchoredHint}>{FORM_TEXT.anchored}</Badge> : null}
      {i.dbDiffers ? <Badge tone="warn" title={FORM_TEXT.dbDiffersHint}>{FORM_TEXT.dbDiffers}</Badge> : null}
      {i.policyClass === "immutable" ? <Badge tone="muted" title={FORM_TEXT.immutableHint}>{FORM_TEXT.immutable}</Badge> : null}
      {i.weakenNeedsApproval ? <Badge tone="info" title={FORM_TEXT.approvalHint}>{FORM_TEXT.approval}</Badge> : null}
    </>
  );
}

const readText = (v: unknown): string => (v === null || v === undefined || v === "" ? FORM_TEXT.unset : typeof v === "string" ? v : typeof v === "boolean" ? (v ? FORM_TEXT.on : FORM_TEXT.off) : JSON.stringify(v));




interface FieldsProps {
  category: string; items: SettingView[]; pending: boolean; serverErrors: Record<string, string>; title: string;
  onClear?: (key: string, dirty: boolean) => void; clearing?: boolean;
}

function Fields({ category, items: all, pending, serverErrors, title, onClear, clearing }: FieldsProps) {
  const uid = useId();
  const items = useMemo(() => all.filter((i) => !i.readOnly), [all]);
  const kinds = useMemo(() => Object.fromEntries(items.map((i) => [i.key, editorKind(i)])) as Record<string, EditorKind>, [items]);
  const initial = useMemo(() => Object.fromEntries(items.map((i) => [i.key, toEditorText(kinds[i.key]!, i.value)])) as Record<string, string>, [items, kinds]);
  const [texts, setTexts] = useState<Record<string, string>>(initial);
  const [modes, setModes] = useState<Record<string, UnsetMode>>({});
  const [clears, setClears] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState<Record<string, true>>({});

  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const i of items) {
      const kind = kinds[i.key]!;
      if (kind === "secret") continue;
      const asJson = i.value === null && modes[i.key] === "json";
      const parsed = parseEditorValue(asJson ? "json" : kind, texts[i.key] ?? "", i.value);
      if (!parsed.ok) out[i.key] = parsed.error;
    }
    return out;
  }, [items, kinds, texts, modes]);
  const invalid = Object.keys(errors).length > 0;
  const dirty = items.some((i) => {
    const kind = kinds[i.key]!;
    return kind === "secret" ? secretInput(texts[i.key] ?? "") !== null || Boolean(clears[i.key]) : (texts[i.key] ?? "") !== initial[i.key];
  });
  const setText = (key: string, v: string) => { setTexts((t) => ({ ...t, [key]: v })); setTouched((t) => (t[key] ? t : { ...t, [key]: true })); };

  return (
    <>
      <DirtyGuard active={dirty} question={FORM_TEXT.dirtyQuestion} />
      {all.map((i) => {
        const label = i.label ?? i.key, id = `${uid}-${i.key}`, descId = i.description ? `${id}-desc` : undefined;
        if (i.readOnly) return (
          <div className="setting readonly" key={i.key} id={`set-${category}-${i.key}`}>
            <div>
              <div className="setting-label">{label}</div>
              <div className="setting-meta badges"><code className="code setting-key" title={FORM_TEXT.keyTitle}>{i.key}</code><PolicyBadges i={i} /></div>
            </div>
            <div className="setting-editor">
              <span className="setting-value">{readText(i.value)}</span>
              <a className="field-hint" href={i.readOnly.href}>{FORM_TEXT.readOnlyLink(i.readOnly.page)}</a>
            </div>
          </div>
        );
        const kind = kinds[i.key]!, name = fieldValue(i.key), text = texts[i.key] ?? "";
        const missing = i.required && !i.isSet;
        const error = errors[i.key] ?? (touched[i.key] ? undefined : serverErrors[i.key]);
        const changed = kind === "secret" ? secretInput(text) !== null || Boolean(clears[i.key]) : text !== initial[i.key];
        const asJson = kind === "json" || (i.value === null && modes[i.key] === "json");
        const errId = error ? `${id}-err` : undefined;
        const described = [descId, errId].filter(Boolean).join(" ") || undefined;
        const options = i.options && kind === "string" && !asJson
          ? (i.options.some((o) => o.value === text) || text === "" ? i.options : [...i.options, { value: text, title: text }]) : null;
        return (
          <div className={missing ? "setting missing" : "setting"} key={i.key} id={`set-${category}-${i.key}`}>
            <div>
              <label className="setting-label" htmlFor={id}>{label}</label>
              {i.description ? <div className="setting-desc" id={descId}>{i.description}</div> : null}
              <div className="setting-meta badges">
                <code className="code setting-key" title={FORM_TEXT.keyTitle}>{i.key}</code>
                {i.required ? <Badge tone="warn" title={FORM_TEXT.requiredTitle}>{FORM_TEXT.required}</Badge> : null}
                {i.secret ? <Badge tone="info" title={FORM_TEXT.secretTitle}>{FORM_TEXT.secret}</Badge> : null}
                {missing ? <Badge tone="danger">{FORM_TEXT.missing}</Badge> : null}
                {!missing && !i.isSet ? <Badge tone="muted">{FORM_TEXT.unset}</Badge> : null}
                {i.secret && i.isSet ? <Badge tone="ok">{FORM_TEXT.set}</Badge> : null}
                <PolicyBadges i={i} />
                {changed ? <Badge tone="neutral">{FORM_TEXT.changed}</Badge> : null}
              </div>
            </div>
            <div className="setting-editor">
              {kind === "secret" ? null : <input type="hidden" name={fieldOrig(name)} value={initial[i.key] ?? ""} />}
              {kind === "secret" ? (() => {
                const how = clearControl(`${category}.${i.key}`, i), locked = i.isSet && NON_CLEARABLE.has(`${category}.${i.key}`);
                return (
                  <>
                    <input type="password" id={id} name={locked ? undefined : name} value={text} onChange={(e) => setText(i.key, e.target.value)} autoComplete="new-password" spellCheck={false}
                      disabled={Boolean(clears[i.key]) || locked} placeholder={locked ? FORM_TEXT.set : i.isSet ? FORM_TEXT.setKeep : FORM_TEXT.unsetEnter} aria-describedby={described} />
                    {clears[i.key] ? <input type="hidden" name={name} value="" /> : null}
                    {secretInput(text) !== null ? <span className="field-hint">{FORM_TEXT.replaceHint}</span> : null}
                    {secretEdgeSpace(text) ? <span className="field-hint warn-text">{SETTINGS_VALUES_TEXT.secretEdgeSpaceHint}</span> : null}
                    {how === "checkbox" ? (
                      <label className="check small">
                        <input type="checkbox" name={fieldClear(i.key)} checked={Boolean(clears[i.key])} onChange={(e) => setClears((c) => ({ ...c, [i.key]: e.target.checked }))} />
                        {FORM_TEXT.clearSaved}</label>
                    ) : null}
                    {how === "button" && onClear ? (
                      <div className="setting-row">
                        <button type="button" className="btn danger sm" disabled={pending || clearing} onClick={() => onClear(i.key, dirty)}>{FORM_TEXT.clearKeyButton}</button>
                        <span className="field-hint">{FORM_TEXT.clearRequiredHint}</span>
                      </div>
                    ) : null}
                    {locked ? <span className="field-hint">{FORM_TEXT.lockedHint}</span> : null}
                  </>
                );
              })() : kind === "boolean" ? (
                <select id={id} name={name} value={text} onChange={(e) => setText(i.key, e.target.value)} aria-describedby={described}>
                  <option value="true">{FORM_TEXT.on}</option>
                  <option value="false">{FORM_TEXT.off}</option>
                </select>
              ) : options ? (
                <select id={id} name={name} value={text} onChange={(e) => setText(i.key, e.target.value)} aria-describedby={described} aria-invalid={error ? true : undefined}>
                  {text === "" && !options.some((o) => o.value === "") ? <option value="">{FORM_TEXT.unset}</option> : null}
                  {options.map((o) => <option key={o.value} value={o.value}>{o.title}</option>)}
                </select>
              ) : asJson ? (
                <div className={i.value === null ? "setting-row" : undefined}>
                  <textarea id={id} name={name} value={text} onChange={(e) => setText(i.key, e.target.value)} rows={Math.min(16, Math.max(3, text.split("\n").length + 1))}
                    spellCheck={false} aria-invalid={error ? true : undefined} aria-describedby={described} placeholder={FORM_TEXT.jsonPlaceholder} />
                  {i.value === null ? <ModeSelect k={i.key} label={label} mode="json" onChange={(m) => setModes((s) => ({ ...s, [i.key]: m }))} /> : null}
                </div>
              ) : kind === "string" && i.key === "ca_cert" ? (
                <textarea id={id} name={name} value={text} onChange={(e) => setText(i.key, e.target.value)} rows={Math.min(16, Math.max(6, text.split("\n").length + 1))}
                  spellCheck={false} aria-invalid={error ? true : undefined} aria-describedby={described} placeholder={FORM_TEXT.certificatePlaceholder} />
              ) : (
                <div className={i.value === null ? "setting-row" : undefined}>
                  <input type="text" id={id} name={name} value={text} onChange={(e) => setText(i.key, e.target.value)} inputMode={kind === "number" ? "decimal" : undefined}
                    spellCheck={false} aria-invalid={error ? true : undefined} aria-describedby={described} placeholder={kind === "number" ? FORM_TEXT.numberPlaceholder : FORM_TEXT.stringPlaceholder} />
                  {i.value === null ? <ModeSelect k={i.key} label={label} mode="string" onChange={(m) => setModes((s) => ({ ...s, [i.key]: m }))} /> : null}
                </div>
              )}
              {error ? <span className="field-error" role="alert" id={errId}>{error}</span> : null}
            </div>
          </div>
        );
      })}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending || invalid}>{pending ? FORM_TEXT.saving : FORM_TEXT.saveCategory(title)}</button>
        {invalid ? <span className="danger-text">{FORM_TEXT.invalid}</span> : null}
      </div>
    </>
  );
}

function ModeSelect({ k, label, mode, onChange }: { k: string; label: string; mode: UnsetMode; onChange: (m: UnsetMode) => void }) {
  return (
    <select className="mode" name={fieldMode(k)} value={mode} onChange={(e) => onChange(e.target.value as UnsetMode)} aria-label={FORM_TEXT.valueType(label)}>
      <option value="string">{FORM_TEXT.stringMode}</option>
      <option value="json">JSON</option>
    </select>
  );
}

const noAction: FormAction = async () => null;

export function SettingsForm({ category, title, items, action, clearAction }: { category: string; title: string; items: SettingView[]; action: FormAction; clearAction?: FormAction }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [cleared, clearFormAction, clearing] = useActionState(clearAction ?? noAction, null);
  const signature = `${state?.ok ? state.at : 0}:${stableStringify(items.map((i) => [i.key, i.value, i.isSet]))}`;
  const [asking, setAsking] = useState<{ spec: ConfirmSpec; run: () => void } | null>(null);
  const labelOf = (key: string): string => items.find((i) => i.key === key)?.label ?? key;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const emptied = emptiedRequired(items.filter((i) => !i.readOnly), (k) => data.get(fieldValue(k)));
    if (!emptied.length) return startTransition(() => formAction(data));
    setAsking({
      spec: { question: emptiedQuestion(emptied.map(labelOf)), verb: FORM_TEXT.saveEmpty, danger: true },
      run: () => {
        for (const k of emptied) data.set(fieldConfirmClear(k), "on");
        startTransition(() => formAction(data));
      },
    });
  }

  function onClear(key: string, dirty: boolean) {
    setAsking({
      spec: { question: clearKeyQuestion(labelOf(key), dirty), verb: FORM_TEXT.clearKey, danger: true },
      run: () => {
        const data = new FormData();
        data.set("category", category);
        data.set("key", key);
        startTransition(() => clearFormAction(data));
      },
    });
  }

  function onConfirm() {
    const run = asking?.run;
    setAsking(null);
    run?.();
  }

  return (
    <form action={formAction} onSubmit={onSubmit} className="form" autoComplete="off" data-dirty-owner="1">
      <input type="hidden" name="category" value={category} />
      <Fields key={signature} category={category} items={items} pending={pending} serverErrors={state?.fieldErrors ?? {}} title={title}
        onClear={clearAction ? onClear : undefined} clearing={clearing} />
      <ResultBox state={state} />
      <ResultBox state={cleared} />
      <ConfirmDialog spec={asking?.spec ?? null} onCancel={() => setAsking(null)} onConfirm={onConfirm} />
    </form>
  );
}
