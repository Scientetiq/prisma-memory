// Changes at the source: what a changed item becomes.
// - meeting: a new version of the same meeting — acceptMeeting() does it by the meeting id (existing behaviour);
// - note: a new note (notes have no versions); the item points to the newest record, the earlier note stays;
// - document, by the connector's `policy.on_change`:
//   · `version` (default): a new version of the record this item made, through document versions — upload()
//     with `replaces` (doc-versions.ts). While this build has no document versions the item is held as
//     `versions_unavailable`: never a second record under the default policy;
//   · `new_record`: an independent new record; the earlier one stays.
// A version is added only to a record the connector made itself and that is still where the connector writes: a record
// that existed before the item (`adopted` — a person's own upload) is never versioned by the source, the changed file
// becomes a record of its own; a record moved to another space waits (`record_moved`); a record of another class than the
// connector's gate allows waits (`class_gate`); a record that is gone (deleted, purged) is replaced by a new one.
//
// The probe for document versions is the presence of the module next to the write functions (no import of it: a
// connector must not reach a module that also reads records; an import test checks it). The record the item made is
// the version the connector replaces; if somebody added a newer version meanwhile, the upload answers `not_current` with the
// current one and the delivery replaces that one instead.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MemoryError, type DataClass } from "@memory/shared";
import { locate } from "../access.ts";
import type { App } from "../context.ts";
import type { ConnectorRow } from "./caller.ts";
import type { Gate } from "./gates.ts";

export type OnChange = "version" | "new_record";

/** The connector's policy for a changed document (anything else than `new_record` is the default `version`). */
export const onChangeOf = (c: Pick<ConnectorRow, "policy">): OnChange => (c.policy?.on_change === "new_record" ? "new_record" : "version");

let versionsProbe: boolean | null = null;
let versionsOverride: boolean | null = null;

/** Whether this build has document versions (upload() takes `replaces`). */
export function documentVersionsAvailable(): boolean {
  if (versionsOverride !== null) return versionsOverride;
  versionsProbe ??= existsSync(fileURLToPath(new URL("../doc-versions.ts", import.meta.url)));
  return versionsProbe;
}

/** Tests only: pretend the build has (true) or lacks (false) document versions; null — probe again. */
export const documentVersionsForTests = {
  set(v: boolean | null): void { versionsOverride = v; versionsProbe = null; },
};

/** What to do with a document item. */
export type DocumentPlan =
  | { kind: "upload" }                                     // the first delivery, a new record on change, or the earlier record is gone
  | { kind: "version"; replaces: string; cls: DataClass }  // a new version of the record the item made
  | { kind: "held"; reason: "versions_unavailable" | "record_moved" | "class_gate" | "version_denied" };

/** The plan of a document item: `recordId`/`adopted` — what the item already became (null — nothing yet). */
export async function documentPlan(app: App, c: Pick<ConnectorRow, "policy" | "data_class" | "owner_id">, it: { record_id: string | null; adopted: boolean },
                                   gate: Extract<Gate, { ok: true }>): Promise<DocumentPlan> {
  if (!it.record_id) return { kind: "upload" };
  const loc = await locate(app, it.record_id);
  // deleted, purged or never there: nothing to version — the changed file becomes a record again
  if (!loc || loc.deleted) return { kind: "upload" };
  if (onChangeOf(c) === "new_record") return { kind: "upload" };
  // a record the person had before the connector: the source never adds versions to it
  if (it.adopted) return { kind: "upload" };
  if (loc.space_id !== gate.space.id) return { kind: "held", reason: "record_moved" };
  // a version keeps the class of its head: a closed connector never adds a version to a record that became open
  if (c.data_class === "closed" && loc.class !== "closed") return { kind: "held", reason: "class_gate" };
  if (!documentVersionsAvailable()) return { kind: "held", reason: "versions_unavailable" };
  if (loc.owner_id !== c.owner_id) return { kind: "held", reason: "version_denied" };
  return { kind: "version", replaces: it.record_id, cls: loc.class };
}

/** How a refusal of the version path is handled: another head to replace, a plain upload, or a held item. */
export type VersionRefusal = { kind: "replace"; id: string } | { kind: "upload" } | { kind: "held"; reason: "version_denied" } | null;

/** Refusals of `replaces` that the delivery handles itself (null — an ordinary error of the write). */
export function versionRefusal(e: unknown): VersionRefusal {
  if (!(e instanceof MemoryError)) return null;
  const details = (e.extra.details ?? {}) as Record<string, unknown>;
  const reason = String(e.extra.reason ?? details.reason ?? "");
  if (e.code === "invalid_argument" && reason === "not_current" && typeof details.current_id === "string") return { kind: "replace", id: details.current_id };
  // the head cannot take versions (not a document of a versioned kind, its conversion failed): the file is a new document
  if (e.code === "invalid_argument" && (reason === "not_versionable" || reason === "head_not_converted")) return { kind: "upload" };
  if (e.code === "forbidden" && reason === "version_denied") return { kind: "held", reason: "version_denied" };
  return null;
}
