"use client";
import { SECTION_SETTINGS_FORM_TEXT } from "../messages/components";
export { SECTION_SETTINGS_FORM_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";

import { derived } from "../i18n/runtime";
import { startTransition, useActionState, useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ResultBox, type FormAction } from "@/components/action-form";
import { DirtyGuard } from "@/components/dirty-guard";
import { Badge } from "@/components/ui";
import { fieldCategory, LDAP_CLEAR_SECRET, LDAP_ENABLED, LDAP_GROUPS, ldapFieldText, ldapFormProblems, ldapFormValues, ldapInput, parseLdapField, SMTP_SECURITY_MODES, TLS_MODES, type LdapField } from "@/lib/ldap-form";
import { SECRET_ANCHORS, secretAnchorProblem, type SecretAnchor } from "@/lib/secret-anchors";
import { OIDC_CLEAR_SECRET, OIDC_ENABLED, OIDC_GROUPS, oidcFormProblems, oidcFormValues, oidcInput } from "@/lib/oidc-form";
import { emitSettings, SETTINGS_DIRTY_EVENT, SETTINGS_SAVED_EVENT } from "@/lib/settings-events";
import { SMTP_CLEAR_SECRET, SMTP_ENABLED, SMTP_GROUPS, smtpFormProblems, smtpFormValues, smtpInput, smtpPortAdvice, smtpPortOnModeChange } from "@/lib/smtp-form";
import { fieldOrig, SETTINGS_VALUES_TEXT, secretEdgeSpace, stableStringify } from "@/lib/settings-values";

export interface SectionSettingView { key: string; category: string; value: unknown; secret: boolean; isSet: boolean; description: string | null }

type Get = (key: string) => string | null;
interface SectionSpec {
  enabled: LdapField; groups: Array<{ title: string; hint?: string; fields: LdapField[] }>; input: (key: string) => string; clearSecret: string;
  secretKey: string; secretHint: string; secretClear: string; problems: (get: Get, secretSet: boolean) => Record<string, string>;
  save: string; dirty: string;
  inpage?: string;
  needed: readonly string[];
  mode?: { key: string; fallback: string; insecure: string };
  anchor?: SecretAnchor;
}

export const OIDC_SECRET_ANCHOR: SecretAnchor = SECRET_ANCHORS.oidc;
export { secretAnchorProblem };



export const blankValue = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

export function fieldExample(f: Pick<LdapField, "placeholder">): { pem: boolean; parts: string[] } | null {
  if (!f.placeholder) return null;
  if (f.placeholder.startsWith("-----BEGIN")) return { pem: true, parts: [] };
  return { pem: false, parts: f.placeholder.split("\n").map((x) => x.trim()).filter(Boolean) };
}

const SECTIONS = derived((): Record<"ldap" | "oidc" | "smtp", SectionSpec> => ({
  ldap: { enabled: LDAP_ENABLED, groups: LDAP_GROUPS, input: ldapInput, clearSecret: LDAP_CLEAR_SECRET, secretKey: "bind_password",
          secretHint: SECTION_SETTINGS_FORM_TEXT.ldapPasswordHint, secretClear: SECTION_SETTINGS_FORM_TEXT.clearPassword,
          problems: (get: Get, secretSet: boolean) => ldapFormProblems(ldapFormValues(get, secretSet)), save: SECTION_SETTINGS_FORM_TEXT.saveLogin,
          dirty: SECTION_SETTINGS_FORM_TEXT.dirtyLogin,
          inpage: SECTION_SETTINGS_FORM_TEXT.checkSavedFirst, needed: ["servers", "bind_dn", "base_dn", "login_groups"],
          mode: { key: "tls_mode", fallback: "ldaps", insecure: SECTION_SETTINGS_FORM_TEXT.ldapInsecure }, anchor: SECRET_ANCHORS.ldap },
  oidc: { enabled: OIDC_ENABLED, groups: OIDC_GROUPS, input: oidcInput, clearSecret: OIDC_CLEAR_SECRET, secretKey: "client_secret",
          secretHint: SECTION_SETTINGS_FORM_TEXT.oidcSecretHint, secretClear: SECTION_SETTINGS_FORM_TEXT.clearSecret,
          problems: (get: Get, secretSet: boolean) => oidcFormProblems(oidcFormValues(get, secretSet)), save: SECTION_SETTINGS_FORM_TEXT.saveSso,
          dirty: SECTION_SETTINGS_FORM_TEXT.dirtySso,
          inpage: SECTION_SETTINGS_FORM_TEXT.checkSavedFirst, needed: ["issuer", "client_id", "redirect_uri", "login_groups"],
          anchor: OIDC_SECRET_ANCHOR },
  smtp: { enabled: SMTP_ENABLED, groups: SMTP_GROUPS, input: smtpInput, clearSecret: SMTP_CLEAR_SECRET, secretKey: "password",
          secretHint: SECTION_SETTINGS_FORM_TEXT.smtpPasswordHint, secretClear: SECTION_SETTINGS_FORM_TEXT.clearPassword,
          problems: (get: Get, secretSet: boolean) => smtpFormProblems(smtpFormValues(get, secretSet)), save: SECTION_SETTINGS_FORM_TEXT.saveMail,
          dirty: SECTION_SETTINGS_FORM_TEXT.dirtyMail,
          needed: ["host", "from_address"],
          mode: { key: "security", fallback: "starttls", insecure: SECTION_SETTINGS_FORM_TEXT.smtpInsecure }, anchor: SECRET_ANCHORS.smtp },
}));
export type SettingsSectionKind = keyof typeof SECTIONS;

export function SectionSettingsForm({ section, items, action, suggest }: { section: SettingsSectionKind; items: SectionSettingView[]; action: FormAction; suggest?: Record<string, string> }) {
  const [state, formAction, pending] = useActionState(action, null);
  const signature = `${state?.ok ? state.at : 0}:${stableStringify(items.map((i) => [i.key, i.value, i.isSet]))}`;
  useEffect(() => { if (state) emitSettings(SETTINGS_SAVED_EVENT, { section, ok: state.ok }); }, [state, section]);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  }
  return (
    <form action={formAction} onSubmit={onSubmit} className="form" autoComplete="off" data-dirty-owner="1" data-settings-section={section}>
      <Fields key={signature} section={section} items={items} pending={pending} errors={state?.fieldErrors ?? {}} suggest={suggest ?? {}} />
      <ResultBox state={state} />
    </form>
  );
}

