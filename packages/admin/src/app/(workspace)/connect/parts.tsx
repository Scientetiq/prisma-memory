import { partsText as M } from "@/messages/ws-connect";
import { rich } from "@/i18n/rich";
import { derivedList } from "@/i18n/runtime";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyBlock } from "@/components/copy-block";
import { Icon, type IconName } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { AGENT_INFO, CONNECT_AGENTS, connectHref, type ConnectAgent, type Connected } from "@/lib/connect-agents";
import { KeyCaps } from "@/components/mocks";
import { CONNECT_OSES, OS_GUIDE, OS_TITLE, osShell, type ConnectOs } from "@/lib/connect-os";
import { clientKindTitle } from "@/lib/labels";
import { BUILTIN_CONNECT_TEXT, BUILTIN_IT_CLIENTS, builtinCommands, builtinCursorDeeplink, builtinCursorMcpJson, type AgentAuthConnect, type OAuthConnectConfig, type OAuthConnection } from "@/lib/oauth-connect";
import { CONNECT_PLAIN } from "@/lib/plain";
import type { MyKey } from "@/lib/types";
import { ConnectionCard, KeyCard } from "@/components/agent-card";
import { revokeMyKeyAction } from "../actions";
import { revokeConnectionAction } from "./actions";

export { kindIcon } from "@/components/agent-card";

const OS_ICON: Record<ConnectOs, IconName> = { mac: "command", windows: "grid", linux: "terminal" };

export function AgentPicker({ agent, os, auto, via, keyOnly, hideOs = false }: { agent: ConnectAgent; os: ConnectOs; auto: boolean; via: "key" | null; keyOnly: ReadonlySet<ConnectAgent>; hideOs?: boolean }) {
  return <>
    <ul className="cn-tiles" aria-label={M.agent}>
      {CONNECT_AGENTS.map((a) => {
        const on = a === agent, info = AGENT_INFO[a];
        return (
          <li key={a}>
            <Link href={connectHref({ agent: a, os, via })} prefetch={false} scroll={false} aria-current={on ? "true" : undefined} className={`cn-tile${on ? " on" : ""}`}>
              <span className={`ichip tone-${on ? "violet" : "gray"}`}><Icon name={info.icon} /></span>
              <span className="cn-tile-t"><b>{info.title}</b><small>{info.by}</small>{keyOnly.has(a) ? <span className="chip amber">{rich(M.usingAKeyForNow, null)}</span> : null}</span>
              {on ? <span className="cn-tick"><Icon name="check" /><span className="vis-hidden">{rich(M.selected, null)}</span></span> : null}
            </Link>
          </li>
        );
      })}
    </ul>
    {hideOs ? null : <div className="cn-os" data-dirty-owner="os">
      <span className="cn-os-label" id="cn-os-label">{rich(M.computer, null)}</span>
      <ul aria-labelledby="cn-os-label">
        {CONNECT_OSES.map((o) => (
          <li key={o}>
            <Link href={connectHref({ agent, os: o, via })} prefetch={false} scroll={false} aria-current={o === os ? "true" : undefined} className={o === os ? "on" : undefined}>
              <Icon name={o === os ? "check" : OS_ICON[o]} />{OS_TITLE[o]}
            </Link>
          </li>
        ))}
      </ul>
      {auto ? <span className="cn-auto"><Icon name="sparkles" />{CONNECT_PLAIN.autoOs}</span> : null}
    </div>}
  </>;
}

