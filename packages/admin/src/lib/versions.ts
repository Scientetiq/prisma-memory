// Document versions in the workspace. Pure helpers: which versions the
// "Versions" block lists, whether the page offers "Upload new version", the pending state of a converted version, the
// badge of "My records" and the delete warning. Data comes from the gateway (lib/versions-api.ts); texts —
// versions.messages.ts.
import type { StatusResult, VersionItem } from "./types";
import { VERSIONS_TEXT } from "./versions.messages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A record id as the upload form sends it in `replaces`. */
export const isRecordId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Versions that are in the chain (a converted version still waiting, or refused by the worker, is not yet / never in it). */
export const chainVersions = (items: readonly VersionItem[]): VersionItem[] => items.filter((x) => !x.pending);

/**
 * The block is shown only for a document with a history: more than one version, or a new version waiting next to the
 * current one. A record without a chain lists only itself — no block.
 */
export const versionsShown = (items: readonly VersionItem[]): boolean => items.length > 1;

/** The current version of the chain (the head); null when the caller reads none. */
export const currentVersion = (items: readonly VersionItem[]): VersionItem | null => items.find((x) => x.is_current && !x.pending) ?? null;

/** The pending state of the viewed record itself, when it is a converted new version. */
export const ownPending = (items: readonly VersionItem[] | null, id: string): VersionItem["pending"] | null =>
  items?.find((x) => x.id === id)?.pending ?? null;

/** How many earlier versions a delete of the document takes with it to the trash (the chain minus the head). */
export const previousVersions = (items: readonly VersionItem[] | null): number => Math.max(0, chainVersions(items ?? []).length - 1);

/** Delete confirmation: the plain one without earlier versions, otherwise "with N previous versions". */
export const deleteConfirmWithVersions = (plain: string, items: readonly VersionItem[] | null): string => {
  const n = previousVersions(items);
  return n > 0 ? VERSIONS_TEXT.deleteConfirm(n) : plain;
};

/** Size of an original: bytes → "12 KB" / "3.4 MB"; unknown → the word for it. */
export function sizeText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return VERSIONS_TEXT.unknownSize;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the "Upload new version" form needs to know about the page. */
export interface VersionUploadGate {
  type: string; parentId: string | null; sourceKind?: string | null; isCurrent?: boolean;
  /** The author of the document, or an owner of the space (the gateway decides the rest: org, personal, keys). */
  mayAct: boolean; preview: boolean; archived: boolean; moving: boolean; pending: boolean;
}

/**
 * "Upload new version" is offered on the current version of an uploaded root document (source `upload` or `folder`),
 * to its author or a space owner, outside preview, outside an archived space, while no class move is in flight and the
 * page is not itself a new version waiting for the worker. The gateway checks all of it again (doc-versions.ts).
 */
export const canUploadVersion = (g: VersionUploadGate): boolean =>
  g.type === "document" && g.parentId === null && (g.sourceKind === undefined || g.sourceKind === null || g.sourceKind === "upload" || g.sourceKind === "folder")
  && g.isCurrent !== false && g.mayAct && !g.preview && !g.archived && !g.moving && !g.pending;

/**
 * The badge of a row in "My records" from the status batch (asked with `with=version`): earlier versions, or a new version
 * waiting / refused. Only a document: a corrected note or a re-sent meeting has no "Versions" block on its page.
 */
export function versionBadge(s: Pick<StatusResult, "type" | "version" | "version_pending"> | null | undefined): { text: string; title?: string; tone: "neutral" | "info" | "warn" } | null {
  if (!s || s.type !== "document") return null;
  if (s.version_pending === "processing") return { text: VERSIONS_TEXT.badgePending, tone: "info" };
  if (s.version_pending === "failed") return { text: VERSIONS_TEXT.badgeRefused, tone: "warn" };
  if (typeof s.version === "number" && s.version > 1) return { text: VERSIONS_TEXT.badge(s.version), title: VERSIONS_TEXT.badgeTitle, tone: "neutral" };
  return null;
}

/** The answer of /api/upload to "Upload new version", as the form reads it. */
export interface VersionUploadAnswer { ok?: boolean; id?: string; version?: number; version_pending?: boolean; already_known?: boolean; message?: string; hint?: string | null; current_id?: string | null }
export type VersionUploadOutcome = { tone: "ok" | "info" | "danger"; text: string; hint?: string | null; currentId?: string | null };

/**
 * What the form says after an answer and where the page goes: `nav` is the page of the new current version, "refresh"
 * (the page stays: a converted version is being processed) or null. The same file again while a new version is still
 * being processed is not "already the current version": the previous version is current until processing ends.
 */
export function uploadOutcome(answer: VersionUploadAnswer | null, replaces: string): { outcome: VersionUploadOutcome; nav: string | null } {
  const T = VERSIONS_TEXT.upload;
  if (!answer) return { outcome: { tone: "danger", text: T.network }, nav: null };
  if (!answer.ok) return { outcome: { tone: "danger", text: answer.message || T.failed, hint: answer.hint ?? null, currentId: answer.current_id ?? null }, nav: null };
  const n = typeof answer.version === "number" ? answer.version : 2;
  if (answer.already_known && answer.version_pending) return { outcome: { tone: "info", text: T.samePending(n) }, nav: "refresh" };
  if (answer.already_known) return { outcome: { tone: "info", text: T.same }, nav: null };
  if (answer.version_pending) return { outcome: { tone: "info", text: T.acceptedPending(n) }, nav: "refresh" };
  return { outcome: { tone: "ok", text: T.accepted(n) }, nav: answer.id && answer.id !== replaces ? `/records/${answer.id}` : "refresh" };
}
