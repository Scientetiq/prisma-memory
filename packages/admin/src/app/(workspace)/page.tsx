import { pageText as M } from "@/messages/ws-page";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { FindField } from "@/components/find-field";
import { Icon, type IconName } from "@/components/icons";
import { ListHead } from "@/components/list-head";
import { MeetingRow } from "@/components/meeting-row";
import { MorningNoteCard } from "@/components/morning-note-card";
import { RecordRow } from "@/components/record-row";
import { RetryLater } from "@/components/retry-later";
import { SpaceCard } from "@/components/space-card";
import { Notice } from "@/components/ui";
import { AGENT_UNKNOWN, agentStatus } from "@/lib/agent-status";
import { AGENT_VIEW_HREF, AGENT_VIEW_PATH, zeroForAgent, type AgentView } from "@/lib/agent-view";
import { avText } from "@/lib/agent-view.messages";
import { CLOSED_EXPLAIN_HREF, readsClosed } from "@/lib/closed-class";
import { isAgentKey } from "@/lib/connect-agents";
import { greetingName } from "@/lib/greeting";
import { ACCESS_PLAIN, connectedAgents, HOME_RECENT_LIMIT, HOME_RECENT_TIMEOUT_MS, HOME_SPACES_LIMIT, HOME_TEXT, recentArgs, recordState } from "@/lib/home";
import { callTool, toolErrorMessage } from "@/lib/mcp";
import { meGw } from "@/lib/me-api";
import { hiddenClosedTotal, oauthAgentConfig, oauthAgentsOn, personalSpace, requireWorkspace } from "@/lib/me";
import { myMeetings } from "@/lib/meetings";
import { MORNING_NOTE_PATH, parseNoteView } from "@/lib/morning-note";
import { navSummary } from "@/lib/nav";
import { NAV_ICONS } from "@/lib/nav-icons";
import { MEETINGS_PLAIN, PROFILE_PLAIN } from "@/lib/plain";
import { focusStaleDay, MY_PROFILE_HREF } from "@/lib/my-profile";
import type { OAuthConnectionsPage } from "@/lib/oauth-connect";
import { param, type SearchParams } from "@/lib/paging";
import { formatCount, OVERVIEW_WHAT, SECTION_TITLES } from "@/lib/plain";
import { bySpaceKindThenName } from "@/lib/spaces";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { MyAuditEvent, MyKeysPage, SearchResult, StatusBatch } from "@/lib/types";
import { setMorningNoteAction } from "./actions";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.overview }; }

