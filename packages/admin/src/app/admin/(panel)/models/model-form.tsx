"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { models as t } from "@/messages/m-models";
import { modelAction } from "./actions";
import { candidateId, initialPolicy, roleSnapshot, type ModelResult, type ModelRoleView, type Policy, type Preset } from "./view";
import styles from "./models.module.css";

export function ModelFeedback({ pending, result }: { pending: boolean; result: ModelResult | null }) {
  return <div aria-live="polite" aria-atomic="true">
    {pending ? <p role="status">{t.working}</p> : result ? <div role={result.ok ? "status" : "alert"}>
      <p>{result.message}{result.code ? <> · <code>{result.code}</code></> : null}</p>
      {result.checks?.length ? <ul>{result.checks.map((check, i) => <li key={i}>
        <code>{check.id}</code> · <code>{check.code}</code>{check.latency_ms !== undefined ? <> · {t.latency(check.latency_ms)}</> : null}
      </li>)}</ul> : null}
      {result.approval ? <a href={result.approval}>{t.openApproval}</a> : null}
    </div> : null}
  </div>;
}

export function ModelForm({ role, presets }: { role: ModelRoleView; presets: Preset[] }) {
  const [result, action, pending] = useActionState(modelAction, null);
  const [preset, setPreset] = useState("");
  const [base, setBase] = useState(role.connection?.base_url ?? "");
  const [model, setModel] = useState(role.connection?.model ?? "");
  const [policy, setPolicy] = useState<Policy>(initialPolicy(role));
  const [confirmed, setConfirmed] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const options = presets.filter((p) => p.role === role.role);
  const id = `model-${role.role}`;
  const candidate = candidateId(preset, base, model);
  const changed = () => { setPolicy("none"); setConfirmed(false); };
  useEffect(() => {
    if (result?.saved && keyInput.current) keyInput.current.value = "";
  }, [result]);
  useEffect(() => {
    // A late probe cannot select permission for a different pair edited while it was running.
    if (result?.tested === candidate && result.suggested_policy) {
      setPolicy(result.suggested_policy); setConfirmed(false);
    }
  }, [result, candidate]);

  return <section className={styles.card} id={id} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{t.roles[role.role]}</h2>
    <p>{t.states[role.state]}</p>
    {role.connection?.legacy || role.legacy ? <p className="hint">{t.legacy}</p> : null}
    {role.role === "embeddings" && role.slot ? <p className="hint">{t.activeSlot(role.slot)}</p> : null}
    {/* Resolved Server Actions reset uncontrolled inputs even for Test or a refusal. Only a saved result clears the key. */}
    <form action={action} aria-busy={pending} onReset={(event) => event.preventDefault()}>
      <input type="hidden" name="role" value={role.role} />
      <input type="hidden" name="original" value={roleSnapshot(role)} />
      <fieldset disabled={pending} className={styles.fields}>
        <label htmlFor={`${id}-preset`}>{t.preset}</label>
        <select id={`${id}-preset`} name="preset" value={preset} required={!role.connection} onChange={(e) => {
          const selected = options.find((p) => p.id === e.target.value);
          setPreset(e.target.value); if (selected?.base_url) setBase(selected.base_url); changed();
        }}>
          <option value="">{t.custom}</option>
          {options.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
        <label htmlFor={`${id}-base`}>{t.address}</label>
        <input id={`${id}-base`} name="base_url" type="url" required maxLength={2048} value={base}
          onChange={(e) => { setBase(e.target.value); changed(); }} />
        <label htmlFor={`${id}-key`}>{t.key}</label>
        <input ref={keyInput} id={`${id}-key`} name="api_key" type="password" autoComplete="new-password" maxLength={16384}
          aria-describedby={`${id}-key-hint`} />
        <p id={`${id}-key-hint`} className="hint">{t.keyHint}</p>
        <label htmlFor={`${id}-model`}>{t.model}</label>
        <input id={`${id}-model`} name="model" required maxLength={2048} value={model}
          aria-describedby={`${id}-model-hint`} onChange={(e) => { setModel(e.target.value); changed(); }} />
        <p id={`${id}-model-hint`} className="hint">{t.manualHint}</p>
        <label htmlFor={`${id}-policy`}>{t.policy}</label>
        <select id={`${id}-policy`} name="policy" value={policy} aria-describedby={`${id}-policy-hint`}
          onChange={(e) => { setPolicy(e.target.value as Policy); setConfirmed(false); }}>
          {(["none", "open", "closed"] as const).map((p) => <option key={p} value={p}>{t.policies[p]}</option>)}
        </select>
        <p id={`${id}-policy-hint`} className="hint">{t.policyHint}</p>
        {policy === "closed" ? <label className={styles.confirm}>
          <input type="checkbox" name="confirm_closed" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span><strong>{t.confirmClosed}</strong><br />{t.closedHint}</span>
        </label> : null}
        <div className={styles.buttons}>
          <button type="submit" name="op" value="test" formNoValidate>{t.test}</button>
          <button type="submit" name="op" value="save">{t.save}</button>
        </div>
      </fieldset>
      <ModelFeedback pending={pending} result={result?.tested && result.tested !== candidate ? null : result} />
    </form>
  </section>;
}
