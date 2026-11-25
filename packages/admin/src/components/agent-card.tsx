import { AGENT_CARD_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import type { ReactNode } from "react";
import type { FormAction } from "@/components/action-form";
import { ActionForm } from "@/components/action-form";
import { Icon, type IconName } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { AGENT_INFO } from "@/lib/connect-agents";
import { CLIENT_KIND_TITLES, clientKindTitle, isClientKind } from "@/lib/labels";
import type { OAuthConnection } from "@/lib/oauth-connect";
import { formatDay, KEYS_PLAIN } from "@/lib/plain";
import type { MyKey } from "@/lib/types";

export const kindIcon = (kind: string | null | undefined): IconName =>
  kind === "claude_code" ? AGENT_INFO.claude_code.icon : kind === "codex" ? AGENT_INFO.codex.icon : kind === "cursor" ? AGENT_INFO.cursor.icon : kind === "script" ? "terminal" : "bot";

export const keyProgram = (k: Pick<MyKey, "client_kind">): string => (isClientKind(k.client_kind) ? CLIENT_KIND_TITLES[k.client_kind] : AGENT_CARD_TEXT.cloudAgent);

export const keyName = (k: Pick<MyKey, "client_label" | "client_kind" | "created_at">): string =>
  k.client_label?.trim() || KEYS_PLAIN.noLabel(isClientKind(k.client_kind) ? CLIENT_KIND_TITLES[k.client_kind] : AGENT_CARD_TEXT.agent, formatDay(k.created_at));

const expiredKey = (k: Pick<MyKey, "expires_at">, now: number): boolean => Boolean(k.expires_at && Date.parse(k.expires_at) <= now);

function KeyState({ k, now }: { k: MyKey; now: number }) {
  if (k.revoked_at) return <span className="ag-s off"><Icon name="x" />{KEYS_PLAIN.revoked} · <LocalTime iso={k.revoked_at} short /></span>;
  if (expiredKey(k, now)) return <span className="ag-s off"><Icon name="clock" />{KEYS_PLAIN.expired}</span>;
  return k.last_used_at
    ? <span className="ag-s ok"><Icon name="check" />{KEYS_PLAIN.connected} · <LocalTime iso={k.last_used_at} short /></span>
    : <span className="ag-s wait"><Icon name="clock" />{KEYS_PLAIN.waiting}</span>;
}

export function KeyCard({ k, revoke, children, now = Date.now() }: { k: MyKey; revoke?: FormAction; children?: ReactNode; now?: number }) {
  const name = keyName(k);
  return (
    <li className={`ag-card${k.revoked_at || expiredKey(k, now) ? " off" : ""}`} title={AGENT_CARD_TEXT.keyPrefix(k.key_prefix)}>
      <span className="ichip sm tone-violet"><Icon name={kindIcon(k.client_kind)} /></span>
      <div className="ag-main">
        <b className="ag-name">{name}</b>
        <small>{keyProgram(k)} · {k.expires_at ? AGENT_CARD_TEXT.validThrough(formatDay(k.expires_at)) : AGENT_CARD_TEXT.noExpiry}</small>
        <KeyState k={k} now={now} />
        {children}
      </div>
      {revoke && !k.revoked_at && !k.current ? (
        <div className="ag-act">
          <ActionForm action={revoke} compact danger submitLabel={KEYS_PLAIN.revoke} pendingLabel="…" confirm={KEYS_PLAIN.revokeConfirm(name)}>
            <input type="hidden" name="id" value={k.id} />
          </ActionForm>
        </div>
      ) : null}
    </li>
  );
}

/** Connection apps beyond the key kinds (sign-in from outside and the built-in agent sign-in): VS Code, Claude Desktop, another local app. */
import { CONNECTION_KIND_TITLES } from "../messages/components";
export const connectionKindTitle = (kind: string | null | undefined): string => (kind && Object.hasOwn(CONNECTION_KIND_TITLES, kind) ? CONNECTION_KIND_TITLES[kind]! : clientKindTitle(kind));

/** How the connection signed in: from outside through the edge, the built-in sign-in of this memory (consent in the workplace) or the company identity provider. */
const connectionWay = (origin: OAuthConnection["origin"]): string =>
  origin === "edge" ? AGENT_CARD_TEXT.edgeSignIn : origin === "builtin" ? AGENT_CARD_TEXT.workspaceSignIn : AGENT_CARD_TEXT.companySignIn;
const reconnectHint = (origin: OAuthConnection["origin"]): string =>
  origin === "edge" ? AGENT_CARD_TEXT.reconnectEdge
    : origin === "builtin" ? AGENT_CARD_TEXT.reconnectBuiltin
    : AGENT_CARD_TEXT.reconnectCompany;

export function ConnectionCard({ c, disconnect }: { c: OAuthConnection; disconnect?: FormAction }) {
  const title = connectionKindTitle(c.client_kind);
  return (
    <li className={`ag-card${c.status === "active" ? "" : " off"}`}>
      <span className="ichip sm tone-violet"><Icon name={kindIcon(c.client_kind)} /></span>
      <div className="ag-main">
        <b className="ag-name">{title}</b>
        <small>{rich(AGENT_CARD_TEXT.connectionExpiry, null, { value1: connectionWay(c.origin), value2: <LocalTime iso={c.expires_at} short relative={false} /> })}</small>
        <span className={`ag-s ${c.status === "active" ? "ok" : "wait"}`}><Icon name={c.status === "active" ? "check" : "clock"} />{c.status === "active" ? (c.last_used_at ? <>{KEYS_PLAIN.connected} · <LocalTime iso={c.last_used_at} short /></> : KEYS_PLAIN.connected) : c.status === "expired" ? KEYS_PLAIN.expired : AGENT_CARD_TEXT.disconnected}</span>
        {c.status === "active" && c.expires_warning ? <small className="ag-line ag-warn" role="note" data-expires-warning="">{c.expires_warning}</small> : null}
      </div>
      {disconnect && c.status === "active" ? (
        <div className="ag-act">
          <ActionForm action={disconnect} compact danger submitLabel={AGENT_CARD_TEXT.disconnect} pendingLabel="…" confirm={AGENT_CARD_TEXT.disconnectConfirm(title, reconnectHint(c.origin))}>
            <input type="hidden" name="id" value={c.id} />
          </ActionForm>
        </div>
      ) : null}
    </li>
  );
}
