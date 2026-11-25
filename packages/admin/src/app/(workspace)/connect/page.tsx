import { pageText as M } from "@/messages/ws-connect";
import { rich } from "@/i18n/rich";
import { INSTALL_SKILL_COMMAND, INSTALL_SKILL_COMMAND_FULL, SERVER_PARAM } from "@/lib/mcp-server-name";
import { derived } from "@/i18n/runtime";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { CopyBlock } from "@/components/copy-block";
import { Icon } from "@/components/icons";
import { AgentChatMock, BrowserMock, Callout, CursorInstallMock, KeyCaps, LauncherMock, SignInPage, SuccessTab, TerminalMock, type ChatTurn } from "@/components/mocks";
import { CursorPager } from "@/components/pager";
import { Empty, LoadError, Notice, PageHead } from "@/components/ui";
import { agentStatus, failureOf } from "@/lib/agent-status";
import { authMethods } from "@/lib/auth-methods";
import { AGENT_INFO, CONNECT_AGENTS, connectHref, parseAgent, type ConnectAgent } from "@/lib/connect-agents";
import { OS_GUIDE, osShell, resolveOs, type ConnectOs } from "@/lib/connect-os";
import { inDaysUtc } from "@/lib/format";
import { call } from "@/lib/gateway";
import { PERSON_KEY_MAX_DAYS, PERSONAL_KEY_DEFAULT_DAYS } from "@/lib/labels";
import { oauthAgentConfig, publicOrigin, requireWorkspace } from "@/lib/me";
import { meGw, type MeResult } from "@/lib/me-api";
import { BUILTIN_CONNECT_TEXT, builtinSignIn, clientIdFor, connectVia, cursorDeeplink, cursorMcpJson, issuerHost, keycloakSignIn, oauthCommands, removeCommand, type OAuthConnectConfig, type OAuthConnectionsPage } from "@/lib/oauth-connect";
import { param, type SearchParams } from "@/lib/paging";
import { CONNECT_PLAIN } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import { parseSkillManifest, SKILL_FOLDERS, SKILL_MANIFEST_PATH, SKILL_NAME, skillArchiveName, skillArchiveUrl, skillCommand, skillPhrase, skillUrlInsecure, validSkillBase, type SkillProgram } from "@/lib/skill-install";
import { cloudMcpUrl } from "@/lib/snippets";
import type { Me, MyKeysPage } from "@/lib/types";
import { issueMyKeyAction } from "../actions";
import { CopyButton } from "./copy-button";
import { KeyWizard } from "./key-wizard";
import { ConnectWatch } from "./live-status";
import { AgentPicker, AgentsList, BuiltinConnect, FaqCard, InstallHint, ItParams, LiveLine, StatusCard, UnknownLine } from "./parts";
import { Step } from "./step";

export function generateMetadata(): Metadata { return { title: M.connectAnAgent }; }

async function loadSkillManifest(): Promise<{ version: string; sha: string; archiveName: string | null } | null> {
  try {
    const r = await call(SKILL_MANIFEST_PATH, { timeoutMs: 5_000 });
    const m = r.status === 200 ? parseSkillManifest(r.data) : null;
    // the archive file name too (gateway data, from the skill package description)
    return m ? { ...m, archiveName: skillArchiveName(r.data) } : null;
  } catch (e) {
    unstable_rethrow(e);
    return null;
  }
}

const loginUser = (login: string): string => login.split("@")[0]!.split("\\").pop()!;
const latest = (xs: ReadonlyArray<string | null | undefined>): string | null =>
  xs.reduce<string | null>((m, x) => (x && (!m || Date.parse(x) > Date.parse(m)) ? x : m), null);

function chatTurns(me: Me, version: string | null): ChatTurn[] {
  const n = me.spaces.length, dept = me.person.department?.trim();
  return [
    { who: "user", text: M.whoAmIInMemory },
    { who: "tool", text: "memory_me" },
    { who: "agent", text: M.identityReply(me.person.display_name, dept, n) },
    { who: "agent", text: M.theMemoryRulesAreNotInstalled },
    { who: "user", text: M.yes },
    { who: "agent", text: version ? M.memoryRulesInstalled(version) : M.memoryRulesInstalled2 },
  ];
}

