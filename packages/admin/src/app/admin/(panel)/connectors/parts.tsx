import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { configFields } from "@/lib/connector-form";
import { explainConnectorError } from "@/lib/connector-errors";
import type { ConnectorOptions } from "@/lib/connector-options";
import type { ConnectorKind, ConnectorView } from "@/lib/connectors";
import { connectors as M } from "@/messages/connectors";
import { ConnectorForm } from "./forms";
import { connectorAction } from "./actions";

export function State({ code }: { code: string }) {
  return <span className="badge">{Object.hasOwn(M.states, code) ? M.states[code as keyof typeof M.states] : code}</span>;
}
export function Reason({ code }: { code: string | null | undefined }) {
  if (!code) return <span className="muted">{M.none}</span>;
  const r = explainConnectorError(code);
  return <div><code>{/^[a-z][a-z0-9_:]{0,63}$/.test(code) ? code : "internal"}</code><p>{r.text}</p><p>{r.action}</p></div>;
}
export function Summary({ connector: c, kind, options }: { connector: ConnectorView; kind?: ConnectorKind; options?: ConnectorOptions }) {
  const target = options?.spaces.find((s) => s.id === c.target_space_id);
  return <div>
    <p><State code={c.status} /> <code>{c.kind}</code> {c.pack ? <code>{c.pack}</code> : null}</p>
    {kind?.verified === "mock_only" ? <p className="notice warn">{M.notVerified}</p> : null}
    <dl>
      <dt>{M.destination}</dt><dd>{target ? <Link href={`/admin/spaces/${target.slug}`}>{target.name}</Link> : <code>{c.target_space_id ?? (c.owner ? M.personalDestination : M.entityDestination)}</code>}
        <p>{c.data_class === "closed" || target?.default_class === "closed" ? M.closed : target?.default_class === "open" ? M.openRecords : M.spaceClass}</p></dd>
      <dt>{M.runAs}</dt><dd>{c.owner ? <>{c.owner.name} <code>{c.owner.login}</code><p>{M.sharedBudget}</p></> : M.noOwner}</dd>
      <dt>{M.lastRun}</dt><dd><LocalTime iso={c.last_run_at} relative={false} /></dd>
      <dt>{M.nextRun}</dt><dd><LocalTime iso={c.next_run_at} relative={false} /></dd>
      <dt>{M.lastOk}</dt><dd><LocalTime iso={c.last_ok_at} relative={false} /></dd>
      {c.last_error ? <><dt>{M.lastError}</dt><dd><Reason code={c.last_error} /></dd></> : null}
    </dl>
  </div>;
}

export function ConfigFields({ kind, connector }: { kind: ConnectorKind; connector?: ConnectorView }) {
  return <fieldset><legend>{M.configure}</legend>{configFields(kind.config, connector?.config).map((f) => <label key={f.name}>
    {f.label}
    {f.options || f.type === "boolean" ? <select name={`config.${f.name}`} defaultValue={f.value} required={f.required}>
      {!f.required ? <option value="">{M.optional}</option> : null}
      {(f.options ?? ["true", "false"]).map((v) => <option key={v} value={v}>{f.type === "boolean" ? v === "true" ? M.trueValue : M.falseValue : v}</option>)}
    </select> : f.type === "object" || f.type === "array" ? <textarea name={`config.${f.name}`} defaultValue={f.value} required={f.required} maxLength={65_536} rows={4} />
      : <input name={`config.${f.name}`} type={f.type === "integer" || f.type === "number" ? "number" : "text"} step={f.type === "integer" ? 1 : "any"}
          defaultValue={f.value} required={f.required} min={f.minimum} max={f.maximum} minLength={f.minLength} maxLength={f.maxLength ?? 65_536} />}
    {f.description ? <span className="muted small">{f.description}</span> : null}
    {f.type === "object" || f.type === "array" ? <span className="muted small">{M.jsonHint}</span> : null}
  </label>)}</fieldset>;
}

