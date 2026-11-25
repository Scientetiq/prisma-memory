import { auditText } from "@/messages/panel-audit";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { PersonSuggest } from "@/components/person-suggest";
import { Badge, Code, Empty, LoadError, Section, TableWrap, type Tone } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { collapseRuns, detailRows, isWorkplaceSession, opTitleOf, spanText, tierPlain } from "@/lib/audit-view";
import { shortId } from "@/lib/format";
import { isId } from "@/lib/form";
import { AUDIT_EVENT_TITLES, AUDIT_EVENT_TYPES, CLAIMED_SOURCE_TITLES, claimedTitle, RECORD_TYPE_TITLES } from "@/lib/labels";
import { auditCursorOf, hrefWith, PAGE_SIZE, param, type SearchParams } from "@/lib/paging";
import { formatCount } from "@/lib/plain";
import type { AuditEvent, AuditPage as AuditPageData, AuditRecordRef } from "@/lib/types";

export function generateMetadata(): Metadata { return { title: auditText.auditLog }; }

const EVENT_TONES: Record<string, Tone> = { auth_failure: "danger", rate_limited: "warn", forget: "warn", purge: "warn", open: "warn", class_move: "warn", extended_key_use: "warn", t1_fallback: "warn", admin: "info" };
const SHOWN_RECORDS = 3;
const LOGIN_TYPE = "login";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function Details({ details }: { details: AuditEvent["details"] }) {
  const rows = detailRows(details);
  if (!rows.length) return <span className="muted">—</span>;
  return (
    <details className="details-more">
      <summary>{auditText.details}</summary>
      <dl className="details-list">
        {rows.slice(0, 16).map((r) => <div key={r.key}><dt title={r.key}>{r.label}</dt><dd>{r.value}</dd></div>)}
        {rows.length > 16 ? <div><dt>{auditText.more}</dt><dd>{rows.length - 16}</dd></div> : null}
      </dl>
    </details>
  );
}