const HOME_MEETINGS_LIMIT = 3;
type StepState = "done" | "partial" | "todo";
interface Step { state: StepState; icon: IconName; tone: string; title: string; text: string; href: string | null; action: string; search?: boolean }
interface Tile { href: string; icon: IconName; tone: string; title: string; sub: string; done?: boolean; unknown?: { retryAfter: number | null; limited: boolean } }

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const preview = Boolean(session.preview);
  const personal = personalSpace(me);
  // the morning note card — the person's own numbers, not for a preview; started with the reads below and
  // awaited later; a failure or a slow answer only leaves the card out (and must not become an unhandled rejection)
  const noteReq = preview ? null : meGw<unknown>(session.key, MORNING_NOTE_PATH, { timeoutMs: HOME_RECENT_TIMEOUT_MS });
  noteReq?.catch(() => undefined);
  const [keys, oauth, searches, oauthConfig, recent] = await Promise.all([
    preview ? null : meGw<MyKeysPage>(session.key, "/api/v1/me/keys", { query: { limit: 100 } }),
    preview ? null : meGw<OAuthConnectionsPage>(session.key, "/api/v1/me/connections", { query: { limit: 20 } }),
    preview ? null : meGw<{ items: MyAuditEvent[] }>(session.key, "/api/v1/me/audit", { query: { limit: 1, event_type: "search", exclude_auto: true } }),
    preview ? null : oauthAgentConfig(session.key),
    personal ? callTool<SearchResult>(session.key, "memory_search", recentArgs(personal.slug, HOME_RECENT_LIMIT), HOME_RECENT_TIMEOUT_MS) : null,
  ]);
  const mine = recent?.ok ? recent.data.hits.slice(0, HOME_RECENT_LIMIT) : [];
  const now = Date.now();
  const agent = agentStatus(keys, oauth, now);
  const agentKeys = agent.liveKeys.filter(isAgentKey);
  const agentLabel = connectedAgents(agent.connected);
  const agentUsed = agentLabel !== null;
  // When the agent is connected but finds nothing while the person has hidden records — the agent step leads to
  // "What my agent sees". Asked only once an agent has been used; a failure or a slow answer changes nothing. Started here and
  // awaited below, so it runs together with the later reads of the page instead of after them
  const agentViewReq = !preview && agentUsed ? meGw<AgentView>(session.key, AGENT_VIEW_PATH, { timeoutMs: HOME_RECENT_TIMEOUT_MS }) : null;
  // if an earlier await throws first (a redirect to sign-in), this request must not become an unhandled rejection; awaiting it
  // below still throws what it throws
  agentViewReq?.catch(() => undefined);
  const nav = preview ? null : (await navSummary(session.key)).data;
  const freshMeetings = nav?.meetings.new ?? 0;
  const focusStale = focusStaleDay(nav);
  const newMeetingsRes = freshMeetings > 0 ? await myMeetings(session.key, "", HOME_MEETINGS_LIMIT, { fresh: true }) : null;
  const newMeetings = newMeetingsRes?.ok && !newMeetingsRes.data.new_unavailable ? newMeetingsRes.data.items : [];
  const batch = mine.length ? await meGw<StatusBatch>(session.key, "/api/v1/records/status", { query: { ids: mine.map((h) => h.id).join(","), derived: false }, timeoutMs: 10_000 }) : null;
  const stagesOf = new Map(batch?.ok ? (batch.data.items ?? []).map((it) => [it.id, it.stages ?? []]) : []);

  const oauthOn = oauthAgentsOn(oauthConfig);
  const spaces = [...me.spaces].sort(bySpaceKindThenName);
  const closedVisible = readsClosed(me.key);
  const hidden = hiddenClosedTotal(me);

  const agentView = agentViewReq ? await agentViewReq : null;
  const noteRes = noteReq ? await noteReq : null;
  // a broken body — no card (parseNoteView); all counters zero — only the switch, or nothing (MorningNoteCard)
  const note = noteRes?.ok ? parseNoteView(noteRes.data) : null;
  const agentBlind = Boolean(agentView?.ok && zeroForAgent(agentView.data));
  const hasMaterial = (personal?.counts?.records ?? 0) > 0 || (personal?.hidden_closed ?? 0) > 0;
  const searched = Boolean(searches?.ok && searches.data.items.length) || me.recent_actions.some((a) => a.event_type === "search");
  const steps: Step[] = [
    { state: hasMaterial ? "done" : "todo", icon: "upload", tone: "green", title: M.addYourFirstRecord,
      text: M.aDocumentOrNoteADecision, href: preview ? null : "/materials", action: M.upload },
    { state: agentBlind ? "partial" : agentUsed ? "done" : agentKeys.length ? "partial" : "todo", icon: "bot", tone: "violet", title: M.connectAnAiAgent,
      text: agentBlind ? avText("zero_step_text") : agentUsed ? M.theAgentHasAlreadyUsedMemory
        : agentKeys.length ? M.aKeyHasBeenIssuedBut(oauthOn ? M.orConnectYourAgentWithYour : "")
        : oauthOn ? M.signInToYourAgentWith
        : M.claudeCodeCodexOrCursorWill,
      href: preview ? null : agentBlind ? AGENT_VIEW_HREF : "/connect", action: agentBlind ? avText("zero_step_action") : agentKeys.length && !agentUsed ? M.check : M.connect },
    { state: searched ? "done" : "todo", icon: "search", tone: "blue", title: M.findSomething,
      text: M.aWordOrQuestionSearchWill, href: "/search", action: M.search, search: true },
  ];
  const doneCount = steps.filter((s) => s.state === "done").length;
  const checked = agent.state !== "unknown" && !(searches && !searches.ok);
  const showStart = checked && doneCount < steps.length;
  const name = greetingName(me.person);

  const tiles: Tile[] = preview ? [] : [
    { href: "/materials#upload", icon: "upload", tone: "green", title: M.uploadAFile, sub: M.aDocumentInMemory },
    { href: "/materials#note", icon: "pencil", tone: "blue", title: M.writeANote, sub: M.inYourOwnWords },
    agentLabel
      ? { href: "/connect", icon: "circle-check", tone: "green", title: agentLabel, sub: M.connectAnother, done: true }
      : agent.state === "unknown"
        ? { href: "/connect", icon: "plug", tone: "gray", title: AGENT_UNKNOWN.title, sub: AGENT_UNKNOWN.tile,
            unknown: { retryAfter: agent.failure?.retryAfter ?? null, limited: agent.failure?.code === "rate_limited" } }
        : { href: "/connect", icon: "bot", tone: "brand", title: M.connectAnAgent, sub: oauthOn ? M.withYourCompanyAccountWithoutA : "Claude Code, Codex, Cursor" },
    { href: "/projects/new", icon: "plus", tone: "violet", title: M.newProject, sub: M.sharedTeamMemory },
  ];
  const personalHref = personal ? `/materials?space=${encodeURIComponent(personal.slug)}` : "/materials";

  return (
    <>
      <header className="hello">
        <div className="hello-text">
          <h1>{rich(M.hello, null, { value0: name })}</h1>
          <p className="sub">{[me.person.department, me.person.role].filter(Boolean).join(" · ") || me.person.login}</p>
          <details className="hello-what">
            <summary><Icon name="circle-help" />{OVERVIEW_WHAT.summary}</summary>
            <p>{OVERVIEW_WHAT.text}</p>
          </details>
        </div>
        {showStart ? null : <FindField className="find-hello" action="/search" label={M.searchMemory} placeholder={M.forExampleContractDecision} primary />}
      </header>

      {param(sp, "preview_no_keys") === "1" ? <Notice tone="info"><strong>{rich(M.keysAndAgentsIsUnavailableIn, null)}</strong> {PREVIEW_TEXT.previewDeniedHint}</Notice> : null}

      {focusStale ? (
        <Notice tone="info">
          <span className="readme-nudge">
            <span>{PROFILE_PLAIN.homeStale(focusStale)}</span>
            <Link href={`${MY_PROFILE_HREF}#focus`} prefetch={false} className="btn sm">{PROFILE_PLAIN.homeStaleAction}</Link>
          </span>
        </Notice>
      ) : null}

      {note ? <MorningNoteCard view={note} action={setMorningNoteAction} /> : null}

      {showStart ? (
        <section className="start" aria-labelledby="start-title">
          <div className="start-head">
            <div>
              <h2 id="start-title">{rich(M.getStarted, null)}</h2>
              <p>{rich(M.threeStepsToHelpMemoryAnswer, null)}</p>
            </div>
            <div className="start-progress" aria-label={M.ofDone(doneCount, steps.length)}>
              <span>{rich(M.of, null, { value0: doneCount, value1: steps.length })}</span>
              <span className="bar"><i style={{ width: `${Math.round((doneCount / steps.length) * 100)}%` }} /></span>
            </div>
          </div>
          <ol className="start-steps">
            {steps.map((st, i) => {
              const primary = i === steps.findIndex((x) => x.state !== "done");
              return (
                <li key={st.title} className={`step-${st.state}`}>
                  <span className="step-mark" aria-label={st.state === "done" ? M.done : st.state === "partial" ? M.started : M.notDone}>{st.state === "done" ? <Icon name="check" /> : i + 1}</span>
                  <span className={`ichip tone-${st.tone}`}><Icon name={st.icon} /></span>
                  <div className="step-text"><b>{st.title}</b><span>{st.text}</span></div>
                  {st.search && st.href ? (
                    <FindField className="find-step" action={st.href} label={M.whatToFindInMemory} placeholder={M.forExampleContract} primary={primary} submit={st.action} />
                  ) : st.state !== "done" && st.href ? <Link href={st.href} className={`btn sm${primary ? " primary" : ""}`}>{st.action}</Link> : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {tiles.length ? (
        <nav className="hm-actions" aria-label={M.quickActions}>
          {tiles.map((t) => t.unknown ? (
            <div key={t.href + t.title} className="hm-tile is-unknown" role="status">
              <span className={`ichip tone-${t.tone}`}><Icon name={t.icon} /></span>
              <span className="hm-tile-text"><b>{t.title}</b><small>{t.sub}</small><small><RetryLater seconds={t.unknown.retryAfter} limited={t.unknown.limited} /></small></span>
            </div>
          ) : (
            <Link key={t.href + t.title} href={t.href} prefetch={false} className={t.done ? "hm-tile is-done" : "hm-tile"}>
              <span className={`ichip tone-${t.tone}`}><Icon name={t.icon} /></span>
              <span className="hm-tile-text"><b>{t.title}</b><small>{t.sub}</small></span>
            </Link>
          ))}
        </nav>
      ) : null}

      {newMeetings.length ? (
        <section className="home-sec" aria-labelledby="meetings-new-title">
          <ListHead id="meetings-new-title" icon={NAV_ICONS.meetings} title={MEETINGS_PLAIN.overviewTitle}
            aside={freshMeetings > newMeetings.length
              ? <Link href="/meetings?show=new#meetings" prefetch={false} className="hm-more">{MEETINGS_PLAIN.overviewAllNew(freshMeetings)}<Icon name="chevron" /></Link>
              : <Link href="/meetings" prefetch={false} className="hm-more">{MEETINGS_PLAIN.overviewAll}<Icon name="chevron" /></Link>} />
          <ul className="mt-list">{newMeetings.map((m) => <MeetingRow key={m.id} m={m} />)}</ul>
        </section>
      ) : null}

      {personal ? (
        <section className="home-sec" aria-labelledby="mine-title">
          <ListHead id="mine-title" icon={NAV_ICONS.materials} title={HOME_TEXT.materialsTitle}
            aside={<Link href="/materials" prefetch={false} className="hm-more">{HOME_TEXT.allMaterials}<Icon name="chevron" /></Link>} />
          {recent && !recent.ok ? (
            <Notice tone="warn"><strong>{rich(M.theListCouldNotBeLoaded, null)}</strong> {toolErrorMessage(recent)}</Notice>
          ) : !mine.length ? (
            <div className="hm-empty">
              <span className="ichip tone-gray"><Icon name="folder-open" /></span>
              <p><b>{HOME_TEXT.emptyMine}</b>{preview ? null : <span>{HOME_TEXT.emptyMineSub}</span>}</p>
              {preview ? null : (
                <div className="hm-empty-acts">
                  <Link href={`${personalHref}#upload`} prefetch={false} className="btn">{rich(M.uploadAFile2, { tag0: () => <Icon name="upload" /> })}</Link>
                  <Link href={`${personalHref}#note`} prefetch={false} className="btn">{rich(M.writeANote2, { tag0: () => <Icon name="pencil" /> })}</Link>
                </div>
              )}
            </div>
          ) : (
            <ul className="mt-list hm-rows">
              {mine.map((h) => (
                <RecordRow key={h.id} recordId={h.id} href={`/records/${h.id}`} type={h.type} eventKind={h.event_kind} title={h.title} date={h.occurred_at}
                  cls={h.class} state={recordState(stagesOf.get(h.id))} showDone />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="home-sec" aria-labelledby="spaces-title">
        <ListHead id="spaces-title" icon={NAV_ICONS.spaces} title={HOME_TEXT.spacesTitle}
          aside={spaces.length > HOME_SPACES_LIMIT ? <Link href="/browse" prefetch={false} className="hm-more">{HOME_TEXT.allSpaces}<Icon name="chevron" /></Link> : null} />
        <div className="sc-grid">
          {spaces.slice(0, HOME_SPACES_LIMIT).map((s) => <SpaceCard key={s.slug} s={s} preview={preview} />)}
        </div>
      </section>

      <p className="hm-legend">
        <span><Icon name="unlock" />{ACCESS_PLAIN.open}</span>
        <span><Icon name="lock" />{ACCESS_PLAIN.closed}</span>
        {hidden && !closedVisible ? <span>{rich(M.closedRecordsAreHiddenInPreview, { tag0: () => <Icon name="eye" />, tag1: (children) => <Link href={CLOSED_EXPLAIN_HREF} prefetch={false}>{children}</Link> }, { value0: formatCount(hidden) })}</span> : null}
      </p>
    </>
  );
}
