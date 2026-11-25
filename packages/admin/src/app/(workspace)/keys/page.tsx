import { pageText as M } from "@/messages/ws-keys";
import { rich } from "@/i18n/rich";
import { derived } from "@/i18n/runtime";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { Icon } from "@/components/icons";
import { ConnectionCard, KeyCard, keyName } from "@/components/agent-card";
import { Badge, Code, Empty, LoadError, PageHead, Section } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { LABELS_TEXT, clientKindTitle } from "@/lib/labels";
import { meGw } from "@/lib/me-api";
import { oauthAgentConfig, oauthAgentsOn, publicOrigin, requireWorkspace } from "@/lib/me";
import type { OAuthConnectionsPage } from "@/lib/oauth-connect";
import { PAGE_SIZE, param, type SearchParams } from "@/lib/paging";
import { retryable } from "@/lib/retry";
import { mcpUrls } from "@/lib/snippets";
import { EXTENDED_OPEN_PLAIN, KEYS_PLAIN, myKeyOpenWrite, NOTEBOOK_PLAIN } from "@/lib/plain";
import type { MyKey, MyKeysPage, MySession, MySessionsPage } from "@/lib/types";
import { endAllSessionsAction, endMySessionAction, issueMyKeyAction, markMyKeyScriptAction, narrowMyKeyOpenWriteAction, revokeMyKeyAction, setNotebookAction } from "../actions";
import { revokeConnectionAction } from "../connect/actions";
import { IssueKeyForm } from "./issue-form";
import { Snippets } from "./snippets";

export function generateMetadata(): Metadata { return { title: M.keysAndAgents }; }

const isActive = (k: MyKey) => !k.revoked_at && !(k.expires_at && Date.parse(k.expires_at) <= Date.now());

