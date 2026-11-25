"use client";
import { keyWizardText as M } from "@/messages/ws-connect";
import { rich } from "@/i18n/rich";
import { MCP_SERVER_NAME, SERVER_PARAM } from "@/lib/mcp-server-name";

import { useActionState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { FormAction } from "@/components/action-form";
import { CopyBlock } from "@/components/copy-block";
import { DirtyGuard } from "@/components/dirty-guard";
import { Icon } from "@/components/icons";
import { KeyCaps, TerminalMock } from "@/components/mocks";
import { defaultKeyLabel, CONNECT_AGENT_TEXT } from "@/lib/connect-agents";
import { codexKeyLineFor, OS_GUIDE, type ConnectOs } from "@/lib/connect-os";
import { CONNECT_PLAIN } from "@/lib/plain";
import { claudeCodeSnippet, codexConfigBlock, cursorSnippet } from "@/lib/snippets";
import type { AgentFailure } from "@/lib/agent-status";
import { CopyButton } from "./copy-button";
import { LiveLine, UnknownLine } from "./live-line";
import { ConnectWatch } from "./live-status";
import { Step } from "./step";

export type WizardProgram = "claude_code" | "codex" | "cursor" | "cloud_other";

function Paste({ os, multiline }: { os: ConnectOs; multiline: boolean }) {
  const g = OS_GUIDE[os];
  return <>
    <p className="cn-sub">{rich(M.open, null, { value0: g.app })}</p><KeyCaps steps={g.open} />
    <p className="cn-sub">{rich(M.pasteAndRun, null)}</p><KeyCaps steps={g.paste} />
    {multiline && g.pasteNote ? <p className="cn-note">{g.pasteNote}</p> : null}
  </>;
}

function insertFor({ program, os, mcpUrl, secret, user }: { program: WizardProgram; os: ConnectOs; mcpUrl: string; secret: string; user?: string | null }): { body: ReactNode; aside: ReactNode } {
  if (program === "claude_code") {
    const cmd = claudeCodeSnippet(mcpUrl, secret);
    return { body: <>
      <CopyButton text={cmd} label={M.commandForClaudeCode}>{rich(M.copyCommand, null)}</CopyButton>
      <Paste os={os} multiline={cmd.includes("\n")} />
      <p className="cn-note">{rich(M.closeOpenItAgainTypeClaude, { tag0: (children) => <code className="code">{children}</code>, tag1: (children) => <code className="code">{children}</code>, tag2: (children) => <b>{children}</b> }, { value0: OS_GUIDE[os].app, server: MCP_SERVER_NAME })}</p>
    </>, aside: <TerminalMock os={os} lines={[cmd]} user={user} caption={M.thisIsHowTheCommandLooks} /> };
  }
  if (program === "codex") {
    const line = codexKeyLineFor(os, secret);
    return { body: <>
      <CopyButton text={line} label={M.keyForCodex}>{rich(M.copyCommand, null)}</CopyButton>
      <Paste os={os} multiline={line.includes("\n")} />
      <p className="cn-sub">{rich(M.thenAddThisToTheEnd, { tag0: (children) => <code className="code">{children}</code> }, { value0: os === "windows" ? "%USERPROFILE%\\.codex\\config.toml" : "~/.codex/config.toml" })}</p>
      <CopyBlock text={codexConfigBlock(mcpUrl)} label={M.codexSettings} />
      <p className="cn-note">{rich(M.codexTheMcpCommandWillShow, { tag0: (children) => <code className="code">{children}</code>, tag1: (children) => <b>{children}</b> }, { value0: os === "windows" ? M.closeAndReopenPowershellThenRestart : M.restart, server: MCP_SERVER_NAME })}</p>
    </>, aside: <TerminalMock os={os} lines={[line]} user={user} caption={M.theCommandSavesTheKeyFor} /> };
  }
  if (program === "cursor") return { body: <>
    <p className="cn-sub">{rich(M.inCursorOpenSettingsMcpAdd, { tag0: (children) => <b>{children}</b>, tag1: (children) => <code className="code">{children}</code>, tag2: (children) => <code className="code">{children}</code> }, SERVER_PARAM)}</p>
    <CopyBlock text={cursorSnippet(mcpUrl, secret)} label={M.cursorSettings} />
    <p className="cn-note">{rich(M.saveTheFileAGreenDot, { tag0: (children) => <b>{children}</b> }, SERVER_PARAM)}</p>
  </>, aside: null };
  return { body: <>
    <p className="cn-sub">{rich(M.inYourProgramSMcpSettings, { tag0: (children) => <b>{children}</b> })}</p>
    <CopyBlock text={mcpUrl} label={M.serverAddress} />
    <p className="cn-sub">{rich(M.authorisationHeader, null)}</p>
    {/* i18n-ignore: literal HTTP header copied as code */}
    <CopyBlock text={`Authorization: Bearer ${secret}`} label={M.authorisationHeader2} />
  </>, aside: null };
}

export function KeyWizard({ action, mcpUrl, remaining, expiry, program, title, os, user, used, unknown = null, taken = [], again = false }: {
  action: FormAction; mcpUrl: string; remaining: number | null; expiry: { value: string; min: string; max: string; maxDays: number };
  program: WizardProgram; title: string; os: ConnectOs; user?: string | null;
  used: Readonly<Record<string, string | null>>;
  unknown?: AgentFailure | null;
  taken?: readonly (string | null)[];
  again?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();
  const secret = state?.ok && state.secret ? state.secret.value : null;
  const issued = secret && state?.keyId ? state.keyId : null;
  const exhausted = remaining !== null && remaining <= 0;
  const insert = secret ? insertFor({ program, os, mcpUrl, secret, user }) : null;
  const other = program === "cloud_other";
  const label = other ? defaultKeyLabel(CONNECT_AGENT_TEXT.myProgram, null, taken) : defaultKeyLabel(title, os, taken);
  const issuedAt = issued ? used[issued] ?? null : null;

  const steps = <>
    <Step n={2} id="step-key" done={Boolean(secret)} title={other ? CONNECT_PLAIN.otherKeyTitle : M.getAKeyFor(title)}
      lead={secret ? null : M.aKeyLetsYourAgentAccess}>
      {secret ? (
        <p className="ok-text">{rich(M.yourKeyHasBeenIssuedAnd, null)}</p>
      ) : (
        <>
          {unknown ? <UnknownLine failure={unknown} /> : null}
          <form action={formAction} className="cn-key-form">
            <input type="hidden" name="client_kind" value={program} />
            <label className="field cn-label-field"><span className="field-label">{rich(M.whereItWillRun, null)}</span>
              <input key={label} type="text" name="client_label" maxLength={60} defaultValue={label} />
              <span className="field-hint">{rich(M.thisLabelHelpsYouRecogniseThe, null)}</span></label>
            <details className="cn-more-fields">
              <summary>{rich(M.keyExpiry, null)}</summary>
              <label className="field"><span className="field-label">{rich(M.validThrough, null)}</span>
                <input type="date" name="expires_at" required defaultValue={expiry.value} min={expiry.min} max={expiry.max} />
                <span className="field-hint">{rich(M.upToDaysAReminderWill, null, { value0: expiry.maxDays })}</span></label>
            </details>
            <button type="submit" className="btn primary cn-big" disabled={pending || exhausted}><Icon name="key" />{pending ? M.issuing : M.issueKey}</button>
            {state && !state.ok ? <p className="danger-text" role="alert">{state.message}</p> : null}
            {exhausted ? <p className="danger-text">{rich(M.youHaveReachedTheActiveKey, null)}</p> : null}
          </form>
        </>
      )}
    </Step>

    <Step n={3} id="step-paste" later={!secret} title={other ? CONNECT_PLAIN.otherPasteTitle : M.pasteTheKeyInto(title)} aside={insert?.aside ?? null}>
      {insert ? insert.body : <p className="muted">{rich(M.aCommandWithYourKeyWill, null)}</p>}
    </Step>

    <Step n={4} id="step-check" later={!secret} title={M.check}
      lead={<>{rich(M.askYourAgentWhoAmI, { tag0: (children) => <b>{children}</b> })}</>}>
      {secret && unknown ? <UnknownLine failure={unknown} id="check" /> : null}
      {secret && !unknown ? <LiveLine title={title} at={issuedAt} checkHref={null} waiting={CONNECT_PLAIN.waitingKey(state?.keyLabel)} /> : null}
      <ConnectWatch waiting={Boolean(issued) && !issuedAt && !unknown} />
      {secret && !unknown ? <button type="button" className="btn" onClick={() => router.refresh()}>{rich(M.checkConnection, { tag0: () => <Icon name="refresh" /> })}</button> : null}
    </Step>
  </>;

  return <>
    <DirtyGuard active={Boolean(secret)} question={CONNECT_PLAIN.keyLeave} />
    {again ? <details className="cn-again" open={secret ? true : undefined}><summary>{CONNECT_PLAIN.again}</summary>{steps}</details> : steps}
  </>;
}
