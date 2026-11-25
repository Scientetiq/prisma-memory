import { rich } from "@/i18n/rich";
import { EXAMPLES } from "@/messages/ws-search";
import { texts as M } from "@/messages/ws-search";
import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { FindRow } from "@/components/find-field";
import { Icon, recordIcon } from "@/components/icons";
import { RecordMeta } from "@/components/record-meta";
import { SearchModeSwitch } from "@/components/search-mode-switch";
import { Badge, Empty, Notice, PageHead, Section } from "@/components/ui";
import { EVENT_KIND_TITLES, EVENT_KINDS, RECORD_TYPE_TITLES, RECORD_TYPES, SEARCH_MODE_HINTS, SEARCH_MODE_TITLES } from "@/lib/labels";
import { recordKind } from "@/lib/home";
import { anchorOf } from "@/lib/markdown";
import { callTool, toolErrorMessage, type McpResult } from "@/lib/mcp";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { ARCHIVE_MESSAGES } from "@/lib/archive";
import { isSlug } from "@/lib/form";
import { multiParam, param, type SearchParams } from "@/lib/paging";
import { EXTENDED_OPEN_PLAIN, OVERVIEW_PLAIN } from "@/lib/plain";
import { VIEW_BADGE } from "@/lib/org-review";
import { searchBackParam } from "@/lib/record-nav";
import { entityKindOf, SEARCH_LABEL_PARAM, searchPick } from "@/lib/space-overview";
import { highlight, hitSnippet, queryTerms, scoreHint, SNIPPET_TOKENS, sourceText, splitHits, topScore, type QueryTerm, type Segment } from "@/lib/search-snippet";
import type { Hit, MySpacesPage, SearchResult } from "@/lib/types";

export function generateMetadata(): Metadata { return { title: M.metadataTitle }; }
const MODES = ["hybrid", "keyword", "semantic", "recent"] as const;
const SWITCH_MODES = ["hybrid", "keyword", "semantic"] as const;


const LIMIT = 50;
const MAX_PAGES = 5;

function hitHref(h: Pick<Hit, "id" | "locator" | "type">, sid?: string | null, back?: string | null): string {
  const l = h.locator;
  let hash = "";
  let t: number | null = null;
  if (l?.anchor) hash = `#${l.anchor}`;
  else if (l?.section) hash = `#${anchorOf(l.section.split(" > ").pop() ?? l.section)}`;
  else if (l?.page) hash = `#page-${l.page}`;
  else if (h.type === "transcript" && typeof l?.time_from === "number" && l.time_from >= 0) { t = Math.floor(l.time_from); hash = `#t-${t}`; }
  const u = new URLSearchParams();
  if (t !== null) u.set("t", String(t));
  if (sid && UUID.test(sid)) u.set("sid", sid);
  if (back) u.set("back", back);
  const s = u.toString();
  return `/records/${h.id}${s ? `?${s}` : ""}${hash}`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Marked({ segs }: { segs: Segment[] }) {
  return <>{segs.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>))}</>;
}

