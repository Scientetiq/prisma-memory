import type { ConfirmSpec } from "@/components/confirm-dialog";
import { formatWhen } from "./format";
import { zonedParts } from "../i18n/format";
import { instanceTz } from "../i18n/runtime";
import { derived } from "../i18n/runtime";
import type { TrashItem } from "./types";
import { TRASH_MESSAGES } from "../messages/trash";

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */

export { PURGE_SPEC } from "../messages/trash";

export function trashLead(trashDays?: number | null): string {
  return trashDays ? TRASH_MESSAGES.deletedRecordsAreKeptHere2(trashDays) : TRASH_MESSAGES.deletedRecordsAreKeptHere;
}

export const trashPlace = (t: Pick<TrashItem, "space">): string => (t.space.kind === "personal" ? TRASH_MESSAGES.personal : t.space.name || TRASH_MESSAGES.unnamedSpace);

export function deletedByLine(t: Pick<TrashItem, "deleted_by" | "deleted_by_me" | "deleted_by_space_owner" | "deleted_reason">): string {
  if (t.deleted_by_me) return TRASH_MESSAGES.deletedByYou;
  if (t.deleted_by) return TRASH_MESSAGES.deletedBy(t.deleted_by.display_name || t.deleted_by.login, t.deleted_by_space_owner ? TRASH_MESSAGES.spaceOwner : "");
  return t.deleted_reason === "deletion_request" ? TRASH_MESSAGES.deletedByAnAdministratorAt : TRASH_MESSAGES.deletedAutomatically;
}

const DAY_MS = 86_400_000;
export function trashDay(iso: string | null | undefined, now = Date.now(), tz: string = instanceTz()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  return formatWhen(iso!, { tz, dayOnly: true, now: new Date(now) });
}
/** Number of the calendar day of moment t on the clock of zone tz: "tomorrow" is the next date, not 24 hours later. */
const zoneDay = (t: number, tz: string): number => {
  const p = zonedParts(new Date(t), tz);
  return Date.UTC(p.y, p.m - 1, p.d) / DAY_MS;
};
export function purgeIn(purgeAfter: string | null, now = Date.now(), tz: string = instanceTz()): { text: string; soon: boolean } {
  if (purgeAfter === null) return { text: TRASH_MESSAGES.trashHeld, soon: false };
  const at = Date.parse(purgeAfter);
  const left = Number.isNaN(at) || at <= now ? 0 : Math.max(0, zoneDay(at, tz) - zoneDay(now, tz));
  const text = left <= 0 ? TRASH_MESSAGES.willBeDeletedToday : left === 1 ? TRASH_MESSAGES.willBeDeletedTomorrow : TRASH_MESSAGES.willBeDeletedIn(left);
  return { text, soon: left < 3 };
}

export function shortTermNote(t: Pick<TrashItem, "kept_days" | "deleted_reason">, trashDays?: number | null): string | null {
  if (!t.kept_days || !trashDays || t.kept_days >= trashDays) return null;
  return TRASH_MESSAGES.keptFor(t.kept_days, trashDays, t.deleted_reason === "automatic");
}

export function shortTermShared(items: readonly Pick<TrashItem, "kept_days" | "deleted_reason">[], trashDays?: number | null): { lines: string[]; shared: ReadonlySet<string> } {
  const counts = new Map<string, number>();
  for (const t of items) {
    const note = shortTermNote(t, trashDays);
    if (note) counts.set(note, (counts.get(note) ?? 0) + 1);
  }
  const shared = new Set([...counts].filter(([, n]) => n > 1).map(([note]) => note));
  const lines = [...shared].map((note) => {
    const n = counts.get(note)!;
    return n === items.length ? TRASH_MESSAGES.appliesToEveryRecordOn(note) : TRASH_MESSAGES.appliesTo(note, n);
  });
  return { lines, shared };
}

const WITH_ORDER = ["summary", "event", "note", "document", "transcript", "profile"];
export function derivedLine(t: Pick<TrashItem, "derived" | "affected">): string | null {
  const d = t.derived;
  const parts = d && Object.keys(d).length
    ? Object.entries(d).filter(([, n]) => n > 0)
      .sort(([a], [b]) => (WITH_ORDER.indexOf(a) + 1 || 99) - (WITH_ORDER.indexOf(b) + 1 || 99))
       .map(([type, n]) => TRASH_MESSAGES.derivedPart(type, n))
    : t.affected > 1 ? [TRASH_MESSAGES.derivedRecords(t.affected - 1)] : [];
  if (!parts.length) return null;
  return TRASH_MESSAGES.derivedList(parts);
}

export function purgeQuestion(title: string | null, kind: string, deletedDay: string): { question: string; change: string } {
  return {
    question: title ? TRASH_MESSAGES.permanentlyDelete(title) : TRASH_MESSAGES.permanentlyDeleteThisRecord(kind.toLowerCase(), deletedDay),
    change: TRASH_MESSAGES.recoveryWillBeImpossibleThe,
  };
}
export function restoredHref(id: string, n: number, space?: { slug: string; kind: string } | null, closed: boolean | "nda" | "organizer" = false): string {
  const q = new URLSearchParams({ restored: id, n: String(Math.max(1, Math.trunc(n) || 1)) });
  if (space?.slug) q.set("in", space.kind === "personal" ? "me" : space.slug);
  if (closed) q.set("closed", closed === true ? "1" : closed);
  return `/trash?${q}`;
}
export function restoredPlace(at: string, spaces: ReadonlyArray<{ slug: string; kind: string; name: string }>): { name: string; kind: string } | null {
  const s = at === "me" ? spaces.find((x) => x.kind === "personal") : at ? spaces.find((x) => x.slug === at) : undefined;
  return s ? { name: s.name, kind: s.kind } : null;
}
export const restoredText = (n: number, place: { name: string; kind: string } | null): string =>
  place ? RESTORE_PLAIN.where(null, n, place) : RESTORE_PLAIN.done(null, n);

export const RESTORE_PLAIN = derived(() => ({
  href: restoredHref,
  done: (title: string | null, n: number): string => TRASH_MESSAGES.restoreDone(title, n),
  where: (title: string | null, n: number, space: { name: string; kind: string }): string => TRASH_MESSAGES.restoreWhere(title, n, space),
  open: TRASH_MESSAGES.open,
  undo: TRASH_MESSAGES.undo,
  undone: TRASH_MESSAGES.recordReturnedToTrash,
  visible: TRASH_MESSAGES.itCanBeFoundIn,
  closed: TRASH_MESSAGES.itWasRestoredAsClosed,
  closedNda: TRASH_MESSAGES.itWasRestoredHiddenFrom,
  closedOrganizer: TRASH_MESSAGES.itWasRestoredHiddenFrom2,
} as const));

export function meetingDeleteConfirm(o: { summary: boolean; decisions: number; participants: readonly string[] | null; space?: { name: string | null } | null }): ConfirmSpec {
  return {
    question: TRASH_MESSAGES.deleteThisMeeting,
    change: TRASH_MESSAGES.meetingChange(o.summary, o.decisions),
    who: TRASH_MESSAGES.meetingWho(o.participants, o.space ?? null),
    undo: TRASH_MESSAGES.youCanRestoreItFrom,
    verb: TRASH_MESSAGES.deleteMeeting,
    danger: true,
  };
}

export { TRASH_MESSAGES } from "../messages/trash";

export { TRASH_TEXT } from "../messages/trash";
