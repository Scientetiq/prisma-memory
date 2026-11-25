import { archivedDenied, classDenied, inProgress, invalid, log, MemoryError, notFound, recordPath, type DataClass } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { canWrite, loadReadable, readableSpaces, resolveSpace, type SpaceAccess } from "./access.ts";
import { audit, auditRead } from "./audit.ts";
import { derivedRepeatKey, lockAlso, sameRecordKey, underControlLock, withKeyLock } from "./control-lock.ts";
import { correctionRole, currentOf, mergeEventFields, targetOf, type CorrectionRole, type Target } from "./corrections.ts";
import { chainEnds, derivationVerdict, linkActorOf, linkDerived, loadSources, markWidened, widenedMark } from "./derivation.ts";
import { isUuidParam } from "./paging.ts";
import { admitRecord, checkText, createRecord, sourceHash, type NewRecord } from "./records.ts";
import { requireHuman } from "./workplace.ts";

export type HandoverReason = "not_meeting_decision" | "not_participant" | "not_current" | "no_projects";

export interface HandoverFormView {
  allowed: boolean;
  reason: HandoverReason | null;
  current_id: string | null;
  source: { id: string; title: string | null; event_kind: string | null; occurred_at: string; statement: string | null; due: string | null } | null;
  targets: Array<{ slug: string; name: string; class: DataClass }>;
  preview: { slug: string; class: DataClass; wider: boolean; already: Array<{ id: string; at: string }> } | null;
  done: Array<{ id: string; space: string; space_name: string; at: string }>;
}

export interface HandoverResult { id: string; path: string; space: string; class: DataClass; already_known: boolean; widened_by_human: boolean; linked: number }

const MAY_HAND_OVER: ReadonlySet<CorrectionRole> = new Set(["author", "space_owner", "participant"]);

export const HANDOVER_PLAIN_FORBIDDEN = "A meeting participant, its organizer or the owner of the meeting space can send the decision. Ask a meeting participant to send it";

const BODY_FIELDS = ["to_space", "title", "text", "confirm"] as const;

export function handoverReason(f: { type: string; parentType: string | null; isCurrent: boolean; role: CorrectionRole }): Exclude<HandoverReason, "no_projects"> | null {
  if (f.type !== "event" || f.parentType !== "transcript") return "not_meeting_decision";
  if (!f.isCurrent) return "not_current";
  if (!MAY_HAND_OVER.has(f.role)) return "not_participant";
  return null;
}

export function handoverDenial(reason: Exclude<HandoverReason, "no_projects">, currentId: string | null = null): MemoryError {
  if (reason === "not_participant") return new MemoryError("forbidden", HANDOVER_PLAIN_FORBIDDEN, { details: { reason } });
  if (reason === "not_current")
    return invalid("This is an earlier version of the decision. Send the current version", { reason, ...(currentId ? { current_id: currentId } : {}) });
  return invalid("Only meeting decisions, which are events extracted from the transcript, can be handed over to a project. Summaries, transcripts and notes cannot be handed over", { reason });
}

export function handoverTarget(space: SpaceAccess | null | undefined): SpaceAccess {
  if (!space) throw notFound();
  if (space.kind !== "project")
    throw invalid("Meeting decisions can only be handed over to a project. You cannot hand them over to a team space, “Company knowledge” or a personal space", { reason: "target_kind" });
  if (space.archived_at) throw archivedDenied(space.slug, space.archived_at);
  if (!canWrite(space)) throw classDenied("You have read-only access to this project and cannot send a decision there");
  return space;
}

export function parseHandoverBody(raw: unknown): { to_space: string; title: string; text: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("The request body must be an object with {to_space, title, text, confirm}", { reason: "text" });
  const b = raw as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !(BODY_FIELDS as readonly string[]).includes(k));
  if (extra.length) throw invalid(`Unexpected fields: ${extra.join(", ")}. Allowed fields: ${BODY_FIELDS.join(", ")}`, { reason: "text", unknown: extra });
  const to = typeof b.to_space === "string" ? b.to_space.trim() : "";
  if (!to || to.length > 100) throw invalid("Choose the project to send the decision to", { reason: "target_kind" });
  if (b.confirm !== true) throw invalid("Confirm that you read the decision and agree that project members can see it", { reason: "confirm_required" });
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title || [...title].length > 200) throw invalid("Title must be between 1 and 200 characters", { reason: "text" });
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) throw invalid("Write the text for the project", { reason: "text" });
  return { to_space: to, title, text };
}

export async function handoverSpaces(app: App, caller: Caller): Promise<Map<string, SpaceAccess>> {
  return readableSpaces(app, caller, { archived: true });
}