const skillProgram = (agent: ConnectAgent): SkillProgram | null => (agent === "other" ? null : agent);

export default async function ConnectPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  if (session.preview) return <><PageHead title={CONNECT_PLAIN.title} /><Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice></>;
  const sp = await searchParams;
  const cursor = param(sp, "cursor");
  const agent = parseAgent(param(sp, "agent"));
  const { os, auto } = resolveOs(param(sp, "os"), await headers());
  const [config, connections, keys, origin, skill, methods] = await Promise.all([
    oauthAgentConfig(session.key),
    meGw<OAuthConnectionsPage>(session.key, "/api/v1/me/connections", { query: { limit: 50, cursor: cursor || undefined } }),
    meGw<MyKeysPage>(session.key, "/api/v1/me/keys", { query: { limit: 100 } }),
    publicOrigin(me),
    loadSkillManifest(),
    authMethods(),
  ]);
  const ssoOn = methods?.oidc.enabled === true;
  const mcpUrl = cloudMcpUrl(origin);
  // One skill name for the page — the archive address and file, the folder in it, the phrase and the command: from the
  // gateway manifest (archive.name, built from the skill package description), otherwise the panel copy of the description.
  const skillName = skill?.archiveName?.replace(/\.zip$/, "") ?? SKILL_NAME;
  const archiveUrl = skillArchiveUrl(origin, skillName);
  const archiveOk = validSkillBase(archiveUrl);
  // built-in agent sign-in of this memory: when it is on and ready, the identity provider commands are not shown at all.
  // identity provider commands — only while the mode is external: in builtin (ready or not) and off the gateway refuses those
  // connections, so built-in-not-ready and off fall back to the key path
  const builtin = config.ok ? builtinSignIn(config.data) : null;
  const oauth = !builtin && config.ok ? keycloakSignIn(config.data) : null;
  const signInOn = oauth !== null || builtin !== null;
  const via = connectVia(signInOn, param(sp, "via"));
  const keyVia = signInOn && via === "key" ? "key" as const : null;
  const info = AGENT_INFO[agent];
  const here = { agent, os, via: keyVia };
  const keyHref = connectHref({ agent, os, via: "key" });
  const oauthHref = connectHref({ agent, os });

  const now = Date.now();
  const status = agentStatus(keys, connections, now);
  const agentKeys = status.liveKeys;
  const conns = connections.ok ? connections.data.items : [];
  const connected = status.connected;
  const unknown = status.state === "unknown";
  const top = (checkShowsUnknown: boolean): ReactNode =>
    connected.length ? <StatusCard items={connected} /> : unknown && !checkShowsUnknown ? <UnknownLine failure={status.failure} /> : null;
  const limit = me.limits?.personal_keys_max?.limit ?? null;
  const remaining = limit !== null && keys.ok && !keys.data.next_cursor ? Math.max(0, limit - agentKeys.length) : null;
  const user = loginUser(me.person.login);
  const turns = chatTurns(me, skill?.version ?? null);
  const program = skillProgram(agent);

  const offers = agent === "claude_code";
  const phrase = archiveOk ? skillPhrase(archiveUrl, skill?.sha, program, skillName) : null;
  const rules: ReactNode = !phrase ? <Notice tone="danger">{rich(M.theMemoryAddressIsInvalidContact, null)}</Notice> : <>
    {offers ? <p className="cn-sub">{rich(M.theAgentWillOfferToInstall, null)}</p>
      : <p className="cn-sub">{rich(M.theAgentMayOfferToInstall, null)}</p>}
    <CopyButton text={phrase} label={M.phraseForTheAgent}>{rich(M.copyPhraseForTheAgent, null)}</CopyButton>
    {offers
      ? <p className="cn-note">{rich(M.typeAndPressEnter, { tag0: (children) => <code className="code cn-slash">{children}</code> }, { value0: CONNECT_PLAIN.noOffer, value1: INSTALL_SKILL_COMMAND })}</p>
      : <p className="cn-note">{rich(M.thePhraseTellsTheAgentTo, null)}</p>}
    {skillUrlInsecure(archiveUrl) ? <Notice tone="warn">{rich(M.theMemoryAddressDoesNotUse, null)}</Notice> : null}
  </>;
  const chat = agent === "other" ? null
    : <AgentChatMock look={agent} os={os} turns={turns} user={user}
      caption={offers ? M.thisIsHowItLooksThe : M.thisIsHowItMayLook} />;

  const step1 = (
    <Step n={1} id="step-agent" title={M.agentAndComputer} lead={M.whichProgramAndComputerYouUse}>
      <AgentPicker agent={agent} os={os} auto={auto} via={keyVia} hideOs={agent === "other"} keyOnly={new Set(oauth && via === "oauth" ? CONNECT_AGENTS.filter((a) => a !== "other" && !clientIdFor(oauth, AGENT_INFO[a].kind)) : [])} />
      <InstallHint agent={agent} os={os} />
      <p className="cn-hint"><Icon name="info" /><span>{CONNECT_PLAIN.notClaudeApp}</span></p>
    </Step>
  );

  if (via === "key") {
    const used = Object.fromEntries(agentKeys.filter((k) => (k.client_kind ?? "cloud_other") === info.kind).map((k) => [k.id, k.last_used_at]));
    const wizardUnknown = unknown || !keys.ok ? status.failure ?? failureOf(keys) : null;
    const again = connected.some((c) => c.kind === info.kind);
    const taken = status.liveKeys.map((k) => k.client_label);
    return <>
      <PageHead title={CONNECT_PLAIN.title} lead={CONNECT_PLAIN.keyLead} />
      {top(true)}
      {signInOn
        ? <p className="cn-path"><Icon name="key" /><span>{rich(M.connectTheAgentWithAPersonal, { tag0: (children) => <b>{children}</b>, tag1: (children) => <Link href={oauthHref} prefetch={false}>{children}</Link> }, { value0: CONNECT_PLAIN.keyWhen, value1: CONNECT_PLAIN.toOAuthLink })}</span></p>
        : null}
      <div className="cn-steps">
        {step1}
        <KeyWizard key={info.kind} action={issueMyKeyAction} mcpUrl={mcpUrl} remaining={remaining} program={info.kind} title={info.title} os={os} user={user}
          expiry={{ value: inDaysUtc(PERSONAL_KEY_DEFAULT_DAYS), min: inDaysUtc(1), max: inDaysUtc(PERSON_KEY_MAX_DAYS), maxDays: PERSON_KEY_MAX_DAYS }}
          used={used} unknown={wizardUnknown} taken={taken} again={again} />
        <Step n={5} id="step-rules" title={M.teachYourAgentTheMemoryRules} lead={M.theRulesTellYourAgentWhere} aside={chat}>
          {rules}
        </Step>
      </div>
      <Agents oauth={null} keys={keys} agentKeys={agentKeys} conns={conns} next={connections.ok ? connections.data.next_cursor : null} cursor={cursor} here={here} retry={!wizardUnknown} />
      <details className="faq-lite">
        <summary>{rich(M.somethingWentWrong, null)}</summary>
        <ul className="cn-faq">
          <FaqCard icon="lock" q={M.theAgentSaysItHasNo}>{rich(M.theResponseSaysUnauthorizedTheKey, null)}</FaqCard>
          <FaqCard icon="key" q={M.keyLost}>{rich(M.forSecurityAKeyCannotBe, { tag0: (children) => <Link href="/keys" prefetch={false}>{children}</Link> })}</FaqCard>
          <FaqCard icon="plug" q={M.theAgentCannotSeeMemory}>{rich(M.restartTheProgramAfterSetupMake, { tag0: (children) => <code className="code">{children}</code> }, { value0: mcpUrl })}</FaqCard>
          <SkillFaq agent={agent} os={os} archiveUrl={archiveOk ? archiveUrl : null} skillName={skillName} />
          <FaqCard icon="file" q={M.theAgentCannotFindADocument}>{rich(M.agentsCanOnlySeeOpenRecords, null)}</FaqCard>
        </ul>
      </details>
      <div className="cn-more">
        {signInOn ? <Link href={oauthHref} prefetch={false} className="cn-more-link"><Icon name="arrow-left" />{CONNECT_PLAIN.toOAuthLink}</Link> : null}
        <ItParams oauth={null} mcpUrl={mcpUrl} skill={<ItSkill archiveUrl={archiveOk ? archiveUrl : null} skillName={skillName} skill={skill} program={program} os={os} />} />
      </div>
    </>;
  }

  // --------------------------------------------------------------- built-in agent sign-in
  if (builtin) {
    return <>
      <PageHead title={CONNECT_PLAIN.title} lead={CONNECT_PLAIN.lead} />
      {top(false)}
      <div className="cn-steps">
        {/* the agent and the computer choose the shell quoting and the rules phrase; claude.ai connects too here */}
        <Step n={1} id="step-agent" title={M.agentAndComputer} lead={M.whichProgramAndComputerYouUse}>
          <AgentPicker agent={agent} os={os} auto={auto} via={null} hideOs={agent === "other"} keyOnly={new Set()} />
          <InstallHint agent={agent} os={os} />
        </Step>
        <Step n={2} id="step-signin" title={<span lang="en">{BUILTIN_CONNECT_TEXT.heading}</span>} lead={<span lang="en">{BUILTIN_CONNECT_TEXT.lead}</span>}>
          <BuiltinConnect cfg={builtin} os={os} />
        </Step>
        <Step n={3} id="step-rules" title={M.teachYourAgentTheMemoryRules} lead={M.theRulesTellYourAgentWhere} aside={chat}>
          {rules}
        </Step>
      </div>
      <Agents oauth={null} keys={keys} agentKeys={agentKeys} conns={conns} next={connections.ok ? connections.data.next_cursor : null} cursor={cursor} here={here} retry={!unknown} />
      <details className="faq-lite">
        <summary>{rich(M.somethingWentWrong, null)}</summary>
        <ul className="cn-faq">
          <FaqCard icon="plug" q={M.theAgentCannotSeeMemory}>{rich(M.restartTheProgramAfterSetupThe, { tag0: (children) => <code className="code">{children}</code> }, { value0: builtin.mcp_url })}</FaqCard>
          <SkillFaq agent={agent} os={os} archiveUrl={archiveOk ? archiveUrl : null} skillName={skillName} />
          <FaqCard icon="file" q={M.theAgentCannotFindADocument}>{rich(M.agentsCanOnlySeeOpenRecords, null)}</FaqCard>
        </ul>
      </details>
      <div className="cn-more">
        <Link href={keyHref} prefetch={false} className="cn-more-link"><Icon name="key" />{CONNECT_PLAIN.toKeyLink}</Link>
        <ItParams oauth={null} builtin={builtin} mcpUrl={builtin.mcp_url} skill={<ItSkill archiveUrl={archiveOk ? archiveUrl : null} skillName={skillName} skill={skill} program={program} os={os} />} />
      </div>
    </>;
  }

  const cfg = oauth!;
  const clientId = agent === "other" ? null : clientIdFor(cfg, info.kind);
  const oauthAt = latest(conns.filter((c) => c.status === "active" && c.client_kind === info.kind).map((c) => c.last_used_at ?? c.created_at));
  const g = OS_GUIDE[os];
  const host = issuerHost(cfg.issuer) ?? M.companySignIn;
  const winName = os === "windows" ? "PowerShell" : M.terminal;
  const signIn = (n: number, lead: ReactNode, successHost: string) => (
    <Step n={n} id="step-signin" title={M.signInInYourBrowser} lead={lead}
      aside={<BrowserMock os={os} host={host} tab={M.signInToExampleCorp} caption={<>{rich(M.companySignInPageCheckThe, { tag0: (children) => <b>{children}</b> }, { value0: host })}</>}><SignInPage callouts /></BrowserMock>}
      extra={<SuccessTab os={os} host={successHost} caption={M.whenYouSeeThisYouCan(agent === "cursor" ? M.andReturnToCursor : M.thenReturnTo(winName))} />}>
      <ol className="cn-legend">
        <li><Callout n={1} /><span>{rich(M.useTheSameLoginAndPassword, null)}</span></li>
        <li><Callout n={2} /><span>{rich(M.clickSignIn, { tag0: (children) => <b lang="en">{children}</b> })}</span></li>
      </ol>
      <p className="cn-note">{rich(M.theSignInPageIsIn, null)}</p>
      {agent === "codex" ? <p className="cn-note">{rich(M.inTheChatgptOrCodexApp, null, SERVER_PARAM)}</p> : null}
    </Step>
  );
  const checkUnknown = unknown || !connections.ok;
  const check = (n: number, lead: ReactNode) => (
    <Step n={n} id="step-rules" title={M.checkTheConnectionAndTeachYour} lead={lead} aside={chat}>
      {checkUnknown
        ? <UnknownLine failure={status.failure ?? failureOf(connections)} id="check" />
        : <LiveLine title={info.title} at={oauthAt} checkHref={connectHref(here, "#check")} />}
      <ConnectWatch key={agent} waiting={!oauthAt && keys.ok && connections.ok} />
      {rules}
    </Step>
  );

  let middle: ReactNode = null, last: ReactNode = null;
  if (agent === "other") {
    const otherId = clientIdFor(cfg, "cloud_other");
    middle = (
      <Step n={2} id="step-other" title={M.followYourProgramSConnectionInstructions}
        lead={rich(M.inMcpSettingsAddAMemory, null, SERVER_PARAM)}>
        <dl className="oauth-parameters cn-params">
          <dt>{rich(M.serverAddress, null)}</dt><dd><code>{cfg.resource_url}</code></dd>
          <dt>{rich(M.signInServer, null)}</dt><dd><code>{cfg.issuer}</code></dd>
          {otherId ? <><dt>{M.clientId}</dt><dd><code>{otherId}</code></dd></> : null}
          <dt>{M.scope}</dt><dd><code>{cfg.scope}</code></dd>
        </dl>
        <p className="cn-note">{rich(M.yourProgramCannotSignInThrough, { tag0: (children) => <Link href={keyHref} prefetch={false}>{children}</Link> }, { value0: CONNECT_PLAIN.toKeyLink })}</p>
        {phrase ? <><p className="cn-sub">{rich(M.ifYourProgramSupportsSkillsTeach, null)}</p><CopyButton text={phrase} label={M.phraseForTheAgent} quiet>{rich(M.copyPhraseForTheAgent, null)}</CopyButton></> : null}
      </Step>
    );
  } else if (!clientId) {
    middle = (
      <Step n={2} id="step-key-only" title={M.connectWithAPersonalKey}
        lead={M.companyAccountSignInIsNot(info.title)}>
        <Link href={keyHref} prefetch={false} className="btn primary cn-big"><Icon name="key" />{CONNECT_PLAIN.toKeyLink}</Link>
      </Step>
    );
  } else if (agent === "cursor") {
    middle = <>
      <Step n={2} id="step-add" title={M.addMemoryToCursor} lead={M.clickTheButtonToOpenCursor}
        aside={<CursorInstallMock os={os} host={issuerHost(cfg.resource_url) ?? cfg.resource_url} caption={rich(M.cursorWillAskWhetherToAdd, null, SERVER_PARAM)} />}>
        <a href={cursorDeeplink(cfg, clientId)!} className="btn primary cn-big">{rich(M.addToCursor, { tag0: () => <Icon name="plus" /> })}</a>
        <details className="cn-install">
          <summary>{rich(M.didNotOpenAddItManually, null)}</summary>
          <p className="cn-sub">{rich(M.inCursorSettingsMcpAddNew, { tag0: (children) => <b lang="en">{children}</b> })}</p>
          <CopyBlock text={cursorMcpJson(cfg, clientId)} label={M.cursorSettings} />
        </details>
      </Step>
      {signIn(3, <>{rich(M.inCursorSettingsMcpClickThe, { tag0: (children) => <b lang="en">{children}</b> }, SERVER_PARAM)}</>, "localhost:8787")}
    </>;
    last = check(4, <>{rich(M.openTheAgentChatInCursor, { tag0: (children) => <b>{children}</b> })}</>);
  } else {
    const cmds = oauthCommands(cfg, clientId, osShell(os))!;
    const oldKey = agentKeys.some((k) => k.client_kind === info.kind) ? removeCommand(info.kind) : null;
    middle = <>
      <Step n={2} id="step-open" title={g.openTitle} lead={M.pasteTheCommandInThisWindow(info.title)}
        aside={os === "linux"
          ? <TerminalMock os={os} user={user} caption={M.aWindowLikeThisWillOpen} />
          : <LauncherMock os={os} app={g.app} caption={os === "mac" ? M.spotlightSearchTypeTerminalAndPress : M.startMenuSearchTypePowershellAnd} />}>
        <KeyCaps steps={g.open} className="big" />
      </Step>
      <Step n={3} id="step-paste" title={M.pasteTheCommandAndPressEnter} lead={M.theCommandAddsMemoryToAnd(info.title)}
        aside={<TerminalMock os={os} lines={cmds.split("\n")} user={user} caption={M.thisIsHowTheCommandLooks(os === "windows" ? "PowerShell" : M.terminal)} />}>
        {oldKey ? <div className="cn-warn"><Icon name="alert" /><div><p>{rich(M.youPreviouslyConnectedWithAKey, null, { value0: info.title })}</p><CopyBlock text={oldKey} label={M.commandToRemoveThePreviousConnection} /></div></div> : null}
        <CopyButton text={cmds} label={M.commandFor(info.title)}>{rich(M.copyCommand, null)}</CopyButton>
        <p className="cn-sub">{rich(M.pasteIntoTheWindowAndRun, null)}</p>
        <KeyCaps steps={g.paste} />
        {g.pasteNote ? <p className="cn-note">{g.pasteNote}</p> : null}
      </Step>
      {signIn(4, M.yourBrowserOpensAutomaticallySignIn, agent === "codex" ? "127.0.0.1" : "localhost:8766")}
    </>;
    last = check(5, <>{rich(M.startTheAgentTypeAndPress, { tag0: (children) => <code className="code">{children}</code>, tag1: (children) => <b>{children}</b> }, { value0: info.run, value1: offers ? M.willOffer : M.mayOffer })}</>);
  }

  return <>
    <PageHead title={CONNECT_PLAIN.title} lead={CONNECT_PLAIN.lead} />
    {top(checkUnknown && last !== null)}
    <div className="cn-steps">
      {step1}
      {oauthAt && last ? <details className="cn-again"><summary>{rich(M.showTheStepsAgain, null)}</summary>{middle}</details> : middle}
      {last}
    </div>
    <Agents oauth={cfg} keys={keys} agentKeys={agentKeys} conns={conns} next={connections.ok ? connections.data.next_cursor : null} cursor={cursor} here={here} retry={!unknown && !(checkUnknown && last !== null)} />
    <details className="faq-lite">
      <summary>{rich(M.somethingWentWrong, null)}</summary>
      <ul className="cn-faq">
        <FaqCard icon="globe" q={M.theBrowserDidNotOpenOr}>{rich(M.ifThatDoesNotHelpConnect, { tag0: (children) => <Link href={keyHref} prefetch={false}>{children}</Link> }, { value0: agent === "claude_code" ? <>{rich(M.runTheSecondCommandAgainClaude, { tag0: (children) => <code className="code">{children}</code>, tag1: (children) => <code className="code">{children}</code> }, SERVER_PARAM)}</>
            : agent === "codex" ? <>{rich(M.runTheSecondCommandAgainTo, null, SERVER_PARAM)}</>
            : agent === "cursor" ? <>{rich(M.inCursorSettingsMcpClickThe2, null, SERVER_PARAM)}</> : null })}</FaqCard>
        <FaqCard icon="lock" q={M.theAgentSaysItHasNo}>{rich(M.theConnectionWasDisconnectedOrExpired, null, { value0: ssoOn ? ` ${CONNECT_PLAIN.ssoOnce}` : null })}</FaqCard>
        <FaqCard icon="key" q={M.theAgentKeepsUsingAKey}>
          {agent === "codex" ? <>{rich(M.theMemoryServerInYourCodex, null, SERVER_PARAM)}</>
            : agent === "claude_code" ? <>{rich(M.theMemoryServerStillHasThe, { tag0: (children) => <code className="code">{children}</code> }, SERVER_PARAM)}</>
            : <>{rich(M.theMemoryServerInYourProgram, null, SERVER_PARAM)}</>}
        </FaqCard>
        <FaqCard icon="plug" q={M.theAgentCannotSeeMemory}>{rich(M.restartTheProgramAfterSetupMake, { tag0: (children) => <code className="code">{children}</code> }, { value0: cfg.resource_url })}</FaqCard>
        <SkillFaq agent={agent} os={os} archiveUrl={archiveOk ? archiveUrl : null} skillName={skillName} />
        <FaqCard icon="file" q={M.theAgentCannotFindADocument}>{rich(M.agentsCanOnlySeeOpenRecords, null)}</FaqCard>
      </ul>
    </details>
    <div className="cn-more">
      <Link href={keyHref} prefetch={false} className="cn-more-link"><Icon name="key" />{CONNECT_PLAIN.toKeyLink}</Link>
      <ItParams oauth={cfg} mcpUrl={mcpUrl} skill={<ItSkill archiveUrl={archiveOk ? archiveUrl : null} skillName={skillName} skill={skill} program={program} os={os} />} />
    </div>
  </>;
}

