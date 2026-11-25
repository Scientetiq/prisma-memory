import { MOCKS_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import { MCP_SERVER_NAME } from "../lib/mcp-server-name";
import { Fragment, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import type { ConnectOs, KeyStep } from "@/lib/connect-os";

import { KEYS } from "../messages/components";

function Key({ name }: { name: string }) {
  const k = KEYS[name] ?? { label: name.toUpperCase() };
  return (
    <kbd className={`mk-key${k.wide ? " wide" : ""}`}>
      {k.glyph ? <span className="mk-glyph" aria-hidden="true">{k.glyph}</span> : null}
      <span aria-hidden={k.sr ? true : undefined}>{k.label}</span>
      {k.sr ? <span className="vis-hidden">{k.sr}</span> : null}
    </kbd>
  );
}

export function KeyCaps({ steps, className }: { steps: readonly KeyStep[]; className?: string }) {
  return (
    <p className={`mk-keys${className ? ` ${className}` : ""}`}>
      {steps.map((s, i) => (
        <span className="mk-step" key={i}>
          {"keys" in s ? (
            <span className="mk-combo">
              {s.keys.map((k, j) => <Fragment key={k}>{j ? <span className="mk-plus" aria-hidden="true">+</span> : null}<Key name={k} /></Fragment>)}
            </span>
          ) : <span className="mk-say">{s.say}</span>}
          {i < steps.length - 1 ? <span className="mk-then"><Icon name="arrow" /><span className="vis-hidden">{MOCKS_TEXT.then}</span></span> : null}
        </span>
      ))}
    </p>
  );
}

const Ctl = ({ d }: { d: string }) => <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d={d} /></svg>;
const MIN = "M1 5h8", MAX = "M1.5 1.5h7v7h-7z", CLOSE = "M1.5 1.5l7 7M8.5 1.5l-7 7";

function WindowBar({ os, title, icon }: { os: ConnectOs; title: string; icon?: ReactNode }) {
  return (
    <div className={`mk-bar mk-bar-${os}`} aria-hidden="true">
      {os === "mac" ? <span className="mk-dots"><i /><i /><i /></span> : null}
      <span className="mk-title">{icon}{title}</span>
      {os === "windows" ? <span className="mk-wctl"><Ctl d={MIN} /><Ctl d={MAX} /><Ctl d={CLOSE} /></span> : null}
      {os === "linux" ? <span className="mk-gctl"><i><Ctl d={MIN} /></i><i><Ctl d={MAX} /></i><i><Ctl d={CLOSE} /></i></span> : null}
    </div>
  );
}

const PsIcon = () => <span className="mk-ps-ic" aria-hidden="true">{">_"}</span>;

function promptOf(os: ConnectOs, user: string): string {
  return os === "windows" ? `PS C:\\Users\\${user}>` : os === "linux" ? `${user}@ubuntu:~$` : `${user}@MacBook ~ %`;
}
const safeUser = (u?: string | null): string => (u && /^[A-Za-z0-9._-]{1,24}$/.test(u) ? u : "user");

export function TerminalMock({ os, lines = [], user, caption, title, className }: {
  os: ConnectOs; lines?: readonly string[]; user?: string | null; caption?: ReactNode; title?: string; className?: string;
}) {
  const prompt = promptOf(os, safeUser(user));
  const name = title ?? (os === "windows" ? MOCKS_TEXT.powerShell : MOCKS_TEXT.terminal);
  return (
    <figure className={`mk${className ? ` ${className}` : ""}`}>
      <div className={`mk-win mk-term mk-term-${os}`}>
        <WindowBar os={os} title={name} icon={os === "windows" ? <PsIcon /> : null} />
        <div className="mk-term-body">
          {lines.map((l, i) => (
            <div className="mk-line" key={i}><span className="mk-prompt" aria-hidden="true">{prompt}</span><code className="mk-cmd">{l}</code></div>
          ))}
          <div className="mk-line" aria-hidden="true"><span className="mk-prompt">{prompt}</span><span className="mk-caret" /></div>
        </div>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export function LauncherMock({ os, app, caption }: { os: ConnectOs; app: string; caption?: ReactNode }) {
  if (os === "linux") return null;
  return (
    <figure className="mk">
      <div className={`mk-launch mk-launch-${os}`} aria-hidden="true"><div className="mk-launch-box">
        <div className="mk-launch-q"><Icon name="search" /><span>{app}</span><span className="mk-caret" /></div>
        {os === "windows" ? <p className="mk-launch-h">{MOCKS_TEXT.bestMatch}</p> : null}
        <div className="mk-launch-hit">
          {os === "windows" ? <PsIcon /> : <span className="mk-term-ic">{">_"}</span>}
          <span><b>{os === "windows" ? MOCKS_TEXT.powerShell : app}</b><small>{os === "windows" ? MOCKS_TEXT.application : MOCKS_TEXT.program}</small></span>
          <span className="mk-enter">↵</span>
        </div>
      </div></div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export function BrowserMock({ os, host, tab, children, caption, className }: {
  os: ConnectOs; host: string; tab: string; children: ReactNode; caption?: ReactNode; className?: string;
}) {
  return (
    <figure className={`mk${className ? ` ${className}` : ""}`}>
      <div className="mk-win mk-browser">
      <div className="mk-chrome" aria-hidden="true">
        <div className="mk-tabs">
          {os === "mac" ? <span className="mk-dots"><i /><i /><i /></span> : null}
          <span className="mk-tab"><span className="mk-fav" />{tab}</span>
          {os !== "mac" ? <span className="mk-wctl"><Ctl d={MIN} /><Ctl d={MAX} /><Ctl d={CLOSE} /></span> : null}
        </div>
        <div className="mk-toolbar">
          <span className="mk-nav"><Icon name="arrow-left" /><Icon name="arrow" /><Icon name="refresh" /></span>
          <span className="mk-url"><Icon name="lock" /><span>{host}</span></span>
        </div>
      </div>
      <div className="mk-page">{children}</div>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export const Callout = ({ n }: { n: number }) => <span className="mk-callout" aria-hidden="true">{n}</span>;

/**
 * A generic company sign-in page (the single sign-on server's own page): a plain dark background, the heading of the
 * catalogue («Example Corp · …»), a white card with a blue strip, English labels. It is a picture: it has no fields or
 * buttons, so neither the browser nor a password manager takes it for a form. callouts — markers ① (user name and
 * password) and ② (the button).
 */
export function SignInPage({ callouts = false }: { callouts?: boolean }) {
  return (
    <div className="mk-kc" aria-hidden="true">
      <p className="mk-kc-brand">{rich(MOCKS_TEXT.companySignIn, { mark1: (children) => <b>{children}</b> })}</p>
      <div className="mk-kc-card" lang="en">
        <div className="mk-kc-head"><span className="mk-kc-h">{MOCKS_TEXT.signInHeading}</span><span className="mk-kc-lang">{MOCKS_TEXT.english}<Icon name="chevron-down" /></span></div>
        <div className="mk-kc-creds">
          {callouts ? <Callout n={1} /> : null}
          <span className="mk-kc-label">{MOCKS_TEXT.username}</span>
          <span className="mk-kc-input focus" />
          <span className="mk-kc-label">{MOCKS_TEXT.password}</span>
          <span className="mk-kc-input pw"><span className="mk-kc-dots">••••••••</span><span className="mk-kc-eye"><Icon name="eye" /></span></span>
        </div>
        <span className="mk-kc-check"><span className="mk-kc-box" />{MOCKS_TEXT.rememberMe}</span>
        <span className="mk-kc-btn">{callouts ? <Callout n={2} /> : null}{MOCKS_TEXT.signIn}</span>
      </div>
    </div>
  );
}

export function SuccessTab({ os, host, caption, className }: { os: ConnectOs; host: string; caption?: ReactNode; className?: string }) {
  return (
    <BrowserMock os={os} host={host} tab={host.split(":")[0]!} caption={caption} className={`mk-sm${className ? ` ${className}` : ""}`}>
      <div className="mk-ok" aria-hidden="true" lang="en">
        <span className="mk-ok-ic"><Icon name="check" /></span>
        <b>{MOCKS_TEXT.authenticated}</b>
        <span>{MOCKS_TEXT.closeWindow}</span>
      </div>
    </BrowserMock>
  );
}

export function CursorInstallMock({ os, host, caption }: { os: ConnectOs; host: string; caption?: ReactNode }) {
  return (
    <figure className="mk">
      <div className="mk-win mk-dark">
      <WindowBar os={os} title="Cursor" />
      <div className="mk-cur-dim" aria-hidden="true" lang="en">
        <div className="mk-cur-dialog">
          <span className="mk-cur-dlg-ic"><Icon name="plug" /></span>
          <b>{MOCKS_TEXT.installServer}</b>
          <span className="mk-cur-name">{MCP_SERVER_NAME}</span>
          <span className="mk-cur-url">{host}</span>
          <span className="mk-cur-btns"><span>{MOCKS_TEXT.cancelInstall}</span><span className="mk-cur-go">{MOCKS_TEXT.install}</span></span>
        </div>
      </div>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export interface ChatTurn { who: "user" | "agent" | "tool"; text: string }
export type ChatLook = "claude_code" | "codex" | "cursor";

const toolLine = (look: ChatLook, tool: string): ReactNode =>
  look === "claude_code" ? <><b>{MCP_SERVER_NAME}</b> · {tool}</> : look === "codex" ? rich(MOCKS_TEXT.toolCalled, { app: (children) => <b>{children}</b> }, { tool, server: MCP_SERVER_NAME }) : <><span className="mk-mcp">MCP</span>{tool}</>;

const GLYPH: Record<ChatLook, Record<ChatTurn["who"], string>> = {
  claude_code: { user: ">", tool: "⏺", agent: "⏺" },
  codex: { user: "›", tool: "•", agent: "•" },
  cursor: { user: "", tool: "", agent: "" },
};
import { WHO } from "../messages/components";

export function AgentChatMock({ look, os, turns, caption, user }: { look: ChatLook; os: ConnectOs; turns: readonly ChatTurn[]; caption?: ReactNode; user?: string | null }) {
  const body = turns.map((t, i) => (
    <p key={i} className={`mk-turn ${t.who}`}>
      {GLYPH[look][t.who] ? <span className="mk-gl" aria-hidden="true">{GLYPH[look][t.who]}</span> : null}
      <span className="vis-hidden">{WHO[t.who]}</span>
      <span className="mk-tx">{t.who === "tool" ? toolLine(look, t.text) : t.text}</span>
    </p>
  ));
  if (look === "cursor") return (
    <figure className="mk">
      <div className="mk-win mk-dark mk-chat-cursor">
      <WindowBar os={os} title="Cursor" />
      <div className="mk-cur">
        <div className="mk-cur-side" aria-hidden="true"><i /><i /><i /><i /></div>
        <div className="mk-cur-chat">
          <p className="mk-cur-head" aria-hidden="true"><Icon name="message-square" />{MOCKS_TEXT.agentHeading}</p>
          {body}
          <div className="mk-cur-input" aria-hidden="true"><span>{MOCKS_TEXT.chatPrompt}</span><span className="mk-caret" /></div>
        </div>
      </div>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
  return (
    <figure className="mk">
      <div className={`mk-win mk-term mk-term-${os} mk-chat-${look}`}>
      <WindowBar os={os} title={os === "windows" ? MOCKS_TEXT.powerShell : MOCKS_TEXT.terminal} icon={os === "windows" ? <PsIcon /> : null} />
      <div className="mk-term-body">
        <div className="mk-line" aria-hidden="true"><span className="mk-prompt">{promptOf(os, safeUser(user))}</span><code className="mk-cmd">{look === "codex" ? "codex" : "claude"}</code></div>
        <div className="mk-welcome" aria-hidden="true">
          {look === "claude_code" ? <><span className="mk-star">✻</span>{rich(MOCKS_TEXT.welcome, { app: (children) => <b>{children}</b> })}</> : <><b>{MOCKS_TEXT.codexBrand}</b> <span>{MOCKS_TEXT.directory}</span></>}
        </div>
        {body}
        <div className="mk-chat-input" aria-hidden="true"><span>{look === "codex" ? "›" : ">"}</span><span className="mk-caret" /></div>
      </div>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