function browserOf(ua: string | null): string {
  if (!ua) return M.browser;
  const name = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : ua.split(/[\s/]/)[0] || M.browser;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${name} · ${os}` : name;
}

const SOURCE_PLAIN: Record<string, string> = derived(() => ({ ldap: M.withYourCompanyLoginAndPassword, oidc: M.throughCompanySingleSignOn, test: M.acceptanceTestSignIn }));

function SessionCards({ rows }: { rows: MySession[] }) {
  return (
    <ul className="agents ag-cards">
      {rows.map((x) => (
        <li key={x.id} className="ag-card">
          <span className="ichip sm tone-gray"><Icon name="monitor" /></span>
          <div className="ag-main">
            <b className="ag-name">{browserOf(x.user_agent)}{x.current ? <> <Badge tone="brand">{KEYS_PLAIN.thisSession}</Badge></> : null}</b>
            <small>{rich(M.validThrough, { tag0: () => <LocalTime iso={x.expires_at} short relative={false} /> }, { value0: KEYS_PLAIN.lastSeen, value1: x.last_seen_at ? <LocalTime iso={x.last_seen_at} short /> : "—" })}</small>
            <details className="ag-more">
              <summary>{rich(M.details, null)}</summary>
              <p className="muted small">{rich(M.signedInStarted, { tag0: () => <LocalTime iso={x.created_at} short /> }, { value0: SOURCE_PLAIN[x.source] ?? x.source, value1: x.ip ? <>{rich(M.computerAddress, null, { value0: x.ip })}</> : null })}</p>
            </details>
          </div>
          <div className="ag-act">
            {x.current ? <span className="muted small">{rich(M.signOutAtTheBottomOf, null)}</span> : (
              <ActionForm action={endMySessionAction} submitLabel={KEYS_PLAIN.sessionEnd} pendingLabel="…" compact danger confirm={KEYS_PLAIN.sessionEndConfirm}>
                <input type="hidden" name="id" value={x.id} />
              </ActionForm>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function personalLine(k: MyKey, notebook: boolean): ReactNode {
  if (k.kind === "extended") return <>{rich(M.theKeyItselfCanReadYour, { tag0: () => <VisibilityBadge cls="closed" /> })}</>;
  if (k.client_kind === "script") return <>{rich(M.theScriptWritesWithoutAModel, { tag0: () => <VisibilityBadge cls="closed" /> })}</>;
  return notebook ? <>{rich(M.afterTheOpenCheckFindingsMean, { tag0: () => <VisibilityBadge cls="open" /> })}</> : <>{rich(M.youHaveHiddenNewAgentRecords, { tag0: () => <VisibilityBadge cls="closed" /> })}</>;
}

function KeyCards({ rows, notebook }: { rows: MyKey[]; notebook: boolean }) {
  return (
    <ul className="agents ag-cards">
      {rows.map((k) => {
        const script = isActive(k) && k.kind === "personal" && !k.preview && k.client_kind !== "script";
        const narrow = myKeyOpenWrite(k);
        return (
          <KeyCard key={k.id} k={k} revoke={revokeMyKeyAction}>
            {k.kind === "extended" ? <small className="ag-line">{rich(M.extendedKeyAlsoReadsYourClosed, null)}</small> : null}
            {narrow ? <small className="ag-line">{narrow.line}</small> : null}
            {k.issued_by === "admin" ? <small className="ag-line"><Badge tone="warn" title={M.keyIssuedByAnAdministratorThe}>{rich(M.issuedByAnAdministrator, null)}</Badge>{k.basis ? <> · {k.basis}</> : null}</small> : null}
            {k.preview ? <small className="ag-line"><Badge tone="violet" title={M.keyForViewAsInThe}>{rich(M.preview, null)}</Badge></small> : null}
            <details className="ag-more">
              <summary>{KEYS_PLAIN.more}</summary>
              <dl className="ag-dl">
                <dt>{rich(M.program, null)}</dt><dd>{k.client_kind ? clientKindTitle(k.client_kind) : LABELS_TEXT.clientKindNone}</dd>
                <dt>{rich(M.personalSpace, null)}</dt><dd>{personalLine(k, notebook)}</dd>
                <dt>{rich(M.issued, null)}</dt><dd><LocalTime iso={k.created_at} short />{k.issued_by === "admin" ? M.byAnAdministrator : M.byYou}</dd>
              </dl>
              {script ? <>
                <p className="muted small">{KEYS_PLAIN.scriptHint}</p>
                <ActionForm action={markMyKeyScriptAction} submitLabel={KEYS_PLAIN.script} pendingLabel="…" compact quiet confirm={KEYS_PLAIN.scriptConfirm(keyName(k))}>
                  <input type="hidden" name="id" value={k.id} />
                </ActionForm>
              </> : null}
              {narrow?.canNarrow ? (
                <ActionForm action={narrowMyKeyOpenWriteAction} submitLabel={EXTENDED_OPEN_PLAIN.offButton} pendingLabel="…" compact quiet confirm={EXTENDED_OPEN_PLAIN.offConfirm}>
                  <input type="hidden" name="id" value={k.id} />
                </ActionForm>
              ) : null}
            </details>
          </KeyCard>
        );
      })}
    </ul>
  );
}

export default async function KeysPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  if (session.preview) redirect("/?preview_no_keys=1");
  const sp = await searchParams;
  const cursor = param(sp, "cursor");
  const connCursor = param(sp, "conns");
  const [keys, sessions, origin, oauthConfig, connections] = await Promise.all([
    meGw<MyKeysPage>(session.key, "/api/v1/me/keys", { query: { limit: PAGE_SIZE, cursor: cursor || undefined } }),
    meGw<MySessionsPage>(session.key, "/api/v1/me/sessions"),
    publicOrigin(me),
    oauthAgentConfig(session.key),
    meGw<OAuthConnectionsPage>(session.key, "/api/v1/me/connections", { query: { limit: PAGE_SIZE, cursor: connCursor || undefined } }),
  ]);
  const oauthOn = oauthAgentsOn(oauthConfig);
  const urls = mcpUrls(origin);
  const split = urls.cloud !== urls.internal;
  const items = keys.ok ? keys.data.items : [];
  const live = items.filter(isActive);
  const dead = items.filter((k) => !isActive(k));
  const nextCursor = keys.ok ? keys.data.next_cursor : null;
  const limit = me.limits?.personal_keys_max?.limit ?? null;
  const remaining = limit !== null && !cursor && !nextCursor ? Math.max(0, limit - items.filter(isActive).length) : null;
  const sameFail = !keys.ok && !sessions.ok && keys.code === sessions.code;
  const sameFailLine = !keys.ok && sameFail
    ? retryable(keys.code, keys.status) ? M.couldNotLoadWillRetryWith : M.couldNotLoadForTheSame
    : null;
  const notebook = me.notebook !== false;
  const conns = connections.ok ? connections.data.items : [];
  const connNext = connections.ok ? connections.data.next_cursor : null;
  // the section is there while agents sign in with the company account, or when there are connections to show
  const showConns = oauthOn || conns.length > 0 || Boolean(connCursor);

  return (
    <>
      <PageHead title={M.keysAndAgents} lead={oauthOn ? KEYS_PLAIN.leadOauth : KEYS_PLAIN.lead}
        actions={<Link className="btn primary" href="/connect"><Icon name="plug" />{KEYS_PLAIN.connectMore}</Link>} />

      <Section title={M.myKeys} id="keys" icon="key" hint={limit !== null ? M.youCanHaveUpToActive(limit) : M.useASeparateKeyForEach}>
        {!keys.ok ? <LoadError result={keys} what={sameFail ? M.keysAndWorkspaceSignIns : M.keys} /> : !items.length ? (
          cursor ? <Empty>{rich(M.noKeysOnThisPage, null)}</Empty> : (
            <Empty icon="key" action={<Link className="btn" href="/connect"><Icon name="plug" />{KEYS_PLAIN.connectMore}</Link>}>
              {oauthOn ? M.noKeysYetAKeyIs : M.noKeysYetAKeyIs2}
            </Empty>
          )
        ) : (
          <>
            {live.length ? <KeyCards rows={live} notebook={notebook} /> : cursor || nextCursor ? <Empty icon="key">{rich(M.noActiveKeysOnThisPage, null)}</Empty> : (
              <Empty icon="key" action={<Link className="btn" href="/connect"><Icon name="plug" />{KEYS_PLAIN.connectMore}</Link>}>{rich(M.noActiveKeysRevokedAndExpired, null)}</Empty>
            )}
            {dead.length ? (
              <details className="keys-old">
                <summary>{rich(M.revokedAndExpired, null, { value0: dead.length })}</summary>
                <KeyCards rows={dead} notebook={notebook} />
              </details>
            ) : null}
            {cursor || nextCursor ? <CursorPager path="/keys" params={{ cursor }} cursorName="cursor" cursor={cursor} nextCursor={nextCursor} shown={items.length} anchor="keys" /> : null}
          </>
        )}
      </Section>

      {showConns ? (
        <Section title={M.connectedPrograms} id="connections" icon="plug" hint={M.programsYouConnectedWithCompanyAccount}>
          {!connections.ok ? <LoadError result={connections} what={M.connectedPrograms2} home={false} /> : !conns.length ? (
            <Empty icon="plug">{connCursor ? M.noConnectionsOnThisPage : M.noProgramsConnectedYet}</Empty>
          ) : (
            <ul className="agents ag-cards">
              {conns.map((c) => <ConnectionCard key={c.id} c={c} disconnect={revokeConnectionAction} />)}
            </ul>
          )}
          {connCursor || connNext ? <CursorPager path="/keys" params={{ cursor }} cursorName="conns" cursor={connCursor} nextCursor={connNext} shown={conns.length} anchor="connections" /> : null}
        </Section>
      ) : null}

      <Section title={M.agentRecordsInYourPersonalSpace} id="notebook" icon="bot" hint={M.notesAndDocumentsAnAgentSaves}>
        <p className="keys-nb-state">
          <VisibilityBadge cls={notebook ? "open" : "closed"} />{" "}
          {notebook
            ? M.agentRecordsAreOpenYourAgent
            : M.agentRecordsAreClosedWithoutAn}
        </p>
        <ActionForm action={setNotebookAction} submitLabel={notebook ? NOTEBOOK_PLAIN.hide : NOTEBOOK_PLAIN.show} pendingLabel={M.saving} quiet={notebook}
          confirm={notebook ? NOTEBOOK_PLAIN.hideConfirm : undefined}>
          <input type="hidden" name="enabled" value={notebook ? "0" : "1"} />
        </ActionForm>
      </Section>

      <Section title={M.workspaceSignIns} id="sessions" icon="log-in" hint={M.whereYouAreSignedInNow}>
        {!sessions.ok ? (sameFailLine ? <p className="muted">{sameFailLine}</p> : <LoadError result={sessions} what={M.signIns} />) : !sessions.data.items.length ? <Empty icon="log-in">{rich(M.noActiveSignIns, null)}</Empty> : (
          <>
            <SessionCards rows={sessions.data.items} />
            <ActionForm action={endAllSessionsAction} submitLabel={M.endAllSignIns} pendingLabel={M.ending} danger
              confirm={M.endAllWorkspaceSignInsOn}>
              {null}
            </ActionForm>
          </>
        )}
      </Section>

      <details className="cn-it keys-it">
        <summary>{KEYS_PLAIN.itSection}</summary>
        <h3 className="sec-sub">{rich(M.issueKey, null)}</h3>
        <p className="hint">{rich(M.aKeyForAScriptOr, null)}</p>
        <IssueKeyForm action={issueMyKeyAction} urls={urls} remaining={remaining} />
        <h3 className="sec-sub">{rich(M.readyToUseConnectionCommands, null)}</h3>
        <p className="hint">
          {rich(split ? me.public_base_url ? M.cloudAndInternalAddresses : M.cloudAddress : M.agentAddress,
            { code: (children) => <Code>{children}</Code> }, { cloud: urls.cloud, internal: urls.internal,
              hint: me.cloud_agent_base_url || me.public_base_url ? M.theAddressIsSetByThe : M.ifTheAgentRunsOnAnother })}
        </p>
        <Snippets mcpUrl={urls.cloud} />
      </details>
    </>
  );
}
