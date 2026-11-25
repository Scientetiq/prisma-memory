// Record titles in the "My actions" feed: "Claude Code on Windows wrote the note '…'" — with a link,
// not "Records: 1". Only to the person themselves in the workplace (a session: it may see both open and closed) and only records
// they can read now — the same visibility check by id as memory_read and links (visibilityFor byId +
// visibleSql, like links.ts linksVisibleTo). Deleted, hidden and others' records get no title: the feed writes "unavailable or
// deleted". An agent key gets no titles: recent_actions and the agent answer stay. Titles of closed records read closed data:
// one read event per page (details.op my_audit_titles, the strict journal — not written, no titles); in "My actions"
// themselves and in the panel journal this row is a service one (WORKPLACE_SERVICE_SQL). Called only with titles=true
// (REST /me/audit): the Overview and other journal queries need no titles — no visibility checks, no event.
import { binder, visibleSql, type DataClass } from "@memory/shared";
import { visibilityFor } from "./access.ts";
import { auditRead, MY_AUDIT_TITLES_OP } from "./audit.ts";
import type { App, Caller } from "./context.ts";

export interface MyAuditRecord { id: string; title: string | null; type: string }
/** How many records of one row get a title: the feed shows the first ones, for the rest — "and N more". */
export const TITLES_PER_ROW = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Titles only for the person's own workplace session; not for the panel preview or agent keys. */
export const titlesFor = (caller: Pick<Caller, "keyKind" | "preview" | "person">): boolean => caller.keyKind === "session" && !caller.preview && !!caller.person;

export async function withRecordTitles<T extends { record_ids: string[] }>(app: App, caller: Caller, items: T[]): Promise<Array<T & { records?: MyAuditRecord[] }>> {
  if (!titlesFor(caller)) return items;
  const ids = [...new Set(items.flatMap((i) => i.record_ids.slice(0, TITLES_PER_ROW)).filter((id) => UUID.test(id)))];
  if (!ids.length) return items;
  const { spec } = await visibilityFor(app, caller, { byId: true });
  const found = new Map<string, MyAuditRecord & { class: DataClass }>();
  for (const cls of ["open", "closed"] as const) {
    const args: unknown[] = [], bind = binder(args), visibility = visibleSql(spec, cls, bind);
    if (visibility === null) continue;                       // the class is not available — its base is not queried
    const { rows } = await app.db.records(cls, caller.scope).query<{ id: string; title: string | null; type: string; class: DataClass }>(
      `SELECT r.id, r.title, r.type, r.class FROM records r WHERE r.id = ANY(${bind(ids)}::uuid[]) AND r.deleted_at IS NULL AND r.hidden_at IS NULL AND ${visibility}`, args);
    for (const r of rows) found.set(r.id, { id: r.id, title: r.title ?? null, type: r.type, class: r.class });
  }
  const closed = [...found.values()].filter((r) => r.class === "closed").map((r) => r.id);
  // titles of closed ones read closed data: none without a journal write (auditRead throws — the page gets an error)
  if (closed.length) await auditRead(app, caller, { event_type: "read", class: "closed", record_ids: closed, details: { op: MY_AUDIT_TITLES_OP, titles: closed.length } });
  return items.map((i) => ({
    ...i,
    records: i.record_ids.slice(0, TITLES_PER_ROW).flatMap((id) => { const r = found.get(id); return r ? [{ id: r.id, title: r.title, type: r.type }] : []; }),
  }));
}