function HitRow({ h, href, terms, top, space }: { h: Hit; href: string; terms: QueryTerm[]; top: number; space: string }) {
  const src = sourceText(h);
  const snip = hitSnippet(h, terms);
  return (
    <li className="hit">
      <span className="ichip sm tone-gray hit-ic"><Icon name={recordIcon(h.type, h.event_kind)} /></span>
      <h3><Link href={href} prefetch={false} className="hit-link" title={scoreHint(h.score, top)}><Marked segs={highlight(h.title || M.untitled, terms)} /></Link></h3>
      <div className="meta">
        <span className="hit-kind">{recordKind(h.type, h.event_kind)}</span>
        <span className="dot" aria-hidden="true">·</span>
        <span>{space}</span>
        <span className="dot" aria-hidden="true">·</span>
        <RecordMeta iso={h.occurred_at} cls={h.class} />
        {src ? <><span className="dot" aria-hidden="true">·</span><span>{src}</span></> : null}
        {h.space_archived ? <Badge tone="muted" title={M.spaceArchivedReadOnly}>{M.archived}</Badge> : null}
        {h.extended_write ? <Badge tone="warn" title={EXTENDED_OPEN_PLAIN.badgeHint}>{EXTENDED_OPEN_PLAIN.badge}</Badge> : null}
        {h.org_review ? <Badge tone={VIEW_BADGE[h.org_review].tone} title={M.companyKnowledgeCuratorReview}>{VIEW_BADGE[h.org_review].text}</Badge> : null}
      </div>
      {snip ? <p className="snip"><Marked segs={highlight(snip, terms)} /></p> : null}
    </li>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const q = param(sp, "q");
  const modeAsked = param(sp, "mode");
  const mode = (MODES as readonly string[]).includes(modeAsked) && !(modeAsked === "recent" && q) ? modeAsked : "hybrid";
  const hasArchive = (me.archived_spaces ?? 0) > 0;
  const archivedAsked = hasArchive && param(sp, "archived") === "1";
  const spaceAsked = param(sp, "space");
  const inMe = me.spaces.some((s) => s.slug === spaceAsked);
  const archList = hasArchive && (archivedAsked || (spaceAsked && !inMe && isSlug(spaceAsked)))
    ? await meGw<MySpacesPage>(session.key, "/api/v1/me/spaces", { query: { archived: "true", limit: 100 } }) : null;
  const archSpaces = archList?.ok ? archList.data.items : [];
  const space = inMe || archSpaces.some((s) => s.slug === spaceAsked) ? spaceAsked : "";
  const spaceArchived = Boolean(space) && !inMe;
  const types = multiParam(sp, "type", RECORD_TYPES);
  const kinds = multiParam(sp, "kind", EVENT_KINDS);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(param(sp, "from")) ? param(sp, "from") : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(param(sp, "to")) ? param(sp, "to") : "";
  const pick = searchPick((n) => param(sp, n));
  const asked = q.length > 0 || mode === "recent";
  const askedPage = Math.min(MAX_PAGES, Math.max(1, Number.parseInt(param(sp, "page"), 10) || 1));

  const filters: Record<string, unknown> = {};
  if (space) filters.space = space;
  if (archivedAsked) filters.archived = true;
  if (types.length) filters.types = types;
  if (kinds.length) filters.event_kinds = kinds;
  // the day as typed: the gateway counts days in the zone of the installation, in one place, not by UTC here
  if (from) filters.from = from;
  if (to) filters.to = to;
  if (pick.domain) filters.domains = [pick.domain];
  if (pick.entity) filters.entity = pick.entity;
  if (mode === "recent" && space && Object.keys(filters).every((k) => k === "space" || k === "types")) filters.archived = false;

  let res: McpResult<SearchResult> | null = null;
  let page = 1;
  let firstTop = 0;
  const exclude: string[] = [];
  if (asked) {
    for (page = 1; page <= askedPage; page++) {
      res = await callTool<SearchResult>(session.key, "memory_search", {
        ...(q ? { query: q } : {}), mode, filters, limit: LIMIT, ...(exclude.length ? { exclude_ids: exclude } : {}), ...(q ? { snippet_tokens: SNIPPET_TOKENS } : {}),
      });
      if (res.ok && page === 1) firstTop = topScore(res.data.hits);
      if (!res.ok || page === askedPage) break;
      if (res.data.hits.length < LIMIT) break;
      exclude.push(...res.data.hits.map((h) => h.id));
    }
  }
  const hits = res?.ok ? res.data.hits : [];
  const { strong, weak, top } = splitHits(hits, mode, page > 1 ? { top: firstTop, minShown: 0 } : {});
  const allWeak = !strong.length && weak.length > 0;
  const terms = q ? queryTerms(q) : [];
  const hasNext = Boolean(res?.ok && hits.length === LIMIT && page < MAX_PAGES);
  const atLimit = Boolean(res?.ok && hits.length === LIMIT && page === MAX_PAGES);
  const shownBefore = (page - 1) * LIMIT;
  const ADVICE: Record<string, string> = {
    keyword: M.exactWordsForCodesAbbreviationsAndExact,
    semantic: M.byMeaningForARephrasedQuestion,
    hybrid: M.defaultToAskInYourOwnWords,
  };
  const spaceOfPath = (path: string): string => {
    const personal = me.spaces.find((x) => x.kind === "personal");
    if (path.startsWith("/me/") && personal) return personal.name;
    const slug = /^\/spaces\/([^/]+)/.exec(path)?.[1] ?? (path.startsWith("/org/") ? "org" : "");
    return me.spaces.find((x) => x.slug === slug || (slug === "org" && x.kind === "org"))?.name
      ?? archSpaces.find((x) => x.slug === slug)?.name ?? M.anotherSpace;
  };
  const advice = (() => {
    const rest = SWITCH_MODES.filter((m) => m !== mode).map((m) => ADVICE[m]!).filter(Boolean);
    return rest.length ? M.tryAnotherModeInFilters(rest.slice(0, 2).join(", ")) : "";
  })();

  const pageHref = (n: number): string => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (mode !== "hybrid") u.set("mode", mode);
    if (space) u.set("space", space);
    if (archivedAsked) u.set("archived", "1");
    if (from) u.set("from", from);
    if (to) u.set("to", to);
    for (const t of types) u.append("type", t);
    for (const k of kinds) u.append("kind", k);
    if (pick.domain) u.set("domain", pick.domain);
    if (pick.entity) u.set("entity", pick.entity);
    if (pick.what) u.set(SEARCH_LABEL_PARAM, pick.what);
    if (n > 1) u.set("page", String(n));
    const s = u.toString();
    return s ? `/search?${s}` : "/search";
  };
  const back = asked ? searchBackParam(q, pageHref(page).replace(/^\/search\??/, "")) : null;
  const sid = res?.ok ? res.data.search_id : null;
  const recentHref = (() => {
    const u = new URLSearchParams({ mode: "recent" });
    if (space) u.set("space", space);
    if (archivedAsked) u.set("archived", "1");
    return `/search?${u.toString()}`;
  })();
  const picked = Boolean(pick.domain || pick.entity);
  const filtersSet = Boolean(space || types.length || kinds.length || from || to || archivedAsked || picked);
  const unpickHref = (() => {
    const u = new URLSearchParams(pageHref(1).replace(/^\/search\??/, ""));
    for (const k of ["domain", "entity", SEARCH_LABEL_PARAM]) u.delete(k);
    const s = u.toString();
    return s ? `/search?${s}` : "/search";
  })();
  const modeSet = mode === "keyword" || mode === "semantic";
  const resetHref = q ? `/search?${new URLSearchParams({ q }).toString()}` : mode === "recent" ? "/search?mode=recent" : "/search";
  const title = !res?.ok ? M.results : M.resultTitle(mode, hits.length, strong.length, weak.length, allWeak, top, page);
  const row = (h: Hit) => <HitRow key={h.id + (h.locator?.anchor ?? "")} h={h} href={hitHref(h, sid, back)} terms={terms} top={top} space={spaceOfPath(h.path)} />;

  return (
    <>
      <PageHead title={M.search2} lead={M.searchesAllRecordsAvailableToYouSelect}
        actions={mode === "recent" ? null : <Link href={recentHref} prefetch={false} className="btn sm">{rich(M.whatSNewLine, { tag1: () => <Icon name="clock" /> })}</Link>} />
      <form method="get" action="/search" className="search-form" role="search">
        <FindRow className="find-page" label={M.whatToSearchFor} placeholder={M.forExampleDeliveryDeadline} defaultValue={q} autoFocus={!q} primary />
        <details className="opts" open={filtersSet || modeSet}>
          <summary>{rich(M.filtersLine, null, { value1: modeSet ? ` · ${SEARCH_MODE_TITLES[mode]}` : "", value2: filtersSet ? M.active : "" })}</summary>
          <div className="opts-body">
            <div className="opts-mode">
              <span className="field-label" id="search-mode-label">{M.searchMode}</span>
              <SearchModeSwitch current={mode} labelledBy="search-mode-label"
                modes={SWITCH_MODES.map((m) => ({ value: m, title: SEARCH_MODE_TITLES[m] ?? m, hint: SEARCH_MODE_HINTS[m] }))} />
              <p className="hint">{M.defaultAskInYourOwnWordsExact}</p>
            </div>
            <div className="form-grid">
              <label className="field"><span className="field-label">{M.space}</span>
                <select name="space" defaultValue={space}>
                  <option value="">{M.allMySpaces}</option>
                  {me.spaces.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
                  {archivedAsked || spaceArchived ? archSpaces.map((s) => <option key={s.slug} value={s.slug}>{rich(M.archivedLine, null, { value1: s.name })}</option>) : null}
                </select>
              </label>
              <label className="field"><span className="field-label">{M.fromDate}</span><input type="date" name="from" defaultValue={from} /></label>
              <label className="field"><span className="field-label">{M.toDate}</span><input type="date" name="to" defaultValue={to} /></label>
            </div>
            {hasArchive ? (
              <label className="check"><input type="checkbox" name="archived" value="1" defaultChecked={archivedAsked} /> {ARCHIVE_MESSAGES.includeArchivedRecords} <span className="muted small">— {ARCHIVE_MESSAGES.recordsFromCompletedProjects}</span></label>
            ) : null}
            <div className="checks">{rich(M.whatToSearchForLine, { tag1: (children) => <span className="field-label">{children}</span> }, { value1: RECORD_TYPES.map((t) => <label key={t} className="check"><input type="checkbox" name="type" value={t} defaultChecked={types.includes(t)} />{RECORD_TYPE_TITLES[t]}</label>) })}</div>
            <div className="checks">{rich(M.whichDecisionsAndTasksLine, { tag1: (children) => <span className="field-label">{children}</span> }, { value1: EVENT_KINDS.map((k) => <label key={k} className="check"><input type="checkbox" name="kind" value={k} defaultChecked={kinds.includes(k)} />{EVENT_KIND_TITLES[k]}</label>) })}</div>
            {filtersSet || modeSet ? <p className="opts-reset"><Link href={resetHref} prefetch={false}>{M.clearFilters}</Link></p> : null}
          </div>
        </details>
        {mode === "recent" ? <input type="hidden" name="mode" value="recent" /> : null}
        {pick.domain ? <input type="hidden" name="domain" value={pick.domain} /> : null}
        {pick.entity ? <input type="hidden" name="entity" value={pick.entity} /> : null}
        {pick.what ? <input type="hidden" name={SEARCH_LABEL_PARAM} value={pick.what} /> : null}
      </form>
      {picked ? (
        <p className="hint search-pick">{OVERVIEW_PLAIN.pickLead} {OVERVIEW_PLAIN.pick(pick, pick.entity ? entityKindOf(pick.entity) : null)}.{" "}
          <Link href={unpickHref} prefetch={false}>{OVERVIEW_PLAIN.pickDrop}</Link></p>
      ) : null}

      {!asked ? (
        <div className="search-start">
          <p className="hint">{M.askInYourOwnWordsAsYou}</p>
          <ul className="search-examples">
            {EXAMPLES.map((e) => <li key={e}><Link href={`/search?${new URLSearchParams({ q: e }).toString()}`} prefetch={false} className="chip">{e}</Link></li>)}
          </ul>
        </div>
      ) : (
        <Section id="hits" title={title} icon="search">
          {!res!.ok ? (
            <Notice tone={res!.code === "rate_limited" ? "warn" : "danger"}>
              <strong>{res!.code === "rate_limited" ? M.tooManyRequests : M.searchNotCompleted}</strong> {toolErrorMessage(res!)}
              {res!.code === "class_denied" ? <div className="hint">{M.thisSearchIncludesClosedRecordsButOnly}</div> : null}
            </Notice>
          ) : !hits.length ? (
            page > 1 ? <Empty>{rich(M.nothingOnThisPageBackToLine, { tag1: (children) => <Link href={pageHref(1)} prefetch={false}>{children}</Link> })}</Empty>
              : <Empty icon="search">{rich(M.nothingFoundLine, null, { value1: advice && mode !== "recent" ? <> {advice}</> : null, value2: hasArchive && !archivedAsked && !spaceArchived ? <> {M.archivedProjectsWereNotSearchedSelect}{ARCHIVE_MESSAGES.includeArchivedRecords}{M.inFilters}</> : null })}</Empty>
          ) : (
            <>
              {(() => {
                const notes = (res!.data.notes ?? []).filter((n) => !/filters\.(archived|space)/.test(n));
                return notes.length ? <p className="hint">{notes.join(" ")}</p> : null;
              })()}
              <ol className="hits search-hits" start={shownBefore + 1}>{(allWeak ? weak : strong).map(row)}</ol>
              {weak.length && !allWeak ? (
                <details className="weak">
                  <summary>{M.weakMore(weak.length)}</summary>
                  <ol className="hits search-hits" start={shownBefore + strong.length + 1}>{weak.map(row)}</ol>
                </details>
              ) : null}
              <nav className="pager" aria-label={M.searchResultPages}>{rich(M.pageOnThisPageLine, { tag1: (children) => <span className="muted">{children}</span>, tag2: (children) => <span className="pager-links">{children}</span> }, { value1: page, value2: atLimit ? M.lastOf(MAX_PAGES) : "", value3: hits.length, value4: page > 1 ? <Link prefetch={false} href={pageHref(1)}>{M.first}</Link> : null, value5: page > 1 ? <Link prefetch={false} href={pageHref(page - 1)}>{M.previous}</Link> : null, value6: hasNext ? <Link prefetch={false} className="pager-next" href={pageHref(page + 1)}>{M.next}</Link> : <span className="muted">{M.thisIsTheLastPage}</span> })}</nav>
              {atLimit ? (
                <p className="hint">{rich(M.searchStopsAfterPageNarrowYourLine, null, { value1: MAX_PAGES })}</p>
              ) : null}
            </>
          )}
        </Section>
      )}
    </>
  );
}