function Agents({ oauth, keys, agentKeys, conns, next, cursor, here, retry }: {
  oauth: OAuthConnectConfig | null; keys: MeResult<MyKeysPage>; agentKeys: MyKeysPage["items"]; conns: OAuthConnectionsPage["items"];
  next: string | null; cursor: string; here: { agent: ConnectAgent; os: ConnectOs; via: "key" | null }; retry: boolean;
}) {
  return (
    <section className="home-sec cn-agents" id="agents" aria-labelledby="agents-title">
      <div className="home-sec-head row"><h2 id="agents-title">{rich(M.yourAgents, null)}</h2><Link href="/keys" className="quiet" prefetch={false}>{rich(M.allKeysAndSignIns, null)}</Link></div>
      {oauth ? <p className="cn-note">{rich(M.companyAccountConnectionsLastUpTo, null, { value0: oauth.connection_days })}</p> : null}
      {!keys.ok ? <LoadError result={keys} what={M.keys} retry={retry} /> : !agentKeys.length && !conns.length ? (
        <Empty icon="bot">{rich(M.noAgentsConnectedYetYourAgent, null)}</Empty>
      ) : <AgentsList keys={agentKeys} conns={conns} />}
      {next ? <div data-dirty-owner="pager"><CursorPager path="/connect" params={{ agent: here.agent, os: here.os, ...(here.via ? { via: here.via } : {}) }} cursorName="cursor" cursor={cursor} nextCursor={next} shown={conns.length} /></div> : null}
    </section>
  );
}

