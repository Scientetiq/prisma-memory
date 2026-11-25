import { searchPage as m } from "@/messages/panel-search";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon, TYPE_ICON } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, Code, Empty, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { clientKindTitle, KEY_KIND_TITLES, RECORD_TYPE_TITLES } from "@/lib/labels";
import { param, type SearchParams } from "@/lib/paging";
import { formatDay } from "@/lib/plain";
import { summarizeStageCounts } from "@/lib/stages";
import { LOOKUP_LIMIT, type AdminLookup } from "@/lib/types";

export function generateMetadata(): Metadata { return { title: m.systemSearch }; }

// i18n-ignore: API route and key/path syntax are protocol examples, not prose.
const LOOKUP_ROUTE = "/api/v1/admin/lookup", KEY_PREFIX = "mem_…";

const withCap = (kind: "records" | "keys" | "other", n: number): string | undefined =>
  m.resultHint(kind, n, LOOKUP_LIMIT) || undefined;

export default async function AdminSearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const q = param(sp, "q").trim();
  const res = q.length >= 2 ? await tryGw<AdminLookup>("/api/v1/admin/lookup", { query: { q } }) : null;
  const missing = Boolean(res && !res.ok && (res.status === 404 || res.code === "not_found"));
  const d = res?.ok ? res.data : null;
  const found = (d?.records?.length ?? 0) + (d?.people?.length ?? 0) + (d?.spaces?.length ?? 0) + (d?.keys?.length ?? 0);

  return (
    <PageFrame title={m.systemSearch} lead={m.aRecordIdOrPathAPersonS}>
      <form method="get" action="/admin/search" className="search-form">
        <div className="q">
          <input type="search" name="q" defaultValue={q} placeholder={m.lookupExample} aria-label={m.whatToSearchFor} autoFocus={!q} />
          <button type="submit" className="btn primary">{m.search}</button>
        </div>
      </form>

      <Notice tone="info">{rich(m.recordContentIsHiddenFromAdministratorsByDesign, { strong1: (children) => <strong>{children}</strong> })}</Notice>

      {!q ? <Empty>{m.enterAtLeastTwoCharactersToSearch}</Empty>
        : missing ? <Notice tone="warn">{rich(m.theGatewayDoesNotProvideSystemSearchYet, { strong1: (children) => <strong>{children}</strong>, link2: (children) => <Link href="/admin/people" prefetch={false}>{children}</Link>, link3: (children) => <Link href="/admin/spaces" prefetch={false}>{children}</Link>, link4: (children) => <Link href="/admin/services" prefetch={false}>{children}</Link>, link5: (children) => <Link href="/admin/unprocessed" prefetch={false}>{children}</Link>, link6: (children) => <Link href="/admin/audit" prefetch={false}>{children}</Link> }, { value: <Code>{LOOKUP_ROUTE}</Code> })}</Notice>
        : res && !res.ok ? <LoadError result={res} what={m.searchResults} />
        : !found ? <Empty>{rich(m.nothingFoundSearchByFullRecordIdThe, null, { path: <Code>{m.lookupPath()}</Code>, value: <Code>{KEY_PREFIX}</Code> })}</Empty>
        : (
          <>
            {d?.records?.length ? (
              <Section title={m.records(d.records.length)} hint={withCap("records", d.records.length)}>
                <TableWrap>
                  <table className="board">
                    <thead><tr><th>{m.record}</th><th>{m.type}</th><th>{m.owner}</th><th>{m.space}</th><th>{m.class}</th><th>{m.processing}</th><th>{m.received}</th></tr></thead>
                    <tbody>
                      {d.records.map((r) => {
                        const st = summarizeStageCounts(r.stages);
                        return (
                          <tr key={r.id}>
                            <td>
                              <Code title={r.id}>{r.id}</Code>{r.path ? <div className="cell-sub"><Code>{r.path}</Code></div> : null}
                              <div className="cell-sub"><Link href={`/admin/audit?record=${encodeURIComponent(r.id)}#events`} prefetch={false}>{m.auditLogEvents}</Link></div>
                            </td>
                            <td className="nowrap">{r.type ? <><Icon name={TYPE_ICON[r.type] ?? "file"} /> {RECORD_TYPE_TITLES[r.type] ?? r.type}</> : <span className="muted">—</span>}</td>
                            <td>{r.owner ? <Link href={`/admin/people/${encodeURIComponent(r.owner)}`} prefetch={false}><Code>{r.owner}</Code></Link> : <span className="muted">—</span>}</td>
                            <td>{r.space ? <Link href={`/admin/spaces/${encodeURIComponent(r.space)}`} prefetch={false}><Code>{r.space}</Code></Link> : <span className="muted">—</span>}</td>
                            <td>{r.class ? <VisibilityBadge cls={r.class} tech /> : null}</td>
                            <td><span className={`chip ${st.tone}`}>{st.label}</span></td>
                            <td className="nowrap">{r.created_at ? <LocalTime iso={r.created_at} /> : <span className="muted">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              </Section>
            ) : null}

            {d?.people?.length ? (
              <Section title={m.people(d.people.length)} hint={withCap("other", d.people.length)}>
                <ul className="row-list">
                  {d.people.map((p) => (
                    <li className="row" key={p.login}>
                      <span className="ric"><Icon name="user" /></span>
                      <span className="t"><Link href={`/admin/people/${encodeURIComponent(p.login)}`} prefetch={false}>{p.display_name || p.login}</Link><small><Code>{p.login}</Code></small></span>
                      <span className="rmeta">{p.active === false ? <Badge tone="muted">{m.inactive}</Badge> : <Badge tone="ok">{m.active}</Badge>}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {d?.spaces?.length ? (
              <Section title={m.spaces(d.spaces.length)} hint={withCap("other", d.spaces.length)}>
                <ul className="row-list">
                  {d.spaces.map((s) => (
                    <li className="row" key={s.slug}>
                      <span className="ric"><Icon name="box" /></span>
                      <span className="t"><Link href={`/admin/spaces/${encodeURIComponent(s.slug)}`} prefetch={false}>{s.title || s.slug}</Link><small><Code>{s.slug}</Code>{s.kind ? m.spaceKindSuffix(s.kind) : ""}</small></span>
                      <span className="rmeta">{s.owner ? <span className="muted small">{rich(m.owner2, null, { value: <Code>{s.owner}</Code> })}</span> : <span className="muted small">{m.noOwner}</span>}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {d?.keys?.length ? (
              <Section title={m.keys(d.keys.length)} hint={withCap("keys", d.keys.length)}>
                <TableWrap>
                  <table className="board">
                    <thead><tr><th>{m.prefix}</th><th>{m.kind}</th><th>{m.owner3}</th><th>{m.expiry}</th><th>{m.status}</th></tr></thead>
                    <tbody>
                      {d.keys.map((k) => (
                        <tr key={k.id} className={k.revoked_at ? "off" : undefined}>
                          <td><Code title={k.id}>{k.prefix}…</Code></td>
                          <td>{KEY_KIND_TITLES[k.kind] ?? k.kind}{k.principal_type === "person" && k.client_kind ? <div className="cell-sub">{clientKindTitle(k.client_kind)}</div> : null}</td>
                          <td>{!k.principal ? <span className="muted">—</span>
                            : k.principal_type === "person" ? <Link href={`/admin/people/${encodeURIComponent(k.principal)}`} prefetch={false}><Code>{k.principal}</Code></Link>
                            : <Code>{k.principal}</Code>}{k.client_label ? <div className="cell-sub">{k.client_label}</div> : null}</td>
                          <td className="nowrap">{k.expires_at ? formatDay(k.expires_at) : <span className="muted">{m.noExpiry}</span>}</td>
                          <td>{k.revoked_at ? <Badge tone="muted">{m.revoked}</Badge> : k.expires_at && Date.parse(k.expires_at) <= Date.now() ? <Badge tone="warn">{m.expired}</Badge> : <Badge tone="ok">{m.active2}</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Section>
            ) : null}
          </>
        )}
    </PageFrame>
  );
}