export function InstallHint({ agent, os }: { agent: ConnectAgent; os: ConnectOs }) {
  const info = AGENT_INFO[agent], install = info.install;
  if (!install) return null;
  if ("url" in install) return (
    <p className="cn-hint"><Icon name="download" /><span>{rich(M.mustBeInstalledNotInstalledDownload, { tag0: (children) => <a href={install.url} target="_blank" rel="noreferrer">{children}</a> }, { value0: info.title, value1: info.title })}</span></p>
  );
  const cmd = install[osShell(os)];
  const g = OS_GUIDE[os];
  return (
    <details className="cn-install">
      <summary>{rich(M.mustBeInstalledNotInstalledHow, null, { value0: info.title })}</summary>
      <p className="cn-sub">{rich(M.open, null, { value0: g.app })}</p><KeyCaps steps={g.open} />
      <p className="cn-sub">{rich(M.pasteTheCommandAndPressEnter, null)}</p>
      <CopyBlock text={cmd} label={M.installationCommandFor(info.title)} wrap />
      <p className="cn-note">{rich(M.whenInstallationFinishesCloseTheWindow, null)}</p>
    </details>
  );
}

export function StatusCard({ items }: { items: readonly Connected[] }) {
  return (
    <div className="cn-done">
      <span className="ichip tone-green"><Icon name="circle-check" /></span>
      <div className="cn-done-main">
        <p className="cn-done-head">{rich(M.alreadyConnected, null)}</p>
        <ul>
          {items.map((c) => (
            <li key={c.kind}><b>{rich(M.isConnected, null, { value0: clientKindTitle(c.kind) })}</b> · <LocalTime iso={c.at} short />{c.byKey ? <span className="chip muted">{rich(M.withAKey, null)}</span> : null}</li>
          ))}
        </ul>
      </div>
      <a href="#step-agent" className="quiet">{rich(M.connectAnother, null)}</a>
      <a href="#agents" className="quiet">{rich(M.yourAgents, null)}</a>
    </div>
  );
}

export { LiveLine, UnknownLine } from "./live-line";

export function AgentsList({ keys, conns }: { keys: readonly MyKey[]; conns: readonly OAuthConnection[] }) {
  return (
    <ul className="agents ag-cards" data-dirty-owner="agents">
      {keys.map((k) => <KeyCard key={k.id} k={k} revoke={revokeMyKeyAction} />)}
      {conns.map((c) => <ConnectionCard key={c.id} c={c} disconnect={revokeConnectionAction} />)}
    </ul>
  );
}

export function FaqCard({ icon, q, children }: { icon: IconName; q: string; children: ReactNode }) {
  return <li><span className="ichip sm tone-gray"><Icon name={icon} /></span><div><b>{q}</b><p>{children}</p></div></li>;
}

const CALLBACKS: ReadonlyArray<[string, string, string?]> = derivedList(() => ([
  ["Claude Code", "http://localhost:8766/callback"],
  ["Codex", "http://127.0.0.1/…", M.codexMcpAddPrintsTheExact],
  ["Cursor", "http://localhost:8787/callback"],
]));

/**
 * Parameters for the IT person: agent sign-in (the identity provider, or the built-in sign-in when it is on), the memory
 * address, the skill. Labels and values are Russian in every branch, like the rest of the workplace.
 */