function SkillFaq({ agent, os, archiveUrl, skillName }: { agent: ConnectAgent; os: ConnectOs; archiveUrl: string | null; skillName: string }) {
  const p = skillProgram(agent);
  const folder = p ? SKILL_FOLDERS[p][osShell(os)] : null;
  return (
    <FaqCard icon="book-open" q={M.theAgentDoesNotKnowThe}>{rich(M.sendItThePhraseFromThe, null, { value0: agent === "claude_code" ? <>{rich(M.orTypeIfThatFails, { tag0: (children) => <code className="code">{children}</code>, tag1: (children) => <code className="code">{children}</code> }, { value0: INSTALL_SKILL_COMMAND, value1: INSTALL_SKILL_COMMAND_FULL })}</> : null, value1: archiveUrl ? <>{rich(M.manuallyDownloadTheArchiveExtractIt, { tag0: (children) => <a href={archiveUrl} download={`${skillName}.zip`}>{children}</a> }, { value0: skillName, value1: folder ? <>{rich(M.to, { tag0: (children) => <code className="code">{children}</code> }, { value0: folder })}</> : M.toYourProgramSSkillsFolder })}</> : null })}</FaqCard>
  );
}

function ItSkill({ archiveUrl, skillName, skill, program, os }: { archiveUrl: string | null; skillName: string; skill: { version: string; sha: string } | null; program: SkillProgram | null; os: ConnectOs }) {
  if (!archiveUrl) return null;
  return <>
    <dt>{rich(M.memorySkill, null)}</dt>
    {/* i18n-ignore: literal archive filename */}
    <dd><a href={archiveUrl} download={`${skillName}.zip`}>{`${skillName}.zip`}</a>{skill ? <>{rich(M.currentVersionSha256, { tag0: (children) => <code>{children}</code> }, { value0: skill.version, value1: skill.sha })}</> : <>{rich(M.theVersionAndChecksumCouldNot, null)}</>}</dd>
    {program ? <><dt>{rich(M.installTheSkillWithACommand, null)}</dt><dd><CopyBlock text={skillCommand(program, osShell(os), archiveUrl, skill?.sha, skillName)} label={M.skillInstallationCommandFor(SKILL_FOLDERS[program].title)} /></dd></> : null}
  </>;
}