function RecordRef({ r }: { r: AuditRecordRef }) {
  const type = r.type ? RECORD_TYPE_TITLES[r.type] ?? r.type : auditText.record;
  return (
    <div className="cell-sub">
      {r.deleted && !r.type ? <span className="muted">{auditText.deletedOrPurged}</span> : (
        <>
          {r.class === "open" && r.title ? <b>{r.title}</b> : <span>{type}</span>}
          {r.class ? <> <VisibilityBadge cls={r.class} /></> : null}
          {r.space ? <> · <Link href={`/admin/spaces/${encodeURIComponent(r.space)}`} prefetch={false}>{r.space_name ?? r.space}</Link></> : null}
          {r.class !== "open" && (r.owner_name || r.owner) ? <> · {r.owner_name ?? r.owner}</> : null}
          {r.class !== "open" && r.created_at ? <> · <LocalTime iso={r.created_at} short /></> : null}
          {r.deleted ? <> · <span className="muted">{auditText.deleted}</span></> : null}
        </>
      )}
      {" "}<Link href={`/admin/search?q=${encodeURIComponent(r.id)}`} prefetch={false} className="muted" title={auditText.recordInUnifiedSearch(r.id)}>{shortId(r.id)}</Link>
    </div>
  );
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(true);
  const sp = await searchParams;
  const askedType = param(sp, "event_type"), login = param(sp, "login").toLowerCase(), asked = param(sp, "cursor");
  const askedKey = param(sp, "key_id");
  const service = param(sp, "service") === "hide" ? "hide" : "";
  const isLogin = askedType === LOGIN_TYPE;
  const event_type = isLogin || (AUDIT_EVENT_TYPES as readonly string[]).includes(askedType) ? askedType : "";
  const key_id = isId(askedKey) ? askedKey : "";
  const who = param(sp, "who").replace(/\s+/g, " ").trim().slice(0, 100);
  const person = isId(param(sp, "person")) ? param(sp, "person") : "";
  const from = DATE_RE.test(param(sp, "from")) ? param(sp, "from") : "", to = DATE_RE.test(param(sp, "to")) ? param(sp, "to") : "";
  const space = SLUG_RE.test(param(sp, "space").toLowerCase()) ? param(sp, "space").toLowerCase() : "";
  const record = isId(param(sp, "record")) ? param(sp, "record") : "";
  const cursor = auditCursorOf(asked);
  const prev = param(sp, "prev").split(",").map((x) => auditCursorOf(x.trim())).filter(Boolean).slice(-20);
  const params = { event_type, login, who: person ? "" : who, person, from, to, space, record, key_id, service, cursor, prev: prev.join(",") };
  const backHref = hrefWith("/admin/audit", params, { cursor: prev[prev.length - 1] ?? null, prev: prev.slice(0, -1).join(",") || null }) + "#events";
  const nextHrefOf = (next: string) => hrefWith("/admin/audit", params, { cursor: next, prev: [...prev, cursor].filter(Boolean).join(",") || null }) + "#events";
  const startHref = hrefWith("/admin/audit", params, { cursor: null, prev: null }) + "#events";
  const filtered = Boolean(event_type || login || who || person || from || to || space || record || key_id || service);

  const res = await tryGw<AuditPageData>("/api/v1/admin/audit", { query: {
    limit: PAGE_SIZE, cursor, event_type: isLogin ? undefined : event_type, op: isLogin ? "login" : undefined, login, key_id,
    q: person || who.length < 2 ? undefined : who, person_id: person || undefined, from: from || undefined, to: to || undefined,
    space: space || undefined, record_id: record || undefined, hide_service: service ? "true" : undefined } });
  const found = res.ok ? res.data.people ?? null : null;
  const rows = res.ok ? collapseRuns(res.data.items) : [];
  const personShown = person && res.ok ? res.data.items.find((e) => e.actor_id === person || e.on_behalf_of_id === person) : undefined;
  const personName = personShown ? (personShown.actor_id === person ? personShown.actor_name ?? personShown.actor : personShown.on_behalf_of_name ?? personShown.on_behalf_of) : null;

  return (
    <PageFrame allowAuditor title={auditText.auditLog2} lead={auditText.accessAndChangeHistoryWhoWhatWhich}>
      <Section title={auditText.events} id="events" hint={auditText.perPageNewestFirst(PAGE_SIZE)}>
        <form method="get" action="/admin/audit" className="filter-form">
          <label className="field">
            <span className="field-label">{auditText.eventType}</span>
            <select name="event_type" defaultValue={event_type}>
              <option value="">{auditText.all}</option>
              <option value={LOGIN_TYPE} title={auditText.administrationSignInOpLogin}>{auditText.workspaceSignIn}</option>
              {AUDIT_EVENT_TYPES.map((t) => <option key={t} value={t} title={t}>{AUDIT_EVENT_TITLES[t]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{auditText.who}</span>
            <PersonSuggest textName="who" pickedFields={{ id: "person" }} defaultText={person ? "" : who} label={auditText.whoActedOrWasRepresented}
              defaultPicked={person ? { id: person, login: personShown ? (personShown.actor_id === person ? personShown.actor : personShown.on_behalf_of ?? "") : "", display_name: personName } : null}
              placeholder={auditText.nameOrPartOfALogin} />
          </label>
          <label className="field">
            <span className="field-label">{auditText.from}</span>
            <input type="date" name="from" defaultValue={from} />
          </label>
          <label className="field">
            <span className="field-label">{auditText.to}</span>
            <input type="date" name="to" defaultValue={to} />
          </label>
          <label className="field">
            <span className="field-label">{auditText.space}</span>
            <input type="search" name="space" defaultValue={space} placeholder={auditText.addressForExampleSales} autoCapitalize="none" spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{auditText.record2}</span>
            <input type="search" name="record" defaultValue={record} placeholder={auditText.recordID} pattern="[0-9a-fA-F-]{36}" title={auditText.fullRecordID36Characters} />
          </label>
          <label className="field">
            <span className="field-label">{auditText.key}</span>
            <input type="search" name="key_id" defaultValue={key_id} placeholder={auditText.keyID} pattern="[0-9a-fA-F-]{36}" title={auditText.fullKeyID36CharactersShownIn} />
          </label>
          {login ? <input type="hidden" name="login" value={login} /> : null}
          <label className="check" title={auditText.serviceEventsIncludeWorkspaceProfileAndList}>{rich(auditText.hideServiceEvents, null, { value1: (<input type="checkbox" name="service" value="hide" defaultChecked={service === "hide"} />) })}</label>
          <button type="submit" className="btn">{auditText.show}</button>
          {filtered ? <Link href="/admin/audit" prefetch={false} className="quiet">{auditText.reset}</Link> : null}
        </form>
        {login ? <p className="hint">{rich(auditText.onlyEventsFor, null, { value1: (<Code>{login}</Code>), value2: (<Link href={hrefWith("/admin/audit", params, { login: null, cursor: null, prev: null })} prefetch={false}>{auditText.remove}</Link>) })}</p> : null}

        {found && !person ? (
          !found.length ? <p className="notice warn" role="status">{rich(auditText.noPersonFoundForCheckTheName, null, { value1: who })}</p>
          : found.length > 1 ? (
            <div className="notice info" role="status">
              <strong>{auditText.severalPeopleMatchedShowingAllTheirEvents}</strong>
              <ul className="choice-list">
                {found.slice(0, 20).map((p) => (
                  <li key={p.id}><Link href={hrefWith("/admin/audit", params, { who: null, person: p.id, cursor: null, prev: null }) + "#events"} prefetch={false}>{p.display_name || p.login}</Link> <span className="muted small">{p.login}{p.active ? "" : auditText.disabled}</span></li>
                ))}
              </ul>
              {found.length > 20 ? <span className="muted small">{rich(auditText.andMoreRefineTheName, null, { value1: found.length - 20 })}</span> : null}
            </div>
          ) : null
        ) : null}
        {res.ok && service && typeof res.data.hidden_service === "number" ? (
          <p className="hint">{rich(auditText.hiddenServiceEvents, null, { value1: res.data.hidden_service > 10_000 ? auditText.moreThan10000 : formatCount(res.data.hidden_service), value2: (<Link href={hrefWith("/admin/audit", params, { service: null, cursor: null, prev: null }) + "#events"} prefetch={false}>{auditText.show2}</Link>) })}</p>
        ) : null}

        {!res.ok ? <LoadError result={res} what={auditText.auditLog3} /> : !res.data.items.length ? (
          <>
            <Empty>{cursor ? auditText.noEarlierEvents : filtered ? auditText.noEventsMatchTheFilters : auditText.theAuditLogIsEmpty}</Empty>
            {cursor ? <div className="pager"><span className="muted">{auditText.rowsShown0}</span><span className="pager-links"><Link prefetch={false} href={startHref}>{auditText.first}</Link>{prev.length ? <Link prefetch={false} href={backHref}>{auditText.back}</Link> : null}</span></div> : null}
          </>
        ) : (
          <>
            <TableWrap>
              <table className="board cards-mobile">
                <thead>
                  <tr><th>{auditText.when}</th><th>{auditText.who2}</th><th>{auditText.what}</th><th>{auditText.target}</th><th>{auditText.key2}</th><th>{auditText.details2}</th></tr>
                </thead>
                <tbody>
                  {rows.map(({ event: e, count, firstAt }) => {
                    const ids = e.record_ids ?? [];
                    const recs = e.records ?? [];
                    const op = typeof e.details?.op === "string" ? e.details.op : null;
                    const preview = e.details?.preview === true;
                    const sent = e.details?.client && typeof e.details.client === "object" ? e.details.client as { name?: unknown; version?: unknown; source?: unknown; ua?: unknown } : null;
                    const sentName = typeof sent?.name === "string" ? sent.name : null;
                    const how = tierPlain(e.tier, e.client_label);
                    const label = e.client_label && !isWorkplaceSession(e.client_label) && !e.client_label.startsWith("admin:") ? e.client_label : null;
                    return (
                      <tr key={e.id}>
                        <td data-label={auditText.when2}>
                          <LocalTime iso={e.at} seconds />
                          {count > 1 ? <div className="cell-sub">× {count} {spanText(firstAt, e.at)}</div> : null}
                        </td>
                        <td data-label={auditText.who3}>
                          {e.actor_id ? (
                            <Link href={hrefWith("/admin/audit", params, { who: null, person: e.actor_id, login: null, cursor: null, prev: null }) + "#events"} prefetch={false} title={auditText.allEventsForThisPerson}>{e.actor_name || e.actor}</Link>
                          ) : <span>{e.actor_name || e.actor}</span>}
                          {e.actor_name ? <div className="cell-sub">{e.actor}</div> : null}
                          {e.on_behalf_of ? <div className="cell-sub">{rich(auditText.onBehalfOf, null, { value1: e.on_behalf_of_id ? <Link href={hrefWith("/admin/audit", params, { who: null, person: e.on_behalf_of_id, login: null, cursor: null, prev: null }) + "#events"} prefetch={false}>{e.on_behalf_of_name || e.on_behalf_of}</Link> : e.on_behalf_of })}</div> : null}
                          {how || label ? <div className="cell-sub" title={e.tier ?? undefined}>{[how, label].filter(Boolean).join(" · ")}</div> : null}
                          {sentName ? (
                            <div className="cell-sub" title={auditText.selfReportedClientProgramTheClientSupplies(CLAIMED_SOURCE_TITLES[String(sent!.source) as keyof typeof CLAIMED_SOURCE_TITLES] ?? String(sent!.source), typeof sent!.ua === "string" ? auditText.userAgent(sent!.ua) : "")}>
                              {claimedTitle({ name: sentName, version: typeof sent!.version === "string" ? sent!.version : undefined, kind: e.client_kind ?? null })}
                            </div>
                          ) : null}
                          {preview ? <div><Badge tone="violet" title={auditText.actionInViewAsModeAdminPanel}>{auditText.preview}</Badge></div> : null}
                        </td>
                        <td data-label={auditText.what2}>
                          <span className="arrow" aria-hidden="true">→</span>
                          {e.auto ? <Badge tone="muted" title={e.event_type}>{auditText.automaticWorkspace}</Badge>
                            : <Badge tone={EVENT_TONES[e.event_type] ?? "neutral"} title={e.event_type}>{AUDIT_EVENT_TITLES[e.event_type] ?? e.event_type}</Badge>}
                          {op ? <div className="cell-sub" title={op}>{opTitleOf(op, e.details)}</div> : null}
                          {e.service && !e.auto ? <div className="cell-sub">{auditText.serviceEvent}</div> : null}
                          {e.details?.extended_open === true ? <> <Badge tone="warn" title={auditText.anAgentWithExtendedAccessWroteAn}>{auditText.extendedAccess}</Badge></> : null}
                          {e.details?.widened_by_human === true ? <> <Badge tone="warn" title={auditText.aPersonConfirmedMovingASummaryTo}>{auditText.widerThanSources}</Badge></> : null}
                          {e.result_count !== null && e.result_count !== undefined ? <div className="cell-sub">{rich(auditText.results, null, { value1: e.result_count })}</div> : null}
                          {e.has_query_text ? <div className="cell-sub">{auditText.aQueryWasPresentNotShownIn}</div> : null}
                        </td>
                        <td data-label={auditText.target2}>
                          <span className="arrow" aria-hidden="true">→</span>
                          {e.space ? <Link href={`/admin/spaces/${encodeURIComponent(e.space)}`} prefetch={false}>{e.space}</Link> : null}
                          {e.class ? <> <VisibilityBadge cls={e.class} /></> : null}
                          {recs.length ? recs.slice(0, SHOWN_RECORDS).map((r) => <RecordRef key={r.id} r={r} />)
                            : ids.slice(0, SHOWN_RECORDS).map((id) => <div key={id} className="cell-sub"><Link href={`/admin/search?q=${encodeURIComponent(id)}`} prefetch={false} className="muted" title={id}>{shortId(id)}</Link></div>)}
                          {ids.length > SHOWN_RECORDS ? <div className="cell-sub muted" title={ids.join("\n")}>{rich(auditText.moreRecords, null, { value1: ids.length - SHOWN_RECORDS })}</div> : null}
                          {!e.space && !e.class && !ids.length ? <span className="muted">{auditText.instance}</span> : null}
                        </td>
                        <td data-label={auditText.key3}>
                          {e.key_id ? (
                            <Link href={hrefWith("/admin/audit", params, { key_id: e.key_id, cursor: null, prev: null })} prefetch={false} title={auditText.allEventsForKey(e.key_id)} className="muted">{shortId(e.key_id)}</Link>
                          ) : <span className="muted">—</span>}
                        </td>
                        <td data-label={auditText.details3}><Details details={e.details} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <div className="pager">
              <span className="muted">{rich(auditText.rowsShown, null, { value1: res.data.items.length, value2: prev.length ? auditText.page(prev.length + 1) : "" })}</span>
              <span className="pager-links">
                {cursor ? <Link prefetch={false} href={startHref}>{auditText.first2}</Link> : null}
                {prev.length ? <Link prefetch={false} href={backHref}>{auditText.back2}</Link> : null}
                {res.data.next_cursor ? <Link prefetch={false} href={nextHrefOf(res.data.next_cursor)}>{auditText.next}</Link> : <span className="muted">{auditText.lastPage}</span>}
              </span>
            </div>
          </>
        )}
      </Section>
    </PageFrame>
  );
}
