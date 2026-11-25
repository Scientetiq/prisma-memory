import { rich } from "../../../../i18n/rich";
import { TEXT } from "../../../../messages/panel-agent-login";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { param, type SearchParams } from "@/lib/paging";
import { probeCimdAction, revokeDcrClientAction } from "./actions";
import { AGENT_AUTH_SETTINGS_HREF, CIMD_URL_MAX, cimdReasonTitle, dcrOffWarning, dcrRevokeConfirm, MODE_TITLES, parseAgentAuth, problemTitle, trustedEgressProxyWarning, type AgentAuthView } from "./view";

export function generateMetadata(): Metadata { return { title: TEXT.agentSignIn }; }

const when = (iso: string | null) => (iso ? <LocalTime iso={iso} short /> : "—");
const count = (n: number | null) => (n === null ? "—" : String(n));

function Overview({ v }: { v: AgentAuthView }) {
  return (
    <dl className="oauth-parameters" data-agent-login="overview">
      <dt>{TEXT.mode}</dt><dd><Badge tone={v.mode === "builtin" ? "brand" : "neutral"}>{v.mode}</Badge> {MODE_TITLES[v.mode]}</dd>
      <dt>{TEXT.builtInSignInReadiness}</dt><dd>{v.ready ? <Badge tone="ok">{TEXT.ready}</Badge> : <Badge tone="warn">{TEXT.notReady}</Badge>}</dd>
      <dt>{TEXT.issuerIssuer}</dt><dd>{v.issuer ? <code>{v.issuer}</code> : "—"}</dd>
      <dt>{TEXT.mcpURL}</dt><dd>{v.mcp_url ? <code>{v.mcp_url}</code> : "—"}</dd>
      <dt>{TEXT.workspaceURL}</dt><dd>{v.workplace_url ? <code>{v.workplace_url}</code> : "—"}</dd>
      <dt>{TEXT.activeConnections}</dt><dd>{rich(TEXT.registryAppDocumentsDCR, null, { value1: count(v.connections.registry), value2: count(v.connections.cimd), value3: count(v.connections.dcr) })}</dd>
    </dl>
  );
}

