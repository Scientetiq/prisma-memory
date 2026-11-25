import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { connectorGw as gw } from "@/lib/connector-api";
import { connectorPath, isConnectorId, ITEM_STATUSES, loadRunCounters, type ConnectorView, type ItemsResponse, type KindsResponse, type RunsResponse } from "@/lib/connectors";
import { GatewayError } from "@/lib/gateway";
import { loadConnectorOptions } from "@/lib/connector-options";
import { param, type SearchParams } from "@/lib/paging";
import { requireSession } from "@/lib/session";
import type { SettingsResponse } from "@/lib/types";
import { readAdminView } from "@/lib/view-as";
import { connectors as M } from "@/messages/connectors";
import { saveConnectorAction, saveConnectorSecretAction } from "../actions";
import { ConnectorForm, WebhookPreview } from "../forms";
import { ConfigFields, DestinationFields, Operation, OptionsSearch, Pager, PolicyFields, Reason, State, Summary } from "../parts";

export async function generateMetadata() { return { title: M.page }; }

export default async function ConnectorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const [session, view, { id }, sp] = await Promise.all([requireSession(), readAdminView(), params, searchParams]);
  if (!isConnectorId(id)) notFound();
  const readOnly = session.role === "security_auditor" || view === "auditor";
  const ordinary = !readOnly && !session.breakglass;
  const options = await loadConnectorOptions(param(sp, "people_query"), param(sp, "space_query"));
  const status = ITEM_STATUSES.find((s) => s === param(sp, "status"));
  let c: ConnectorView, kinds: KindsResponse;
  try { [c, kinds] = await Promise.all([gw<ConnectorView>(connectorPath(id)), gw<KindsResponse>("/api/v1/admin/connectors/kinds")]); }
  catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    if (e.status === 404) notFound();
    return <PageFrame title={M.page} allowAuditor><p role="alert">{M.error}</p></PageFrame>;
  }
  // A failed secondary list never hides the connector or its narrowing controls.
  const secondary = await Promise.allSettled([
    gw<RunsResponse>(connectorPath(id, "runs"), { query: { limit: 50, cursor: param(sp, "runs_cursor") } }),
    gw<ItemsResponse>(connectorPath(id, "items"), { query: { limit: 50, status, cursor: param(sp, "items_cursor") } }),
    gw<SettingsResponse>("/api/v1/admin/settings"),
    loadRunCounters((cursor) => gw<RunsResponse>(connectorPath(id, "runs"), { query: { limit: 100, cursor } })),
  ]);
  for (const r of secondary) if (r.status === "rejected" && !(r.reason instanceof GatewayError)) throw r.reason;
  const runs = secondary[0].status === "fulfilled" ? secondary[0].value : null;
  const items = secondary[1].status === "fulfilled" ? secondary[1].value : null;
  const settings = secondary[2].status === "fulfilled" ? secondary[2].value.items : [];
  const setting = (category: string, key: string) => settings.find((x) => x.category === category && x.key === key && !x.secret)?.value;
  const consentText = setting("meetings", "consent_text"), consentVersion = setting("meetings", "consent_version");
  const base = setting("access", "public_base_url");
  const kind = kinds.kinds.find((k) => k.kind === c.kind);
  const here = `/admin/connectors/${id}`;
  const counts = secondary[3].status === "fulfilled" ? secondary[3].value : null;
  return <PageFrame title={c.name} allowAuditor>
    <p><Link href="/admin/connectors">{M.back}</Link> <Link href={here}>{M.refresh}</Link></p>
    <Summary connector={c} kind={kind} options={options} />
    {counts ? <section><h2>{M.counts}</h2><p>{M.seen}: {counts.seen} · {M.staged}: {counts.staged}</p>
      {!counts.complete ? <p>{M.partialCounts}</p> : null}
      {c.webhook_path ? <p>{M.webhookCounts}</p> : null}
    </section> : null}
    {c.webhook_path ? <WebhookPreview path={c.webhook_path} base={typeof base === "string" ? base : null} /> : null}
    {!readOnly ? <section><h2>{M.status}</h2>
      {ordinary ? <><Operation id={id} op="test" />{kind?.capabilities.pull ? <Operation id={id} op="run" /> : null}<Operation id={id} op="resume" /></> : null}
      <Operation id={id} op="pause" />
      {ordinary && c.webhook_path ? <Operation id={id} op="rotate" acknowledge={M.rotationConfirm} /> : null}
      <Operation id={id} op="delete" acknowledge={M.confirmDelete} />
    </section> : <p>{M.readOnly}</p>}
    {kind?.produces.includes("meeting") ? <section><h2>{M.consent}</h2>
      {typeof consentText === "string" && consentText && typeof consentVersion === "string" && consentVersion ? <>
        <code>{consentVersion}</code><blockquote>{consentText}</blockquote>
        {ordinary ? <Operation id={id} op="reconfirm" acknowledge={M.ackConsent} /> : null}
      </> : <p>{M.consentUnavailable}</p>}
    </section> : null}
    {ordinary && kind ? <section><h2>{M.configure}</h2>
      <OptionsSearch options={options} peopleQuery={param(sp, "people_query")} spaceQuery={param(sp, "space_query")} />
      <ConnectorForm key={id} action={saveConnectorAction} label={M.save}>
        <input type="hidden" name="id" value={id} /><label>{M.name}<input name="name" defaultValue={c.name} required maxLength={200} /></label>
        <ConfigFields kind={kind} connector={c} /><DestinationFields kind={kind} connector={c} options={options} /><PolicyFields kind={kind} connector={c} />
      </ConnectorForm>
    </section> : null}
    <section><h2>{M.secrets}</h2>
      {c.secrets.map((s) => <p key={s.name}><code>{s.name}</code>: {s.set ? M.secretSet : M.secretUnset} {s.fingerprint ? <>{M.fingerprint}: <code>{s.fingerprint}</code></> : null}</p>)}
      {ordinary ? kind?.secrets.map((s) => <ConnectorForm key={`${id}:${s.name}`} action={saveConnectorSecretAction} label={M.actions.secret}>
        <input type="hidden" name="id" value={id} /><input type="hidden" name="name" value={s.name} />
        <label>{s.title}<input type="password" name="value" required maxLength={8192} autoComplete="new-password" placeholder={M.secretPlaceholder} /></label>
      </ConnectorForm>) : null}
    </section>
    <section><h2>{M.runs}</h2>{runs ? <>
      <div className="table-wrap"><table><thead><tr><th>{M.type}</th><th>{M.status}</th><th>{M.lastRun}</th><th>{M.seen}</th><th>{M.staged}</th><th>{M.reason}</th></tr></thead>
        <tbody>{runs.runs.map((r) => <tr key={r.id}><td><State code={r.kind} /></td><td><State code={r.status} /></td><td><LocalTime iso={r.started_at ?? r.created_at} relative={false} /></td><td>{r.seen}</td><td>{r.staged}</td><td><Reason code={r.error} /></td></tr>)}</tbody>
      </table></div><Pager href={here} cursor={runs.next_cursor} field="runs_cursor" status={status} />
    </> : <p role="alert">{M.error}</p>}</section>
    <section><h2>{M.items}</h2>
      <form method="get"><label>{M.status}<select name="status" defaultValue={status ?? ""}><option value="">{M.all}</option>{ITEM_STATUSES.map((s) => <option key={s} value={s}>{M.states[s]}</option>)}</select></label><button type="submit" className="btn">{M.filter}</button></form>
      {items ? <><div className="table-wrap"><table><thead><tr><th>{M.externalId}</th><th>{M.type}</th><th>{M.status}</th><th>{M.version}</th><th>{M.record}</th><th>{M.reason}</th></tr></thead>
        <tbody>{items.items.map((item) => <tr key={`${item.type}:${item.external_id}:${item.version}`}><td>{item.external_id}</td><td><code>{item.type}</code></td><td><State code={item.status} /></td><td>{item.version}</td><td><code>{item.record_id ?? M.none}</code></td><td><Reason code={item.reason} /></td></tr>)}</tbody>
      </table></div><Pager href={here} cursor={items.next_cursor} field="items_cursor" status={status} /></> : <p role="alert">{M.error}</p>}
    </section>
  </PageFrame>;
}