export const projectTargets = (spaces: Map<string, SpaceAccess>): SpaceAccess[] =>
  [...spaces.values()].filter((s) => s.kind === "project" && !s.archived_at && canWrite(s)).sort((a, b) => a.name.localeCompare(b.name, "ru") || a.slug.localeCompare(b.slug));

export const HANDOVER_TARGETS_MAX = 200;

export const formTargets = (sorted: readonly SpaceAccess[], selected?: SpaceAccess): HandoverFormView["targets"] => {
  const head = sorted.slice(0, HANDOVER_TARGETS_MAX);
  if (selected && !head.some((s) => s.id === selected.id)) {
    if (head.length < HANDOVER_TARGETS_MAX) head.push(selected); else head[HANDOVER_TARGETS_MAX - 1] = selected;
  }
  return head.map((s) => ({ slug: s.slug, name: s.name, class: s.default_class }));
};

interface Decision { t: Target; role: CorrectionRole; reason: Exclude<HandoverReason, "no_projects"> | null; currentId: string | null }

async function decisionOf(app: App, caller: Caller, id: string, spaces: Map<string, SpaceAccess>): Promise<Decision> {
  if (!isUuidParam(id)) throw notFound();
  const t = await targetOf(app, caller, id, spaces);
  const role = correctionRole({ me: caller.person!.id, ownerId: t.rec.owner_id, spaceRole: t.space.role, participant: t.participant });
  const reason = handoverReason({ type: t.rec.type, parentType: t.parentType, isCurrent: t.rec.is_current !== false, role });
  let currentId: string | null = null;
  if (reason === "not_current") {
    const cur = await currentOf(app, caller, t, new Set());
    currentId = cur.state === "visible" && cur.current ? cur.current.id : null;
  }
  return { t, role, reason, currentId };
}

async function doneOf(app: App, caller: Caller, id: string, spaces: Map<string, SpaceAccess>): Promise<HandoverFormView["done"]> {
  const rows = (await app.db.control.query(
    `SELECT l.src_id FROM record_links l JOIN record_locations loc ON loc.record_id = l.src_id AND NOT loc.deleted AND loc.type = 'event'
     WHERE l.dst_id = $1 AND l.relation = 'derived_from' AND l.status = 'confirmed' ORDER BY l.created_at DESC LIMIT 200`, [id])).rows as Array<{ src_id: string }>;
  const out: HandoverFormView["done"] = [];
  for (const { src_id } of rows) {
    if (out.length >= 50) break;
    try {
      const { rec } = await loadReadable(app, caller, src_id, spaces);
      const sp = spaces.get(rec.space_id);
      if (sp?.kind === "project") out.push({ id: rec.id, space: sp.slug, space_name: sp.name, at: new Date(rec.ingested_at).toISOString() });
    } catch { }
  }
  return out;
}

export async function handoverForm(app: App, caller: Caller, id: string, to?: string | null): Promise<HandoverFormView> {
  await requireHuman(app, caller, "Hand over a meeting decision to a project", { path: `/records/${id}`, section: "Record" });
  const spaces = await handoverSpaces(app, caller);
  const d = await decisionOf(app, caller, id, spaces);
  const none: HandoverFormView = { allowed: false, reason: null, current_id: null, source: null, targets: [], preview: null, done: [] };
  if (d.reason) return { ...none, reason: d.reason, current_id: d.reason === "not_current" ? d.currentId : null };
  const targets = projectTargets(spaces);
  if (!targets.length) return { ...none, reason: "no_projects" };
  const done = await doneOf(app, caller, id, spaces);
  const target = to ? targets.find((s) => s.slug === to) : undefined;
  let preview: HandoverFormView["preview"] = null;
  if (target) {
    const sources = await loadSources(app, caller, [id], { spaces });
    const v = await derivationVerdict(app, caller, { space: target, cls: target.default_class, sources });
    preview = { slug: target.slug, class: target.default_class, wider: v.reason !== null, already: done.filter((x) => x.space === target.slug).map(({ id: x, at }) => ({ id: x, at })) };
  }
  const f = mergeEventFields({ ...d.t.rec, text: d.t.text }, null, null, null);
  await auditRead(app, caller, { event_type: "read", class: d.t.rec.class, record_ids: [id], details: { op: "handover_form" } });
  return {
    allowed: true, reason: null, current_id: null,
    source: { id, title: d.t.rec.title, event_kind: d.t.rec.event_kind, occurred_at: new Date(d.t.rec.occurred_at).toISOString(), statement: f.statement || null, due: f.due },
    targets: formTargets(targets, target), preview, done,
  };
}

