// memory_me in the first minute of an agent session: the latest personal notes and the first-minute view of the
// text. Only the MCP answer gets them (tools/call memory_me): REST GET /me and the workplace keep the answer as it was.
//
// Notes: the caller's own personal space among the spaces memory_me already lists, type note, the open class only — the
// query goes to the database of the open class and nowhere else, so a closed note is never listed to any key — with the
// caller's own visibility (the same builder as memory_list), newest three. Their ids go into the `read` event memory_me
// writes anyway (record_ids), so there is no second journal event per session start.
// The structured form `recent_notes` is added to a lean answer only (mcp-shape.ts); a `full` answer stays as before.
import { binder, recordPath, visibleSql } from "@memory/shared";
import { ME_NOTES_MAX, type MeFirstMinute, type MeSpaceLine } from "@memory/mcp-core";
import type { App, Caller } from "./context.ts";
import type { SpaceAccess } from "./access.ts";
import { listingSpec } from "./visibility.ts";

/** A latest personal note: what the text and `recent_notes` show, and the id the journal records. */
export interface RecentNote { id: string; path: string; title: string; occurred_at: string }
/** An item of `recent_notes` in a lean answer of memory_me. */
export type RecentNoteView = Omit<RecentNote, "id">;

/** The caller's own personal space among the listed ones (readableSpaces gives a personal space to its owner only). */
export const ownPersonal = (caller: Caller, spaces: readonly SpaceAccess[]): SpaceAccess | undefined =>
  caller.person ? spaces.find((s) => s.kind === "personal" && s.owner_id === caller.person!.id) : undefined;

/** The newest ME_NOTES_MAX open notes of the caller's personal space, only when the caller may call memory_list. */
export async function recentNotes(app: App, caller: Caller, spaces: readonly SpaceAccess[], tools: readonly string[]): Promise<RecentNote[]> {
  if (!tools.includes("memory_list")) return [];
  const personal = ownPersonal(caller, spaces);
  if (!personal || !caller.scope.classes.includes("open")) return [];
  const args: unknown[] = [], bind = binder(args);
  const vis = visibleSql(listingSpec(app, caller, [personal.id]), "open", bind);
  if (vis === null) return [];
  const { rows } = await app.db.records("open", caller.scope).query(
    `SELECT r.id, r.title, r.occurred_at FROM records_live r
     WHERE ${vis} AND r.space_id = ${bind(personal.id)}::uuid AND r.type = 'note'
     ORDER BY r.occurred_at DESC, r.id DESC LIMIT ${ME_NOTES_MAX}`, args);
  return rows.map((r) => ({ id: r.id as string, path: recordPath(personal.slug, "note", r.occurred_at as Date, r.id as string),
                            title: (r.title as string | null) ?? "", occurred_at: new Date(r.occurred_at as Date).toISOString() }));
}

/** The fields of the memory_me answer the first-minute view reads. */
export interface FirstMinuteResult {
  key: { kind: string; expires_at: string | null; personal_class: "open" | "closed"; personal_class_reason: string };
  spaces: ReadonlyArray<{ slug: string; kind: string; name: string; description: string | null; role: string }>;
}

/**
 * The first-minute part of the text: the end of the key's access, the spaces (the own personal one first and as `me`, the
 * others in the order of the answer), where a note of this key goes (a person's key that may call memory_remember; a
 * service — no line), the latest notes, the next calls this key may make.
 */
export function meFirstMinuteView(result: FirstMinuteResult, notes: readonly RecentNote[], tools: readonly string[]): MeFirstMinute {
  const line = (s: FirstMinuteResult["spaces"][number]): MeSpaceLine => ({ slug: s.kind === "personal" ? "me" : s.slug, role: s.role, about: s.description || s.name || null });
  const personal = result.spaces.filter((s) => s.kind === "personal"), others = result.spaces.filter((s) => s.kind !== "personal");
  const person = result.key.personal_class_reason !== "service";
  return {
    until: result.key.expires_at ? result.key.expires_at.slice(0, 10) : null,
    spaces: [...personal, ...others].map(line),
    notes_to: person && tools.includes("memory_remember") ? { slug: "me", class: result.key.personal_class } : null,
    notes: notes.map((n) => ({ date: n.occurred_at.slice(0, 10), path: n.path, title: n.title })),
    next: { search: tools.includes("memory_search"), list: tools.includes("memory_list") },
  };
}

/** `recent_notes` of a lean answer: path, title, time — no ids. */
export const recentNotesView = (notes: readonly RecentNote[]): RecentNoteView[] => notes.map(({ path, title, occurred_at }) => ({ path, title, occurred_at }));
