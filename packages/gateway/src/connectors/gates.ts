// Class and space gates of connector delivery. The data class of a connector is a
// gate, not a transformation: `closed` (the default) delivers only where the record comes out closed — the run-as
// person's personal space (a script caller writes closed there), a closed-class space, and meetings (always closed, in
// the owner's personal space); `space` follows the target space and lets the normal open-content check run. A target
// that is archived, gone, somebody else's personal space or a space the person can no longer write → `space_denied`.
// The organisation-wide space is not a connector target in this release (`space_unsupported`): its curator rules were
// not analysed for connectors.
import type { DataClass } from "@memory/shared";
import { canWrite, readableSpaces, resolveSpace, type SpaceAccess } from "../access.ts";
import type { App, Caller } from "../context.ts";
import type { ConnectorRow } from "./caller.ts";

export type GateReason = "space_denied" | "space_unsupported" | "class_gate";
export type Gate = { ok: true; space: SpaceAccess; ref: string; cls: DataClass } | { ok: false; reason: GateReason };

/**
 * Where an item of this connector lands and with which class: `ref` is the space argument of upload() and remember()
 * (`me` for the personal space). Meetings always go to the owner's personal space, closed.
 */
export async function deliveryTarget(app: App, caller: Caller, c: Pick<ConnectorRow, "target_space_id" | "data_class">, itemType: string): Promise<Gate> {
  const spaces = await readableSpaces(app, caller, { archived: true });
  const personal = itemType === "meeting" || c.target_space_id === null;
  const space = personal ? await resolveSpace(app, caller, "me", spaces) : spaces.get(c.target_space_id!) ?? null;
  if (!space || space.archived_at) return { ok: false, reason: "space_denied" };
  if (space.kind === "personal") {
    // Notes and documents select the personal space only through a null target, covered by runAs's creator rule.
    if (!personal || space.owner_id !== caller.person?.id) return { ok: false, reason: "space_denied" };
  } else {
    if (space.kind === "org") return { ok: false, reason: "space_unsupported" };
    if (!canWrite(space)) return { ok: false, reason: "space_denied" };
  }
  const ref = space.kind === "personal" ? "me" : space.slug;
  const cls: DataClass = itemType === "meeting" ? "closed" : space.default_class;
  if (c.data_class === "closed" && cls !== "closed") return { ok: false, reason: "class_gate" };
  return { ok: true, space, ref, cls };
}