export async function handover(app: App, caller: Caller, id: string, raw: unknown): Promise<{ status: 200 | 201; body: HandoverResult }> {
  await requireHuman(app, caller, "Hand over a meeting decision to a project", { path: `/records/${id}`, section: "Record" });
  const b = parseHandoverBody(raw);
  checkText(app, b.text);
  const spaces = await handoverSpaces(app, caller);
  const d = await decisionOf(app, caller, id, spaces);
  if (d.reason) throw handoverDenial(d.reason, d.currentId);
  const target = handoverTarget(await resolveSpace(app, caller, b.to_space, spaces));
  const me = caller.person!.id, kind = d.t.rec.event_kind ?? "decision";
  const hash = sourceHash(Buffer.from(b.text, "utf8"), { title: b.title, kind, type: "event" });
  const auditClass: DataClass = d.t.rec.class === "closed" || target.default_class === "closed" ? "closed" : "open";
  const common = { op: "handover", from_space: d.t.rec.space_id, ...(d.t.rec.owner_id !== me ? { author: d.t.rec.owner_id } : {}), by_role: d.role };
  return withKeyLock(sameRecordKey(me, target.id, "event", hash), () => underControlLock(app, `handover:${me}:${target.id}:${hash.toString("hex")}`, async (q) => {
    const known = (await app.db.control.query(
      "SELECT record_id, class FROM record_locations WHERE owner_id = $1 AND source_hash = $2 AND space_id = $3 AND type = 'event' AND NOT deleted ORDER BY created_at LIMIT 1",
      [me, hash, target.id])).rows[0] as { record_id: string; class: DataClass } | undefined;
    if (known) {
      const db = app.db.recordsForWrite(known.class, caller.scope);
      const rec = (await db.query("SELECT id, occurred_at, attrs FROM records WHERE id = $1 AND deleted_at IS NULL", [known.record_id])).rows[0];
      if (rec) {
        const sources = await loadSources(app, caller, [id], { spaces });
        const v = await derivationVerdict(app, caller, { space: target, cls: known.class, sources });
        await lockAlso(q, derivedRepeatKey((await chainEnds(app.db.recordsForWrite(known.class, "system"), rec.id)).root));
        const links = await linkDerived(app, rec.id, known.class, [id], linkActorOf(caller));
        const head = links.head === rec.id ? rec
          : (await db.query("SELECT id, occurred_at, attrs FROM records WHERE id = $1 AND deleted_at IS NULL", [links.head])).rows[0];
        if (!head) throw inProgress();
        let widened = !!head.attrs?.widened_by_human;
        if (v.reason && !widened) {
          if (!(await markWidened(db, head.id, widenedMark(me, "handover")))) throw inProgress();
          widened = true;
        }
        await audit(app, caller, { event_type: "write", class: auditClass, record_ids: [head.id, id], space_id: target.id,
                                   details: { type: "event", source_kind: "agent", ...common, derived: { kind: "retelling", declared: 1, classes: v.classes },
                                              widened_by_human: widened, already_known: true, ...(caller.transport ? { via: caller.transport } : {}) } });
        return { status: 200 as const, body: { id: head.id, path: recordPath(target.slug, "event", head.occurred_at, head.id), space: target.slug, class: known.class,
                                               already_known: true, widened_by_human: widened, linked: links.created } };
      }
    }
    const n: NewRecord = {
      type: "event", eventKind: kind, space: target, title: b.title, text: b.text, sourceHash: hash,
      method: "stated_by_human", origin: "human", confirmed: true, sourceKind: "agent", occurredAt: new Date(d.t.rec.occurred_at),
      entities: { known: [], unresolved: [] }, ownerId: me,
      derivation: { ids: [id], kind: "retelling", via: "handover", allow: "human" }, auditClass, auditExtraIds: [id],
    };
    const adm = await admitRecord(app, caller, n);
    n.auditDetails = { ...common, widened_by_human: !!adm.derived?.widened };
    const created = await createRecord(app, caller, n, adm);
    let links: { created: number };
    try {
      await lockAlso(q, derivedRepeatKey(created.id));
      links = await linkDerived(app, created.id, created.class, [id], linkActorOf(caller));
    } catch (e) {
      if (e instanceof MemoryError && e.code === "in_progress") throw e;
      log.warn("handover_links_deferred", { record_id: created.id, error: String((e as Error)?.message ?? e).slice(0, 120) });
      throw inProgress();
    }
    return { status: 201 as const, body: { id: created.id, path: created.path, space: created.space, class: created.class, already_known: false,
                                           widened_by_human: !!adm.derived?.widened, linked: links.created } };
  }));
}