export function ItParams({ oauth, mcpUrl, skill, builtin = null }: { oauth: OAuthConnectConfig | null; mcpUrl: string; skill: ReactNode; builtin?: AgentAuthConnect | null }) {
  return (
    <details className="cn-it">
      <summary>{CONNECT_PLAIN.itParams}</summary>
      <dl className="oauth-parameters">
        {builtin ? <>
          <dt>{rich(M.mcpAddressAndAudience, null)}</dt><dd><code>{builtin.mcp_url}</code></dd>
          <dt>{rich(M.signInServerIssuer, null)}</dt><dd><code>{builtin.issuer}</code></dd>
          <dt>{M.clientId}</dt><dd>{BUILTIN_IT_CLIENTS.map((c, i) => <span key={c.id}>{i ? "; " : ""}<code>{c.id}</code> — {c.title}{c.offBySeed ? M.offAnAdministratorCanEnableIt : ""}</span>)}</dd>
          <dt>{M.scope}</dt><dd><code>mcp:memory</code></dd>
          <dt>{rich(M.clientType, null)}</dt><dd>{rich(M.publicWithoutASecretAuthorizationCode, null)}</dd>
        </> : oauth ? <>
          <dt>{rich(M.mcpAddressAndAudience, null)}</dt><dd><code>{oauth.resource_url}</code></dd>
          <dt>{rich(M.signInServerIssuer, null)}</dt><dd><code>{oauth.issuer}</code></dd>
          <dt>{M.clientId}</dt><dd>{Object.entries(oauth.allowed_clients).map(([id, k], i) => <span key={id}>{i ? "; " : ""}<code>{id}</code> — {clientKindTitle(k)}</span>)}</dd>
          <dt>{M.scope}</dt><dd><code>{oauth.scope}</code></dd>
          <dt>{rich(M.clientType, null)}</dt><dd>{rich(M.publicWithoutASecretAuthorizationCode2, null)}</dd>
          <dt>{rich(M.redirectAddresses, null)}</dt><dd>{CALLBACKS.map(([p, u, note], i) => <span key={p}>{i ? "; " : ""}{p} — <code>{u}</code>{note ? ` (${note})` : ""}</span>)}</dd>
          <dt>{rich(M.connectionLifetime, null)}</dt><dd>{rich(M.upToDaysFromFirstUse, null, { value0: oauth.connection_days })}</dd>
        </> : <>
          <dt>{rich(M.mcpAddress, null)}</dt><dd><code>{mcpUrl}</code></dd>
          <dt>{rich(M.authorisation, null)}</dt><dd>{rich(M.headerAuthorizationBearerStreamableHttpTransport, { tag0: (children) => <code>{children}</code> })}</dd>
        </>}
        {skill}
      </dl>
    </details>
  );
}

/**
 * "Connect with sign-in" (built-in agent sign-in): the memory address with a copy button and one entry
 * per app. The commands keep the pre-registered client IDs — they work even when the memory cannot reach app documents;
 * claude.ai, ChatGPT and VS Code connect without one (their own app documents). Every value in a command is quoted for the
 * chosen system's shell. English first, like the consent screen.
 */
export function BuiltinConnect({ cfg, os }: { cfg: AgentAuthConnect; os: ConnectOs }) {
  const T = BUILTIN_CONNECT_TEXT, url = cfg.mcp_url, cmds = builtinCommands(url, osShell(os));
  return (
    <div className="cn-builtin" lang="en">
      <p className="cn-sub"><b>{T.address}</b></p>
      <CopyBlock text={url} label={T.address} />
      {cfg.cimd_needs_egress ? <p className="notice warn" data-builtin="needs_egress">{T.needs_egress}</p> : null}
      <ul className="cn-builtin-apps">
        <li data-app="claude_ai"><b>{T.claude_ai}</b><p>{T.claude_ai_steps}</p><p className="cn-note">{T.claude_ai_fallback}</p></li>
        <li data-app="chatgpt"><b>{T.chatgpt}</b><p>{T.chatgpt_steps}</p><p className="cn-note">{T.chatgpt_fallback}</p><p className="cn-note" data-builtin="chatgpt_domain">{T.chatgpt_domain}</p></li>
        <li data-app="claude_code"><b>{T.claude_code}</b><p>{T.claude_code_steps}</p><CopyBlock text={cmds.claude_code} label={T.claude_code} /></li>
        <li data-app="codex"><b>{T.codex}</b><p>{T.codex_steps}</p><CopyBlock text={cmds.codex} label={T.codex} /><p className="cn-note">{T.codex_login}</p><CopyBlock text={cmds.codex_login} label={T.codex} /></li>
        <li data-app="cursor"><b>{T.cursor}</b><p>{T.cursor_steps}</p><a href={builtinCursorDeeplink(url)} className="btn"><Icon name="plus" />{T.cursor_button}</a><CopyBlock text={builtinCursorMcpJson(url)} label={T.cursor} /></li>
        <li data-app="vscode"><b>{T.vscode}</b><p>{T.vscode_steps}</p></li>
        <li data-app="other"><b>{T.other}</b><p>{T.other_steps}</p></li>
      </ul>
      <p className="cn-note">{T.duration}</p>
    </div>
  );
}
