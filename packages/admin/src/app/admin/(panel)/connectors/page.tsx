import Link from "next/link";
import { PageFrame } from "@/components/page-frame";
import { connectorGw as gw } from "@/lib/connector-api";
import { CONNECTORS_API, connectorPath, loadRunCounters, type ConnectorsResponse, type KindsResponse, type RunsResponse } from "@/lib/connectors";
import { GatewayError } from "@/lib/gateway";
import { loadConnectorOptions } from "@/lib/connector-options";
import { requireSession } from "@/lib/session";
import { readAdminView } from "@/lib/view-as";
import { param, type SearchParams } from "@/lib/paging";
import { connectors as M } from "@/messages/connectors";
import { createConnectorAction } from "./actions";
import { ConnectorForm } from "./forms";
import { ConfigFields, DestinationFields, OptionsSearch, Pager, PolicyFields, Summary } from "./parts";

export async function generateMetadata() { return { title: M.page }; }

export default async function ConnectorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [session, view, sp] = await Promise.all([requireSession(), readAdminView(), searchParams]);
  const readOnly = session.role === "security_auditor" || view === "auditor" || session.breakglass;
  let kinds: KindsResponse, list: ConnectorsResponse;
  try {
    [kinds, list] = await Promise.all([
      gw<KindsResponse>(`${CONNECTORS_API}/kinds`),
      gw<ConnectorsResponse>(CONNECTORS_API, { query: { cursor: param(sp, "cursor"), limit: 10 } }),
    ]);
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    return <PageFrame title={M.page} allowAuditor><p role="alert">{M.error}</p></PageFrame>;
  }
  const kind = kinds.kinds.find((k) => k.kind === param(sp, "kind"));
  const options = await loadConnectorOptions(param(sp, "people_query"), param(sp, "space_query"));
  const counts = await Promise.all(list.connectors.map(async (c) => {
    try { return await loadRunCounters((cursor) => gw<RunsResponse>(connectorPath(c.id, "runs"), { query: { limit: 100, cursor } })); }
    catch (e) { if (!(e instanceof GatewayError)) throw e; return null; }
  }));
  return <PageFrame title={M.page} lead={M.lead} allowAuditor>
    <p><Link href="/admin/connectors">{M.refresh}</Link></p>
    {list.connectors.length ? list.connectors.map((c, i) => <section className="card" key={c.id}>
      <h2><Link href={`/admin/connectors/${c.id}`}>{c.name}</Link></h2>
      <Summary connector={c} kind={kinds.kinds.find((k) => k.kind === c.kind)} options={options} />
      {counts[i] ? <><p>{M.counts}: {M.seen} {counts[i].seen} · {M.staged} {counts[i].staged}</p>{!counts[i].complete ? <p>{M.partialCounts}</p> : null}</> : <p>{M.error}</p>}
    </section>) : <p>{M.empty}</p>}
    <Pager href="/admin/connectors" cursor={list.next_cursor} field="cursor" />
    {!readOnly ? <section id="add"><h2>{M.add}</h2>
      <form method="get" className="form"><label>{M.choose}<select name="kind" defaultValue={kind?.kind ?? kinds.kinds[0]?.kind}>
        {kinds.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}
      </select></label><button type="submit" className="btn">{M.add}</button></form>
      {kind ? <><p>{kind.description}</p>{kind.verified === "mock_only" ? <p className="notice warn">{M.notVerified}</p> : null}
        <OptionsSearch kind={kind.kind} options={options} peopleQuery={param(sp, "people_query")} spaceQuery={param(sp, "space_query")} />
        <ConnectorForm key={kind.kind} action={createConnectorAction} label={M.create}>
          <input type="hidden" name="kind" value={kind.kind} />
          <label>{M.name}<input name="name" required maxLength={200} /></label>
          <label>{M.scope}<select name="scope" defaultValue={kind.scopes[0]}>{kind.scopes.map((s) => <option key={s} value={s}>{s === "instance" ? M.instance : M.person}</option>)}</select></label>
          {kinds.presets.some((p) => p.kind === kind.kind) ? <label>{M.kind}<select name="pack" defaultValue=""><option value="">{M.none}</option>{kinds.presets.filter((p) => p.kind === kind.kind).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label> : null}
          <ConfigFields kind={kind} />
          <fieldset><legend>{M.secrets}</legend>{kind.secrets.length ? kind.secrets.map((s) => <label key={s.name}>{s.title}<input type="password" name={`secret.${s.name}`} required={s.required} maxLength={8192} autoComplete="new-password" /></label>) : <p>{M.noSecret}</p>}</fieldset>
          <DestinationFields kind={kind} options={options} /><PolicyFields kind={kind} /><p>{M.activateHint}</p>
        </ConnectorForm>
      </> : null}
    </section> : <p>{M.readOnly}</p>}
  </PageFrame>;
}