export function DestinationFields({ kind, connector: c, options }: { kind: ConnectorKind; connector?: ConnectorView; options?: ConnectorOptions }) {
  const entities = kind.produces.every((t) => t === "entity");
  const docs = kind.produces.some((t) => t === "document" || t === "note");
  const fixedOwner = kind.produces.includes("meeting") || c?.scope === "person" || !c?.target_space_id;
  return <fieldset><legend>{M.target}</legend>
    {!entities ? <><label>{M.owner}<input name="owner_id" list="connector-people" defaultValue={c?.owner?.id ?? ""} readOnly={Boolean(c && fixedOwner)} maxLength={36} /></label>
      <datalist id="connector-people">{options?.people.map((p) => <option key={p.id} value={p.id} label={`${p.display_name} (${p.login})`} />)}</datalist><p>{M.ownerHint}</p></> : null}
    {docs ? <><label>{M.space}<input name="target_space_id" list="connector-spaces" defaultValue={c?.target_space_id ?? ""} required={Boolean(c?.target_space_id)} maxLength={36} /></label>
      <datalist id="connector-spaces">{options?.spaces.map((s) => <option key={s.id} value={s.id} label={`${s.name} (${s.slug}) — ${s.default_class === "open" ? M.openRecords : M.closed}`} />)}</datalist><p>{M.personalSpace}</p>
      <label><input type="radio" name="data_class" value="closed" defaultChecked={c?.data_class !== "space"} />{M.closed}</label>
      <label><input type="radio" name="data_class" value="space" defaultChecked={c?.data_class === "space"} />{M.spaceClass}</label>
    </> : <input type="hidden" name="data_class" value="closed" />}
  </fieldset>;
}

export function OptionsSearch({ kind, peopleQuery = "", spaceQuery = "", options }: { kind?: string; peopleQuery?: string; spaceQuery?: string; options: ConnectorOptions }) {
  return <form method="get" className="form"><p>{M.choiceHint}</p>
    {kind ? <input type="hidden" name="kind" value={kind} /> : null}
    <label>{M.peopleSearch}<input name="people_query" defaultValue={peopleQuery} maxLength={100} /></label>
    <label>{M.spaceSearch}<input name="space_query" defaultValue={spaceQuery} minLength={2} maxLength={100} /></label>
    <button className="btn" type="submit">{M.searchChoices}</button>
    {options.more ? <p>{M.moreChoices}</p> : null}{options.error ? <p>{M.error}</p> : null}
  </form>;
}

export function PolicyFields({ kind, connector: c }: { kind: ConnectorKind; connector?: ConnectorView }) {
  const policy = c?.policy ?? {};
  const selects = [
    { key: "participants", label: M.participants, options: [["owner_only", M.ownerOnly], ["attended_emails", M.attended]] },
    { key: "on_change", label: M.onChange, options: [["version", M.newVersion], ["new_record", M.newRecord]] },
    { key: "on_delete", label: M.onDelete, options: [["keep", M.keep], ["trash", M.trash]] },
  ];
  return <fieldset><legend>{M.runs}</legend>
    {kind.capabilities.pull ? <label>{M.schedule}<input type="number" step="1" min={Math.max(60, kind.limits.minIntervalSec)} name="policy.schedule_sec" defaultValue={String(policy.schedule_sec ?? "")} /></label> : null}
    <label>{M.dailyItems}<input type="number" step="1" min={1} name="policy.daily_items" defaultValue={String(policy.daily_items ?? "")} /></label>
    <label>{M.dailyMb}<input type="number" step="1" min={1} name="policy.daily_mb" defaultValue={String(policy.daily_mb ?? "")} /></label>
    {selects.map((s) => <label key={s.key}>{s.label}<select name={`policy.${s.key}`} defaultValue={String(policy[s.key] ?? s.options[0]![0])}>
      {s.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select></label>)}
  </fieldset>;
}

export function Operation({ id, op, acknowledge }: { id: string; op: keyof typeof M.actions; acknowledge?: string }) {
  return <ConnectorForm key={`${id}:${op}`} action={connectorAction} label={M.actions[op]} danger={op === "delete"}>
    <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={op} />
    {acknowledge ? <label><input type="checkbox" name="acknowledge" required />{acknowledge}</label> : null}
  </ConnectorForm>;
}
export function Pager({ href, cursor, field, status }: { href: string; cursor?: string; field: string; status?: string }) {
  const q = new URLSearchParams({ [field]: cursor ?? "", ...(status ? { status } : {}) });
  return <nav aria-label={field === "runs_cursor" ? M.runs : M.items}>{cursor ? <Link href={`${href}?${q}`}>{M.next}</Link> : null} <Link href={href}>{M.previous}</Link></nav>;
}