function Fields({ section, items, pending, errors, suggest }: { section: SettingsSectionKind; items: SectionSettingView[]; pending: boolean; errors: Record<string, string>; suggest: Record<string, string> }) {
  const spec = SECTIONS[section];
  const uid = useId();
  const byKey = new Map(items.map((i) => [i.key, i]));
  const [mode, setMode] = useState(spec.mode ? String(byKey.get(spec.mode.key)?.value ?? spec.mode.fallback) : "");
  const [dirty, setDirty] = useState(false);
  const [clear, setClear] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [secretText, setSecretText] = useState("");
  const [advice, setAdvice] = useState<string | null>(() => section === "smtp" ? smtpPortAdvice(mode, Number(byKey.get("port")?.value)) : null);
  const box = useRef<HTMLDivElement>(null);
  const idOf = (f: LdapField) => `${uid}-${f.key}`;
  useEffect(() => { emitSettings(SETTINGS_DIRTY_EVENT, { section, dirty }); }, [section, dirty]);
  const has = (f: LdapField) => byKey.has(f.key);
  const secretSet = byKey.get(spec.secretKey)?.isSet === true && !clear;
  const saved = useMemo(() => new Map(items.map((i) => [i.key, i.value])), [items]);
  const kinds = useMemo(() => new Map([spec.enabled, ...spec.groups.flatMap((g) => g.fields)].map((f) => [f.key, f.kind])), [spec]);
  const recheck = useCallback(() => {
    const form = box.current?.closest("form");
    if (!form) return;
    const fd = new FormData(form);
    const get: Get = (k) => { const v = fd.get(spec.input(k)); return typeof v === "string" ? v : null; };
    const found = spec.problems(get, secretSet);
    const shown = new Set(fd.getAll("fields").map(String));
    const typed = (k: string): unknown => {
      const f = kinds.get(k);
      if (!f || !shown.has(k)) return undefined;
      const p = parseLdapField(f, get(k));
      return p.ok ? p.value : undefined;
    };
    const anchor = spec.anchor && !found[spec.secretKey] ? secretAnchorProblem(spec.anchor, (k) => saved.get(k), typed, secretSet, get(spec.secretKey)) : null;
    setProblems(anchor ? { ...found, [spec.secretKey]: anchor } : found);
    if (section === "smtp") setAdvice(smtpPortAdvice(get("security") ?? "", Number(get("port") ?? "")));
  }, [secretSet, spec, saved, kinds, section]);
  useEffect(recheck, [recheck, mode]);

  const onModeChange = (next: string) => {
    if (section === "smtp") {
      const port = box.current?.closest("form")?.elements.namedItem(spec.input("port"));
      if (port instanceof HTMLInputElement) { const p = smtpPortOnModeChange(port.value, next); if (p !== null) port.value = p; }
    }
    setMode(next);
  };

  const control = (f: LdapField, id: string, describedBy: string | undefined) => {
    const item = byKey.get(f.key)!, name = spec.input(f.key), text = ldapFieldText(f.kind, item.value), err = problems[f.key] ?? errors[f.key];
    const invalid = err ? true : undefined;
    switch (f.kind) {
      case "bool":
        return <label className="check" htmlFor={id}><input type="checkbox" id={id} name={name} defaultChecked={item.value === true} aria-describedby={describedBy} />{f.label}</label>;
      case "tls":
      case "smtp_security":
        return (
          <select id={id} name={name} defaultValue={mode} onChange={(e) => onModeChange(e.target.value)} aria-invalid={invalid} aria-describedby={describedBy}>
            {(f.kind === "tls" ? TLS_MODES : SMTP_SECURITY_MODES).map((m) => <option key={m.value} value={m.value}>{m.title}</option>)}
          </select>
        );
      case "secret":
        return (
          <>
            <input type="password" id={id} name={name} autoComplete="new-password" spellCheck={false} disabled={clear} aria-invalid={invalid} aria-describedby={describedBy}
              placeholder={item.isSet ? SECTION_SETTINGS_FORM_TEXT.setKeep : SECTION_SETTINGS_FORM_TEXT.notSet} onChange={(e) => setSecretText(e.target.value)} />
            {secretEdgeSpace(secretText) && !clear ? <span className="field-hint warn-text">{SETTINGS_VALUES_TEXT.secretEdgeSpaceHint}</span> : null}
            {item.isSet ? (
              <label className="check small"><input type="checkbox" name={spec.clearSecret} checked={clear} onChange={(e) => { setClear(e.target.checked); setDirty(true); }} />{spec.secretClear}</label>
            ) : null}
          </>
        );
      case "hosts":
      case "lines":
      case "multiline":
      case "json":
        return <textarea id={id} name={name} defaultValue={text} rows={Math.min(12, Math.max(f.kind === "json" ? 6 : 3, text.split("\n").length + 1))} spellCheck={false} aria-invalid={invalid} aria-describedby={describedBy} />;
      case "number":
        return <input type="text" id={id} name={name} defaultValue={text} inputMode="decimal" spellCheck={false} aria-invalid={invalid} aria-describedby={describedBy} />;
      case "text":
        return <input type="text" id={id} name={name} defaultValue={text} spellCheck={false} aria-invalid={invalid} aria-describedby={describedBy} />;
    }
  };

  const notes = (f: LdapField, id: string): { ids: string[]; nodes: ReactNode } => {
    const example = fieldExample(f), own = suggest[f.key], ids: string[] = [];
    const nodes: ReactNode[] = [];
    if (f.hint) { ids.push(`${id}-hint`); nodes.push(<span className="field-hint" id={`${id}-hint`} key="hint">{f.hint}</span>); }
    if (own) {
      ids.push(`${id}-own`);
      nodes.push(<span className="field-hint field-example" id={`${id}-own`} key="own">{rich(SECTION_SETTINGS_FORM_TEXT.workspaceValue, null, { value1: <code className="code">{own}</code> })}</span>);
    } else if (example) {
      ids.push(`${id}-ex`);
      nodes.push(example.pem
        ? <span className="field-hint field-example" id={`${id}-ex`} key="ex">{rich(SECTION_SETTINGS_FORM_TEXT.pemFormat, null, { value1: <code className="code">-----BEGIN CERTIFICATE-----</code>, value2: <code className="code">-----END CERTIFICATE-----</code> })}</span>
        : <span className="field-hint field-example" id={`${id}-ex`} key="ex">{rich(SECTION_SETTINGS_FORM_TEXT.example, null, { value1: example.parts.map((p, n) => <span key={p}>{n ? " " : ""}<code className="code">{p}</code></span>) })}</span>);
    }
    if (f.key === "port" && advice) { ids.push(`${id}-adv`); nodes.push(<span className="field-hint warn-text" id={`${id}-adv`} key="adv" role="status">{advice}</span>); }
    return { ids, nodes };
  };

  const field = (f: LdapField) => {
    if (!has(f)) return null;
    const item = byKey.get(f.key)!, id = idOf(f);
    const err = problems[f.key] ?? errors[f.key], errId = err ? `${id}-err` : undefined;
    const wide = f.kind !== "number" && f.kind !== "tls" && f.kind !== "smtp_security" && f.kind !== "text" && f.kind !== "secret";
    const orig = f.kind === "secret" ? null : <input type="hidden" name={fieldOrig(spec.input(f.key))} value={ldapFieldText(f.kind, item.value)} />;
    if (f.key === "insecure_ack" && spec.mode) {
      if (mode !== "none") return null;
      const [head, ...rest] = spec.mode.insecure.split(". ");
      return (
        <div className="field field-wide" key={f.key}>
          <input type="hidden" name="fields" value={f.key} />
          {orig}
          <div className="insecure" role="alert">
            <p><strong>{head}.</strong> {rest.join(". ")}</p>
            {control(f, id, errId)}
          </div>
          {err ? <span className="field-error" role="alert" id={errId}>{err}</span> : null}
        </div>
      );
    }
    const { ids, nodes } = notes(f, id);
    const describedBy = [...ids, ...(errId ? [errId] : [])].join(" ") || undefined;
    const empty = spec.needed.includes(f.key) && blankValue(item.value);
    return (
      <div className={wide ? "field field-wide" : "field"} key={f.key}>
        <input type="hidden" name="fields" value={f.key} />
        {orig}
        {f.kind === "bool" ? null : (
          <label className="field-label" htmlFor={id}>{f.label}
            {f.kind === "secret" ? <> {item.isSet ? <Badge tone="ok">{SECTION_SETTINGS_FORM_TEXT.set}</Badge> : <Badge tone="muted">{SECTION_SETTINGS_FORM_TEXT.notSet}</Badge>}</> : null}
            {empty ? <> <Badge tone="muted" title={SECTION_SETTINGS_FORM_TEXT.requiredHint}>{SECTION_SETTINGS_FORM_TEXT.missing}</Badge></> : null}
          </label>
        )}
        {control(f, id, describedBy)}
        {nodes}
        {f.kind === "secret" && !item.isSet ? <span className="field-hint">{spec.secretHint}</span> : null}
        {err ? <span className="field-error" role="alert" id={errId}>{err}</span> : null}
        <span className="field-hint"><code className="code">{`${fieldCategory(f)}.${f.key}`}</code></span>
      </div>
    );
  };

  const enabledSwitch = () => {
    const f = spec.enabled;
    if (!has(f)) return null;
    const item = byKey.get(f.key)!, id = idOf(f), err = problems[f.key] ?? errors[f.key];
    const describedBy = [f.hint ? `${id}-hint` : "", err ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
    return (
      <div className="field field-wide enable-row">
        <input type="hidden" name="fields" value={f.key} />
        <input type="hidden" name={fieldOrig(spec.input(f.key))} value={ldapFieldText("bool", item.value)} />
        <label className="switch" htmlFor={id}>
          <input type="checkbox" role="switch" id={id} name={spec.input(f.key)} defaultChecked={item.value === true} aria-describedby={describedBy} />
          <span>{f.label}{f.hint ? <span className="switch-sub" id={`${id}-hint`}>{f.hint}</span> : null}</span>
        </label>
        {err ? <span className="field-error" role="alert" id={`${id}-err`}>{err}</span> : null}
      </div>
    );
  };

  return (
    <div ref={box} onChange={() => { setDirty(true); recheck(); }} onInput={recheck}>
      <DirtyGuard active={dirty} question={spec.dirty} inpage={spec.inpage} />
      {spec.groups.map((g) => g.fields.some(has) ? (
        <fieldset className="ldap-group" key={g.title}>
          <legend>{g.title}</legend>
          {g.hint ? <p className="hint">{g.hint}</p> : null}
          <div className="form-grid">{g.fields.map(field)}</div>
        </fieldset>
      ) : null)}
      {enabledSwitch()}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending || Object.keys(problems).length > 0}>{pending ? SECTION_SETTINGS_FORM_TEXT.saving : spec.save}</button>
        {Object.keys(problems).length ? <span className="danger-text">{SECTION_SETTINGS_FORM_TEXT.invalidFields}</span>
          : dirty ? <span className="muted small">{spec.inpage ? SECTION_SETTINGS_FORM_TEXT.checksUseSaved : SECTION_SETTINGS_FORM_TEXT.mailSavesFirst}</span> : null}
      </div>
    </div>
  );
}