export default async function AgentLoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(true);
  const cursor = param(await searchParams, "cursor");
  const res = await tryGw<unknown>("/api/v1/admin/agent-auth", { query: { dcr_cursor: cursor || undefined } });
  const v = res.ok ? parseAgentAuth(res.data) : null;

  return (
    <PageFrame title={TEXT.agentSignIn3} allowAuditor
      lead={TEXT.builtInAgentSignInTheGateway}
      actions={<Link className="btn" href={AGENT_AUTH_SETTINGS_HREF} prefetch={false}>{TEXT.edit}</Link>}>
      {!res.ok ? <LoadError result={res} what={TEXT.agentSignIn2} /> : !v ? (
        <Notice tone="warn">{TEXT.theGatewayReturnedAnUnexpectedResponseGateway}</Notice>
      ) : <>
        <Section title={TEXT.state3} id="state" hint={TEXT.changeTheModeInSettingsTheAgent}>
          <Overview v={v} />
          {v.problems.length ? (
            <div className="notice warn" role="status" data-agent-login="problems">
              <strong>{TEXT.whatPreventsBuiltInSignInFrom}</strong>
              <ul>{v.problems.map((p) => <li key={p} data-problem={p}>{problemTitle(p)}</li>)}</ul>
            </div>
          ) : null}
        </Section>

        <Section title={TEXT.appsWithAPreconfiguredClientID} id="clients" hint={TEXT.theAgentAuthClientsRegistryTheseApps}>
          {!v.clients.length ? <Empty>{TEXT.noAppsInTheRegistry}</Empty> : (
            <TableWrap cards>
              <table className="board" aria-label={TEXT.registryApps}>
                <thead><tr><th>{TEXT.clientID}</th><th>{TEXT.app2}</th><th>{TEXT.kind2}</th><th>{TEXT.returnURLs4}</th><th>{TEXT.state2}</th></tr></thead>
                <tbody>
                  {v.clients.map((c) => (
                    <tr key={c.client_id} className={c.enabled ? undefined : "muted"}>
                      <td data-label={TEXT.clientID}><code>{c.client_id}</code></td>
                      <td data-label={TEXT.app}>{c.title}</td>
                      <td data-label={TEXT.kind}>{c.kind}</td>
                      <td data-label={TEXT.returnURLs3}>{c.redirects.map((r) => <div key={r}><code>{r}</code></div>)}</td>
                      <td data-label={TEXT.state}>{c.enabled ? <Badge tone="ok">{TEXT.on3}</Badge> : <Badge tone="muted">{TEXT.off3}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Section>

        <Section title={TEXT.appDocumentsCIMD} id="cimd" hint={TEXT.claudeAiChatGPTAndVSCodeIdentify}>
          <dl className="oauth-parameters">
            <dt>{TEXT.hostPrefixEntries}</dt><dd>{v.cimd_hosts.length ? v.cimd_hosts.map((h) => <div key={h}><code>{h}</code></div>) : TEXT.empty}</dd>
            <dt>{TEXT.anyHTTPSDocument}</dt><dd>{v.cimd_any_https ? <Badge tone="warn">{TEXT.on2}</Badge> : <Badge tone="muted">{TEXT.off2}</Badge>}</dd>
          </dl>
          {v.cimd_needs_egress ? (
            <Notice tone="warn">{TEXT.noDocumentFetchHasSucceededYetThe}</Notice>
          ) : null}
          {v.cimd_last_failure.length ? (
            <ul className="setup-list" data-agent-login="cimd-failures">
              {v.cimd_last_failure.map((f) => <li key={f.host}><code>{f.host}</code> — {cimdReasonTitle(f)}{f.at ? <> · {when(f.at)}</> : null}</li>)}
            </ul>
          ) : null}
          <h3 className="sec-sub">{TEXT.checkDocument2}</h3>
          <p className="hint">{TEXT.fetchesTheDocumentWithoutUsingTheCache}</p>
          <ActionForm action={probeCimdAction} submitLabel={TEXT.checkDocument} pendingLabel={TEXT.checking} quiet>
            <Field label={TEXT.documentURL} wide hint={TEXT.forExampleHttpsClaudeAiOauthMcp}>
              <input type="url" name="url" required maxLength={CIMD_URL_MAX} spellCheck={false} autoComplete="off" placeholder={TEXT.httpsClaudeAiOauth} />
            </Field>
          </ActionForm>
        </Section>

        <Section title={TEXT.dynamicClientRegistrationDCR} id="dcr" hint={TEXT.registerAutomaticallyTheAppRegistersItselfOff}>
          <p>{v.dcr.enabled ? <Badge tone="warn">{TEXT.on}</Badge> : <Badge tone="muted">{TEXT.off}</Badge>}</p>
          {v.dcr.enabled ? <p data-agent-login="dcr-off">{dcrOffWarning(v.connections.dcr)}</p> : null}
          {trustedEgressProxyWarning(v.dcr.trusted_egress_over_proxies) ? (
            <Notice tone="warn"><span data-agent-login="egress-over-proxies">{trustedEgressProxyWarning(v.dcr.trusted_egress_over_proxies)}</span></Notice>
          ) : null}
          {!v.dcr.items.length ? <Empty>{cursor ? TEXT.noClientsOnThisPage : TEXT.noRegisteredClients}</Empty> : (
            <TableWrap cards>
              <table className="board" aria-label={TEXT.dcrClients}>
                <thead><tr><th>{TEXT.client2}</th><th>{TEXT.returnURLs2}</th><th>{TEXT.created2}</th><th>{TEXT.lastSignInAttempt2}</th><th>{TEXT.lastSignIn2}</th><th>{TEXT.connections2}</th><th /></tr></thead>
                <tbody>
                  {v.dcr.items.map((c) => (
                    <tr key={c.client_id} className={c.revoked_at ? "muted" : undefined} data-dcr={c.client_id}>
                      <td data-label={TEXT.client}><b>{c.client_name ?? TEXT.unnamed}</b><div className="muted small"><code>{c.client_id}</code></div></td>
                      <td data-label={TEXT.returnURLs}>{c.redirect_uris.map((u) => <div key={u}><code>{u}</code></div>)}</td>
                      <td data-label={TEXT.created}>{when(c.created_at)}{c.created_ip_prefix ? <div className="muted small">{rich(TEXT.network, null, { value1: c.created_ip_prefix })}</div> : null}</td>
                      <td data-label={TEXT.lastSignInAttempt}>{when(c.last_authorize_at)}</td>
                      <td data-label={TEXT.lastSignIn}>{c.first_used_at ? when(c.last_used_at ?? c.first_used_at) : TEXT.noSignInAttempts}</td>
                      <td data-label={TEXT.connections}>{count(c.active_connections)}</td>
                      <td data-label="">
                        {c.revoked_at ? <Badge tone="muted">{TEXT.revoked}</Badge> : (
                          <ActionForm action={revokeDcrClientAction} submitLabel={TEXT.revoke} pendingLabel={TEXT.text} compact danger
                            confirm={dcrRevokeConfirm(c)}>
                            <input type="hidden" name="id" value={c.client_id} />
                          </ActionForm>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {cursor || v.dcr.next_cursor ? <CursorPager path="/admin/agent-login" params={{}} cursorName="cursor" cursor={cursor} nextCursor={v.dcr.next_cursor} shown={v.dcr.items.length} anchor="dcr" noun={TEXT.clients} /> : null}
        </Section>
      </>}
    </PageFrame>
  );
}
