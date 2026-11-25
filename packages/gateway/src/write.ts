import { connectionExpiryWarning } from "./oauth.ts";
// Writing: memory_remember, memory_upload, memory_process_now and memory_me.
// A write without a space goes into the personal one, never into a shared one.
import { acceptedFormatsList, archivedDenied, binder, classDenied, CLOUD_AGENT_BASE_SETTING, CONVERTER_FAST_PROFILE, CONVERTER_OFFICE_TEST_HOOK, converterConfigured as converterConfiguredBySettings, converterFormatsNeedCaps, converterMissing, convertibleFormats, convertibleMime, decodeVariants, legacyScanCharsetsOf, legacyCharsetOf,
         declaredTextLooksLikeDocument, CHAIN_HEAD, isShowcaseLogin, isTestDomainLogin, readConverterGate, recordText, sniffDocument, sniffRefusalText, textCharset, type ConverterCaps, type ConverterFormat, type UploadFormat, inProgress, invalid, jsonTextVariants, log, MemoryError, notFound, openCheckAdvice, openCheckSentence, openCheckWhy, visibleSql,
         newId, parseOpenCheckFallback, publicBaseUrl, tooLarge, recordPath, checkDerivation, instanceTz, showAnywayPath, showAnywayWhere, type DataClass, type Derivation, type DerivedKind, type OpenCheckFallback,
         type OpenCheckView } from "@memory/shared";
import type { App, Caller, PersonRow } from "./context.ts";
import { archivedWithRecords, canWrite, locate, readableSpaces, resolveSpace, serviceWriteSpace, spaceArchived, type SpaceAccess, type SpaceKind } from "./access.ts";
import { classAllowed, hiddenClosedSql, listingSpec, recordVisible } from "./visibility.ts";
import { heldIds, orgSpace } from "./org-hold.ts";
import { admitRecord, checkDomains, checkEntityList, checkText, createRecord, keepClosedHere, markViewFor, originalKey, parseWhen, queueOf, resolveEntities, SERVICE_SPACE_ONLY, sourceHash, stagesOf,
         uploadHashes, type NewRecord } from "./records.ts";
import { audit, recentActions } from "./audit.ts";
import { workplaceUrl, workplaceWhere } from "./workplace.ts";
import { personKeyWarning } from "./key-expiry.ts";
import { guardOpen, moveUnchecked, openCheckOutcome, refuseOpen, treeTexts } from "./open-check.ts";
import { openByWordCaller } from "./owner.ts";
import { shortDescription } from "./spaces.ts";
import { extendedOpenGate, JOURNAL_TAIL, MARKED_TAIL, markEvent, openWriteLine, openWriteMode, type ExtendedMark, type OpenWriteMode } from "./extended-open.ts";
import { chainEnds, derivationGate, linkActorOf, linkDerived, LINKS_PARTIAL_NOTE, loadSources } from "./derivation.ts";
import { derivedRepeatKey, sameFileKey, sameRecordKey, underControlLock, withKeyLock } from "./control-lock.ts";
import { meProfile, rememberProfile } from "./profile.ts";
import { meGuidePaths } from "./space-guide.ts";
import { isExternal } from "./channel.ts";
import { meText, type McpTexts, type MeFirstMinute, type MeView } from "@memory/mcp-core";
import { meFirstMinuteView, recentNotes, recentNotesView } from "./me-first-minute.ts";
import { textsOf } from "./mcp-texts.ts";
import { checkDiskForUpload, withUploadDaily } from "./limits.ts";
import { documentEstimate, intakeLane, type IntakeLane } from "./intake-lane.ts";
import { humanOpenDefault } from "./upload-default.ts";
import { uploadDefaultText } from "./upload-default.messages.ts";
import { chainFacts, markVersionRetried, olderVersionHit, olderVersionNote, sameBytes, uploadVersion } from "./doc-versions.ts";
import { docVersionText } from "./doc-versions.messages.ts";
import { originalPut } from "./original-storage.ts";
import { originalNote, originalRefusal } from "./original-storage.messages.ts";

const TEXT_MIME = new Set(["text/markdown", "text/plain", "text/x-markdown"]);

/**
 * A repeat of an own record closed by the check: outside own personal (view `foreign`) — no reasons or positions, only that it
 * is hidden and who can show it; otherwise — the reason, as before.
 */
const repeatMarkTail = (view: OpenCheckView | null, mark: OpenCheckFallback | null, closedWord: string): string =>
  !mark || !view ? "" : !view.kinds ? " · hidden from agents; only the author can show it to agents, in the workspace" : ` · ${closedWord} by the open check: ${openCheckWhy(mark)}`;

/** A closed-class record the key itself does not read (personal T2): where the person goes to open it for agents. */
function closedHint(app: App, caller: Caller, cls: string, id: string): string {
  if (cls !== "closed" || caller.scope.classes.includes("closed")) return "";
  return ` · this key cannot read the record. Only a person can show it to agents in the workspace: ${workplaceWhere(app, `/records/${id}`, "Record")}`;
}

/** Personal mode for an agent's write: open — the notebook (open), off — the person turned it off, script — a script key. */
export type PersonalMode = "open" | "off" | "script";
/** Why the personal space is so (memory_me `key.personal_class_reason`). */
export type PersonalReason = "notebook" | "notebook_off" | "script" | "reads_closed" | "service";

/**
 * Personal mode by the key alone, without a space (memory_me). The personal notebook
 * applies only to the key of a person who does not see the closed class (personal key T2; further on — a connection through
 * the browser): a session and an extended key read closed themselves, services (T0, T1) are not a person, null for them. Next —
 * the key program: a script or local program key writes past the model, the argument
 * "the agent has already seen it" does not fit it — `script` comes before the switch. Last — the person's notebook switch.
 */
export function personalModeForKey(caller: Caller): PersonalMode | null {
  if (caller.principalType !== "person" || !caller.person || caller.scope.classes.includes("closed")) return null;
  if (caller.clientKind === "script") return "script";
  return caller.person.notebook === false ? "off" : "open";
}

/**
 * A cloud agent: it gets the `access.cloud_agent_base_url` address. Exactly those whose personal mode
 * personalModeForKey is `open` or `off`, and not the panel preview: a personal T2 key of the program claude_code, codex, cursor,
 * cloud_other or without a program (old keys are cloud ones) and an OAuth connection. Not cloud: a script key, an agent with
 * extended access (any program), a workplace session, services T0 and T1, including "on behalf of" a person.
 */
export const cloudAgentCaller = (caller: Caller): boolean => {
  const mode = personalModeForKey(caller);
  return (mode === "open" || mode === "off") && !caller.preview;
};

/** The `access.cloud_agent_base_url` setting value without edge spaces; not set — null (memory_me.cloud_agent_base_url). */
export function cloudAgentBaseUrl(app: App): string | null {
  return app.settings.str(CLOUD_AGENT_BASE_SETTING)?.trim() || null;
}

/**
 * The memory address for this caller — one function for the "Skill archive" line, the install-skill prompt and
 * memory_me.public_base_url: to a cloud agent (cloudAgentCaller) — `access.cloud_agent_base_url`, to everyone else and with
 * an empty setting — `access.public_base_url`, as before. It lives here, next to personalModeForKey, not in workplace.ts:
 * workplace.ts is imported by auth.ts and a score of modules, and write.ts itself imports workplace.ts — no import cycle.
 */
export function agentBaseUrl(app: App, caller: Caller): string | null {
  const cloud = cloudAgentCaller(caller) ? cloudAgentBaseUrl(app) : null;
  // access.public_base_url empty — the origin of MEMORY_PUBLIC_URL
  return cloud ?? (app.settings.str("access.public_base_url") || publicBaseUrl());
}

/**
 * Personal mode for a write into a space. A note of a key from personalModeForKey into its own personal space of the closed
 * class lands open (`open`): otherwise the agent reads it neither now nor in the next session. Only the owner sees it —
 * nobody else reads the personal space; after the person leaves, the custodian reads it — the manager, in the work
 * place and without agents (custody.ts routes are outside the visibility core). The order of checks matters: first the key and
 * the space, then the program — a script key's write into a project or team is described as an ordinary one, not "closed:
 * script". null — does not apply to the write: another's personal, a team, a project, org, a personal space of the open class.
 */
export function personalMode(caller: Caller, space: Pick<SpaceAccess, "kind" | "owner_id" | "default_class">): PersonalMode | null {
  const mode = personalModeForKey(caller);
  if (mode === null || space.kind !== "personal" || space.owner_id !== caller.person!.id || space.default_class !== "closed") return null;
  return mode;
}

/**
 * Open write places for the instructions. Rights come from the common readableSpaces, the personal class — from the same
 * personalMode as the write. To an agent that reads closed (an extended key) without the administrator's permission —
 * nothing: it does not write into open; with permission (marked) — the open spaces it may write into, without the personal one:
 * such a key's personal space is closed. A service has only its assigned space, never the person's list from
 * X-On-Behalf-Of.
 */
export async function openWriteTargets(app: App, caller: Caller): Promise<Array<{ slug: string; kind: SpaceKind }>> {
  const openMode = openWriteMode(caller);
  if (caller.principalType === "system" || openMode === "denied") return [];
  if (caller.principalType === "service") {
    const fixed = await serviceWriteSpace(app, caller);
    return fixed?.default_class === "open" ? [{ slug: fixed.slug, kind: fixed.kind }] : [];
  }
  if (!caller.person?.active) return [];
  const rank: Record<SpaceKind, number> = { personal: 0, project: 1, team: 2, org: 3 };
  return [...(await readableSpaces(app, caller)).values()]
    .filter((s) => canWrite(s) && (personalMode(caller, s) === "open" || s.default_class === "open") && !(openMode === "marked" && s.kind === "personal")
      // An administrator could have given the demo persona a manual membership in a real project by mistake. The new instructions
      // channel is limited to the showcase: demo- is reserved for it; one's own personal space shows only under the alias me.
      && (!caller.person!.demo || (s.kind === "personal" && s.owner_id === caller.person!.id) || s.slug.startsWith("demo-")))
    .map((s) => ({ slug: s.kind === "personal" ? "me" : s.slug, kind: s.kind }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** Notes class in one's own personal space and the reason — for memory_me (`key.personal_class`, `key.personal_class_reason`). */
export function personalClassForKey(caller: Caller): { personal_class: DataClass; personal_class_reason: PersonalReason } {
  const mode = personalModeForKey(caller);
  if (mode === "open") return { personal_class: "open", personal_class_reason: "notebook" };
  const reason: PersonalReason = mode === "off" ? "notebook_off" : mode === "script" ? "script" : caller.principalType === "person" ? "reads_closed" : "service";
  return { personal_class: "closed", personal_class_reason: reason };
}

/** A hint to a script key: why its write into the personal space is closed. */
export const SCRIPT_HINT = "the key was issued for a script or a local program: in the personal space its records are closed (a script writes without the model)";

/**
 * The external agents' address says nothing about closed, but one can write into closed through it:
 * a decision into a team's closed space, a note of a script key or with the notebook off, a note that
 * the open check saved closed — otherwise all of this would be silently lost for every agent connected by OAuth.
 * The answer is only about the record the agent made now. An external call does not look up an existing own closed record
 * as a repeat: the same text lands as a new record, not as already_known with the earlier id — otherwise the answer would show
 * whether such a closed record exists. The check mark — without `by_word` (no memory_open outside), the advice — "remove this and
 * write it again"; a person in the workplace can show the record to agents. Inside — no change.
 */
const closedRepeatsHidden = (caller: Pick<Caller, "channel">): boolean => isExternal(caller);
/** The open-check mark in a write answer: outside one cannot open by word (no memory_open there) — by_word: false. */
const outsideView = (caller: Pick<Caller, "channel">, view: OpenCheckView | null): OpenCheckView | null =>
  view && isExternal(caller) && view.by_word ? { ...view, by_word: false } : view;

/**
 * The write space. Resolved by the map with the archive: an archived one the caller reads — refusal class_denied with
 * details.archived (no writing "next door": the agent asks the person, as the refusal hint says); another's and a missing one —
 * not_found, as before. One point for memory_remember (a repeat of the same text included), memory_upload (including
 * "the same file") and /ingest/documents — before idempotency and placement.
 * A service with a write space — refusal forbidden for any other space right here, before the search for "the same
 * file": otherwise a known document of the person was placed in another of their spaces bypassing admitRecord.
 */
async function spaceForWrite(app: App, caller: Caller, ref: string | undefined): Promise<SpaceAccess> {
  if (!caller.person) throw notFound();
  const space = await resolveSpace(app, caller, ref ?? "me", await readableSpaces(app, caller, { archived: true }));
  if (!space) throw notFound();
  if (space.archived_at) throw archivedDenied(space.slug, space.archived_at);
  serviceSpaceOnly(caller, space);
  return space;
}

/** A service with a write space writes only there; the second line — admitRecord (records.ts), with the same text. */
export function serviceSpaceOnly(caller: Pick<Caller, "service">, space: Pick<SpaceAccess, "id">): void {
  if (caller.service?.write_space_id && space.id !== caller.service.write_space_id)
    throw new MemoryError("forbidden", SERVICE_SPACE_ONLY);
}

type RememberArgs = { text: string; title?: string; space?: string; kind?: string; entities?: string[]; occurred_at?: string; origin?: "agent" | "human"; domains?: string[];
                      derived_from?: string[]; derivation?: Derivation; section?: string; mode?: string };

/**
 * The memory_remember tool: a write into the work profile (`kind: profile`) — its own path in profile.ts
 * (sections, versions, "private life", a strict open check, only one's own profile); the rest — remember.
 */
export async function rememberTool(app: App, caller: Caller, a: RememberArgs) {
  return a.kind === "profile" ? rememberProfile(app, caller, a) : remember(app, caller, a);
}

/** Text tail for explicit entities that did not link (memory_remember, memory_upload): empty when all linked. */
const unresolvedTail = (u: string[]): string => (u.length ? ` · entities not found in the registry: ${u.join(", ")}` : "");

export async function remember(app: App, caller: Caller, a: RememberArgs) {
  // section and mode — only for a profile write (rememberTool); a note and an event have none
  if (a.kind === "profile") throw invalid("To write to the work profile, use memory_remember with kind: profile", { field: "kind" });
  if (a.section !== undefined || a.mode !== undefined)
    throw invalid("section and mode are for work profile writes only (kind: profile)", { field: a.section !== undefined ? "section" : "mode" });
  checkText(app, a.text);
  const entityKeys = checkEntityList(a.entities);
  // the origin input — before the space (a kind and list conflict is an input error, not a rights one)
  const derivedIn = checkDerivation(a.derived_from, a.derivation);
  const space = await spaceForWrite(app, caller, a.space);
  const kind = a.kind ?? "note", origin = a.origin ?? "agent";
  const title = a.title?.trim() || firstLine(a.text);
  const type = kind === "note" ? "note" : "event";
  // Idempotency: the same record (text, title, kind) in the same space from the same owner —
  // is not a duplicate but `already_known` with the old id, as memory_upload. The match is sought by locator in the control DB,
  // so a personal T2 key gets it for a closed space too, without opening the closed database.
  const hash = sourceHash(Buffer.from(a.text, "utf8"), { title, kind, type });
  // the "already there" search and the write — in one queue by the record key (withKeyLock in process memory, holds no
  // connections): a parallel repeat waits for the first call, gets already_known with the same id, not a copy. The key is shared
  // with the hand-over to a project (handover.ts) — a parallel "remember" (kind=decision) and hand-over of one text queue up too
  return withKeyLock(sameRecordKey(caller.person!.id, space.id, type, hash), async () => {
  // the external agents' address does not look for its own closed one as a repeat — the answer does not tell whether it exists
  const known = (await app.db.control.query(
    "SELECT record_id, class, CASE WHEN class = 'closed' THEN open_check END AS open_check FROM record_locations WHERE owner_id = $1 AND source_hash = $2 AND space_id = $3 AND type = $4 AND NOT deleted AND (class = 'open' OR NOT $5::boolean) ORDER BY created_at LIMIT 1",
    [caller.person!.id, hash, space.id, type, closedRepeatsHidden(caller)])).rows[0];
  if (known) {
    const db = app.db.recordsForWrite(known.class, caller.scope);   // own record metadata: date and stages
    const rec = (await db.query("SELECT id, occurred_at, method, confirmed_at FROM records WHERE id = $1 AND deleted_at IS NULL", [known.record_id])).rows[0];
    if (rec) {
      // own record closed by the open check: the reason — from the locator, to the author only (the search is by owner_id anyway)
      const mark = parseOpenCheckFallback(known.open_check);
      const view = mark ? await markViewFor(app, caller, { id: rec.id, spaceId: space.id, ownerId: caller.person!.id, raw: known.open_check }) : null;
      const path = recordPath(space.slug, type, rec.occurred_at, rec.id);
      // a repeat with derived_from: the gate — against the found record, then add the links
      const again = derivedIn ? await derivedRepeat(app, caller, { id: rec.id, path, cls: known.class as DataClass, space }, derivedIn) : null;
      const result = { id: rec.id, path, type: type as "note" | "event", space: space.slug, class: known.class as DataClass,
                       origin, already_known: true, stages: await stagesOf(db, rec.id), entities_unresolved: [] as string[], ...(view ? { open_check: view } : {}),
                       ...(again ? { derivation: again.derivation, ...(again.notes.length ? { notes: again.notes } : {}) } : {}) };
      return { result, text: `This is already in memory: ${result.path}${repeatMarkTail(view, mark, "closed")}${again ? derivedText(again) : ""}` };
    }
  }
  const mode = personalMode(caller, space);
  // a person in the workspace whose default for the own personal space is open takes the same "personal open" path
  const humanOpen = mode === null && await humanOpenDefault(app, caller, space);
  // into the open class — only what passed the content check: createRecord does it after checking the right
  // to write. Personal open is checked too, but a finding there is not a refusal but a closed record with a mark
  const entities = await resolveEntities(app, entityKeys, caller);
  const draft: NewRecord = {
    type, eventKind: kind === "note" ? null : kind, space, title, text: a.text, sourceHash: hash, ...(mode === "open" || humanOpen ? { classOverride: "open" as const, personalOpen: true } : {}),
    // "said by a person" — only when the agent passes on a person's words; else an agent's record with the "from an agent" flag
    method: origin === "human" ? "stated_by_human" : "inferred_by_agent", origin, confirmed: origin === "human",
    sourceKind: "agent", occurredAt: parseWhen(a.occurred_at, instanceTz(app.settings)), domains: checkDomains(app, a.domains), entities, ownerId: caller.person!.id,
    ...(derivedIn ? { derivation: derivedIn } : {}),
  };
  const created = await createRecord(app, caller, draft);
  // note → source links after the write (no cross-database transaction; not written — notes, a repeat adds them)
  const links = derivedIn ? await firstLinks(app, caller, created, derivedIn.ids) : null;
  const derivedOut = derivedIn && links
    ? { derivation: { kind: derivedIn.kind, declared: derivedIn.ids.length, linked: links.linked }, notes: links.failed.length ? [LINKS_PARTIAL_NOTE] : [] } : null;
  const view = outsideView(caller, created.openCheck);
  const result = { id: created.id, path: created.path, type: created.type as "note" | "event", space: created.space, class: created.class, origin, already_known: false, stages: created.stages,
                   entities_unresolved: entities.unresolved, ...(view ? { open_check: view } : {}),
                   // a write by an agent with extended access by the administrator's permission: marked and in the log
                   ...(created.extended ? { extended_write: true as const } : {}),
                   ...(derivedOut ? { derivation: derivedOut.derivation, ...(derivedOut.notes.length ? { notes: derivedOut.notes } : {}) } : {}) };
  const unresolved = unresolvedTail(entities.unresolved) + (derivedOut ? derivedText(derivedOut) : "");
  // personal open: passed — open; a finding — closed with the reason. The texts do not promise to open the record:
  // "Show to agents" would refuse on the same finding
  if (mode === "open") return { result, text: `${personalOpenText(created.path, created.fallback, "note", undefined, adviceFor(caller))}${unresolved}` };
  if (humanOpen) return { result, text: `${uploadDefaultText(created.fallback ? "saved_hidden_by_check" : "saved_open", created.path)}${unresolved}` };
  // a script key: the class is not overridden — closed; the answer explains why and who opens it
  const hint = mode === "off" ? `${closedHint(app, caller, created.class, created.id)} · ${OFF_HINT}: ${workplaceWhere(app, "/keys", "Keys and agents")}`
    : mode === "script" ? ` · ${SCRIPT_HINT}${closedHint(app, caller, created.class, created.id)}`
    : closedHint(app, caller, created.class, created.id);
  return { result, text: `Saved: ${created.path} · class ${created.class}${hint}${unresolved}${created.extended ? MARKED_TAIL : ""}` };
  });
}

/**
 * The links of the first write — under the chain lock: the record is already visible by its fingerprint, and a repeat
 * of the same text with other sources at this moment waits for the lock and then reads the first write's links — the count
 * matches, whoever is first. The open check and the write (createRecord) — before the lock: the lock pool waits on no slow check.
 * The record already carries the declared |ids| and all source fingerprints in derived_pending (createRecord): under the lock
 * the inserted ones are only subtracted. Any failure here (lock wait timed out, pool, database) — the record exists already,
 * the basis is "incomplete" (the safe side); the answer is the same line as for unfinished links: a repeat of the same call
 * adds them by the repeat path.
 */
async function firstLinks(app: App, caller: Caller, rec: { id: string; class: DataClass }, ids: readonly string[]): Promise<{ linked: number; created: number; failed: number[] }> {
  try {
    return await underControlLock(app, derivedRepeatKey(rec.id), async () => linkDerived(app, rec.id, rec.class, ids, linkActorOf(caller)));
  } catch (e) {
    log.warn("derived_links_deferred", { record_id: rec.id, positions: ids.length,
                                         error: e instanceof MemoryError ? e.code : String((e as Error)?.message ?? e).slice(0, 120) });
    return { linked: 0, created: 0, failed: ids.map((_, i) => i) };
  }
}

/** The answer tail of a retelling: over how many records and what about the links. */
function derivedText(d: { derivation: { declared: number; linked: number }; notes: string[] }): string {
  const n = d.derivation.declared, word = n % 10 === 1 && n % 100 !== 11 ? "record" : "records";
  return ` · retelling based on ${n} memory ${word}${d.notes.length ? ` · ${d.notes.join(" · ")}` : ""}`;
}

/**
 * A repeat of the same record with derived_from: links are added only for one who still writes into the space; the gate —
 * against the found record (its space and class), a refusal — with details.already_known. Passed — the record's declared count
 * is raised before the links (clearing any source later means "basis incomplete"), then
 * the links. After the links the locator is reread: if the record moved meanwhile — the gate for the new place.
 * Its own id in derived_from — refusal before the gate (no self link, and the declared count would include it); raising the count
 * and inserting links — under the chain lock in the control lock pool (a parallel repeat would otherwise undercount the basis).
 */
async function derivedRepeat(app: App, caller: Caller, rec: { id: string; path: string; cls: DataClass; space: SpaceAccess }, d: { ids: string[]; kind: DerivedKind })
  : Promise<{ derivation: { kind: DerivedKind; declared: number; linked: number }; notes: string[] }> {
  const declared = d.ids.length;
  const self = d.ids.flatMap((x, i) => (x === rec.id ? [i] : []));
  if (self.length) throw invalid("derived_from: a record is not a retelling of itself. Remove its id from derived_from", { field: "derived_from", reason: "self", positions: self });
  if (!canWrite(rec.space)) return { derivation: { kind: d.kind, declared, linked: 0 }, notes: ["Links were not added because you can no longer write to this space"] };
  const sources = await loadSources(app, caller, d.ids);
  await derivationGate(app, caller, { space: rec.space, cls: rec.cls, sources, declared, already: { id: rec.id, path: rec.path } });
  // the chain lock: the key is the root of the version chain of one's own note; under the lock the record class and the current
  // version (head) are reread: a repeat that found the earlier version before memory_correct writes into
  // the current one and counts over the whole chain
  const { root } = await chainEnds(app.db.recordsForWrite(rec.cls, "system"), rec.id);
  const links = await underControlLock(app, derivedRepeatKey(root), async () => linkDerived(app, rec.id, rec.cls, d.ids, linkActorOf(caller)));
  const now = await locate(app, rec.id);
  if (now && (now.space_id !== rec.space.id || now.class !== rec.cls)) {
    const moved = (await readableSpaces(app, caller)).get(now.space_id);
    if (moved) await derivationGate(app, caller, { space: moved, cls: now.class, sources, declared, already: { id: rec.id, path: rec.path } });
  }
  return { derivation: { kind: d.kind, declared, linked: links.linked }, notes: links.failed.length ? [LINKS_PARTIAL_NOTE] : [] };
}

/** The person turned agents' writes off in the personal space: who turns them on and where. */
export const OFF_HINT = "the person has turned off agent writes to the personal space, so they are saved closed without the open check; the person turns them back on in the same place";

/**
 * The personal open answer: passed — "Saved to open" and who sees it; a finding — "Saved closed",
 * the reason (kind, field, position — without the match), what to do. A PDF before conversion — "accepted to open", text later.
 */
function personalOpenText(path: string, fallback: OpenCheckFallback | null, what: "note" | "document" | "pdf", profile?: string, advice: { tool?: boolean } = {},
                          describe: string = DESCRIBE_AT_NIGHT): string {
  if (fallback) return `Saved as closed: ${path} · ${openCheckSentence(fallback, advice)}${what === "pdf" ? ` · the document will be converted in the closed class (profile ${profile})` : ""}`;
  // an open record: the person decides whether to keep it open — an offer to close it in every answer ("If it should be
  // closed — say so"); the agent closes it on their word (memory_close, rule 7 of SKILL.md)
  if (what === "pdf") return `Document accepted as open: ${path} · it will be converted to markdown (profile ${profile}); its text is checked after that: if anything resembling personal data or a secret turns up, the document becomes closed (memory_read shows the reason). Until the check there is no link to the original. ${CLOSE_OFFER}`;
  // after the person leaves, the custodian reads the personal space — the manager, in the workplace, without agents
  const who = "visible to you and your agents (including agents of other programs); not to colleagues; if you leave the company, to your manager, in person and without agents";
  return what === "document"
    ? `Document saved as open: ${path} · ${who}; indexing has started, ${describe}. ${CLOSE_OFFER}`
    : `Saved as open: ${path} · ${who}. ${CLOSE_OFFER}`;
}

/** Advice for a record closed by the check: no memory_open outside — the "show to agents?" question is not offered. */
const adviceFor = (caller: Pick<Caller, "channel">): { tool?: boolean } => (isExternal(caller) ? { tool: false } : {});

/**
 * When the description of a new document comes: in the day lane — soon, without a hint to
 * memory_process_now (an agent that calls it lifts the document above meetings); otherwise — the earlier text, byte for byte.
 * Both clauses are Russian like the sentences around them: a later string conversion takes them with the rest.
 */
const DESCRIBE_AT_NIGHT = "the description comes in the night lane (or memory_process_now)";
const DESCRIBE_SOON = "the description comes soon after the upload";
const describeWhen = (lane: IntakeLane): string => ("process_now_at" in lane ? DESCRIBE_SOON : DESCRIBE_AT_NIGHT);

/** An offer to the person after a write into personal open. */
const CLOSE_OFFER = "If it should be closed, say so (memory_close)";

const firstLine = (text: string): string => { const l = text.trim().split("\n")[0]!.replace(/^#+\s*/, "").trim(); return l.length > 120 ? l.slice(0, 117) + "…" : l; };

export interface UploadArgs { filename: string; mime: string; bytes: Buffer; space?: string; title?: string; occurred_at?: string; entities?: string[]; domains?: string[]; sourceRef?: string;
                             /** id of the document this file is a new version of (REST now; memory_upload after the contract change). */
                             replaces?: string }

/** How long the gateway remembers the converter fast-lane sign from the switch row, ms (the worker refreshes it every 10 min). */
export const CONVERTER_CAPS_CACHE_MS = 30_000;
const capsCache = new Map<string, { at: number; caps: ConverterCaps | null }>();
/** Tests only: forget the fast-lane sign. */
export const resetConverterCapsCache = (): void => capsCache.clear();

/**
 * The converter fast-lane sign (`converter_gate.caps`; the worker writes it from `GET /api/contract`): the gateway does not
 * call the converter. Remembered 30 s per process. The control database did not answer — unknown (office is not accepted,
 * PDF — as always).
 */
async function converterCaps(app: App): Promise<ConverterCaps | null> {
  const hit = capsCache.get(app.instanceId);
  if (hit && Date.now() - hit.at < CONVERTER_CAPS_CACHE_MS) return hit.caps;
  let caps: ConverterCaps | null = null;
  try { caps = (await readConverterGate(app.db.control, app.instanceId)).gate.caps; }
  catch (e) { log.warn("converter_caps_read_failed", { error: (e as Error).message.slice(0, 120) }); }
  capsCache.set(app.instanceId, { at: Date.now(), caps });
  return caps;
}

/**
 * Which converter formats are accepted now: PDF — with a configured converter; the others from
 * `integrations.converter_formats` — only with the converter fast lane. The switch row is read only if the
 * setting holds something besides PDF.
 */
async function acceptedConverterFormats(app: App, caller?: Caller): Promise<ConverterFormat[]> {
  return (await converterFormatsFor(app, caller)).formats;
}

/** The same, and which formats are accepted only by the test hook (`viaTestHook` — into the upload log, no file name). */
async function converterFormatsFor(app: App, caller?: Caller): Promise<{ formats: ConverterFormat[]; viaTestHook: ConverterFormat[] }> {
  if (!converterConfiguredBySettings(app.settings)) return { formats: [], viaTestHook: [] };
  const testOffice = await officeTestCaller(app, caller);
  const caps = testOffice || converterFormatsNeedCaps(app.settings) ? await converterCaps(app) : null;
  const formats = convertibleFormats(app.settings, caps, { allOffice: testOffice });
  const usual = testOffice ? convertibleFormats(app.settings, caps) : formats;
  return { formats, viaTestHook: formats.filter((f) => !usual.includes(f)) };
}

/** The live office check test hook is on — off by default; when on — health degraded. */
export const officeTestHookOn = (app: Pick<App, "settings">): boolean => app.settings.get<unknown>(CONVERTER_OFFICE_TEST_HOOK, false) === true;

/**
 * Office is accepted for the caller by the test hook (CONVERTER_OFFICE_TEST_HOOK): the hook is on and this is a test person
 * themselves (a personal or extended key, a session; not a service "on behalf of", not a preview), active, attrs.test = true,
 * a login on a test domain, not a showcase persona and without an AD link, as with the other test hooks (test sessions, links).
 * A real employee does not get office this way before it is on for all. The hook is off — the database is not read.
 */
async function officeTestCaller(app: App, caller: Caller | undefined): Promise<boolean> {
  if (!caller || !officeTestHookOn(app)) return false;
  const p = caller.person;
  if (!p || caller.principalType !== "person" || caller.onBehalfOf || caller.preview || !isTestDomainLogin(p.login) || isShowcaseLogin(p.login)) return false;
  const row = (await app.db.control.query(
    `SELECT p.active, p.attrs, EXISTS (SELECT 1 FROM person_identities i WHERE i.person_id = p.id AND i.system = 'ad' AND i.active) AS ad
       FROM people p WHERE p.id = $1 AND p.instance_id = $2`, [p.id, app.instanceId])).rows[0] as { active: boolean; attrs: Record<string, unknown> | null; ad: boolean } | undefined;
  return !!row && row.active === true && row.attrs?.test === true && row.attrs?.demo !== true && row.ad !== true;
}

/**
 * What exactly a document upload accepts — one source of truth for the check in upload(), the refusal text and the
 * `upload` field in memory_me: the panel promised DOCX/XLSX/images, while markdown, text and (with a converter) PDF were taken.
 * `converter_configured` — the same sign by which upload decides whether to take a converter format:
 * address, login and password are filled (converterConfigured). There is no sign-in to the converter here and must not be:
 * a sign-in on every memory_me with a wrong password would lock the account. An open converter breaker does not close
 * intake — the document is accepted and waits. Office formats — by the setting and the fast-lane sign (acceptedConverterFormats).
 */
export async function uploadCapabilities(app: App, formats?: readonly ConverterFormat[], caller?: Caller):
  Promise<{ accepted_mime: string[]; accepted_formats: UploadFormat[]; max_bytes: number; converter_configured: boolean }> {
  const converterConfigured = converterConfiguredBySettings(app.settings);
  const now = formats ?? await acceptedConverterFormats(app, caller);
  return {
    accepted_mime: [...TEXT_MIME, ...convertibleMime(now)],
    // the exact list for the agent and the workplace (contract 0.17.0): extension and kind — from the same decision as intake
    accepted_formats: acceptedFormatsList(now),
    max_bytes: app.settings.get("limits.upload_max_bytes", 20_971_520),
    converter_configured: converterConfigured,
  };
}

/** Own locator of "the same file": record, space, class by locator and the check mark (for a closed one). */
interface OwnCandidate { record_id: string; space_id: string; class: DataClass; open_check: unknown; other: boolean; at: string }
/** Own record row for the "same file" answer: date, conversion state (dead — a check refusal after it). */
interface OwnRow { id: string; occurred_at: Date; conv: string | null; conv_error: string | null; process_now_at: string | null; process_now_by: string | null; deferred_reason: string | null; version?: number; supersedes_id?: string | null; is_current?: boolean;
                  source_hash?: Buffer | null; attrs?: unknown;
                  /** the hit was this older version of the document; the row is its current version (chain head). */
                  older?: number }
/** Own live record of "the same file": locator, the class where the row really lies, that class's database and the row. */
interface OwnLive { own: OwnCandidate; cls: DataClass; db: ReturnType<typeof ownDb>; rec: OwnRow }

/** A page of own "same file" candidates. */
const OWN_PAGE = 50;
const OWN_ROW_SQL = "SELECT id, occurred_at, attrs -> 'conversion' ->> 'status' AS conv, attrs -> 'conversion' ->> 'error_kind' AS conv_error, attrs ->> 'process_now_at' AS process_now_at, attrs ->> 'process_now_by' AS process_now_by, attrs ->> 'deferred_reason' AS deferred_reason, version, supersedes_id, is_current, source_hash,"
  + " jsonb_build_object('version_pending', attrs -> 'version_pending', 'conversion', attrs -> 'conversion') AS attrs FROM records WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL";
/** A dead record — a document the worker refused by a check after conversion: not "the same file"; and a version the worker refused. */
const deadOwn = (r: OwnRow): boolean => r.conv === "failed" && (r.conv_error === "open_check" || r.conv_error === "version_refused");
/** The class database for one's own record: a class the key reads — the ordinary context, otherwise — for writing (own record metadata). */
const ownDb = (app: App, caller: Caller, cls: DataClass) => caller.scope.classes.includes(cls) ? app.db.records(cls, caller.scope) : app.db.recordsForWrite(cls, caller.scope);
const ownRows = async (app: App, caller: Caller, cls: DataClass, ids: readonly string[]): Promise<OwnRow[]> =>
  ids.length ? (await ownDb(app, caller, cls).query(OWN_ROW_SQL, [[...ids]])).rows as OwnRow[] : [];

/**
 * No row where the locator says: a class move deletes the source rows before it
 * switches the locator — the record is not lost, it is mid-move. The locator is reread: deleted — no record; the class
 * changed (the move has just finished) — the row is in the new class. Otherwise a move is running — in_progress (retry in
 * a few seconds), not a second document. No move, but the row is in another class's database — the move failed after deleting
 * the source: it is the same record. Nowhere — null, as before (the record is deleted).
 */
async function movedOwn(app: App, caller: Caller, own: OwnCandidate): Promise<{ cls: DataClass; rec: OwnRow } | null> {
  const loc = (await app.db.control.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [own.record_id])).rows[0] as { class: DataClass; deleted: boolean } | undefined;
  if (!loc || loc.deleted) return null;
  if (loc.class !== own.class) {
    const [rec] = await ownRows(app, caller, loc.class, [own.record_id]);
    if (rec) return { cls: loc.class, rec };
  }
  if ((await app.db.control.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying') LIMIT 1", [own.record_id])).rows.length)
    throw inProgress(10);
  const other: DataClass = loc.class === "open" ? "closed" : "open";
  const [rec] = await ownRows(app, caller, other, [own.record_id]);
  return rec ? { cls: other, rec } : null;
}

/**
 * The current version (chain head) of an older own document version `rec` found as "the same file" — its locator and
 * row in the same class database (a chain lives in one class and one space, and has one owner). null — no newer live version.
 */
async function ownHead(app: App, caller: Caller, cls: DataClass, own: OwnCandidate, rec: OwnRow, hashes: Buffer[]): Promise<OwnLive | null> {
  const db = ownDb(app, caller, cls);
  const headId = (await db.query(CHAIN_HEAD, [rec.id])).rows[0]?.id as string | undefined;
  if (!headId || headId === rec.id) return null;
  const [head] = await ownRows(app, caller, cls, [headId]);
  if (!head || head.is_current === false || deadOwn(head)) return null;
  const loc = (await app.db.control.query(
    "SELECT record_id, space_id, class, CASE WHEN class = 'closed' THEN open_check END AS open_check FROM record_locations WHERE record_id = $1 AND owner_id = $2 AND NOT deleted",
    [headId, caller.person!.id])).rows[0] as Pick<OwnCandidate, "record_id" | "space_id" | "class" | "open_check"> | undefined;
  if (!loc || loc.class !== cls) return null;
  // after a revert the head carries these very bytes again: it is simply the current version, no note about the older one
  return { own: { ...own, ...loc }, cls, db, rec: sameBytes(hashes, head.source_hash) ? head : { ...head, older: rec.version } };
}

/**
 * The first own live record of "the same file": the owner's locators with this fingerprint (`onlyHere` — only
 * in this space; otherwise this space first), in order, in pages of OWN_PAGE — the rows of each page in one
 * query per class. Dead ones are skipped; a full page does not mean "no live one" (ten old
 * refusals hid the saved copy, and every repeat made one more document) — then the next page by
 * key (other space, updated_at, id). The key time — as text from the database: Date loses microseconds.
 */
async function firstLiveOwn(app: App, caller: Caller, a: { hashes: Buffer[]; spaceId: string; onlyHere: boolean; openOnly?: boolean }): Promise<OwnLive | null> {
  let after: OwnCandidate | null = null;
  for (;;) {
    const page = (await app.db.control.query(
      `SELECT record_id, space_id, class, CASE WHEN class = 'closed' THEN open_check END AS open_check, space_id <> $3 AS other, updated_at::text AS at
         FROM record_locations
        WHERE owner_id = $1 AND source_hash = ANY($2::bytea[]) AND type = 'document' AND NOT deleted${a.onlyHere ? " AND space_id = $3" : ""}${a.openOnly ? " AND class = 'open'" : ""}
          AND ($4::boolean IS NULL OR (space_id <> $3, updated_at, record_id) > ($4::boolean, $5::timestamptz, $6::uuid))
        ORDER BY space_id <> $3, updated_at, record_id LIMIT ${OWN_PAGE}`,
      [caller.person!.id, a.hashes, a.spaceId, after ? after.other : null, after?.at ?? null, after?.record_id ?? null])).rows as OwnCandidate[];
    const found = new Map<string, { cls: DataClass; rec: OwnRow }>();
    for (const cls of ["open", "closed"] as const)
      for (const rec of await ownRows(app, caller, cls, page.filter((c) => c.class === cls).map((c) => c.record_id))) found.set(String(rec.id), { cls, rec });
    for (const own of page) {
      const hit = found.get(own.record_id) ?? await movedOwn(app, caller, own);
      if (!hit || deadOwn(hit.rec) || (a.openOnly && hit.cls !== "open")) continue;   // mid-move into closed — not "the same" either
      // the bytes of an older version of a document answer with its current version (the locator knows no versions)
      if (hit.rec.is_current === false) { const head = await ownHead(app, caller, hit.cls, own, hit.rec, a.hashes); if (head) return head; continue; }
      return { own, cls: hit.cls, db: ownDb(app, caller, hit.cls), rec: hit.rec };
    }
    if (page.length < OWN_PAGE) return null;
    after = page[page.length - 1]!;
  }
}

/**
 * The same file into the same open team or project from the workplace. A record saved closed is unknown to
 * the open database, so one's own record is sought by locator — owner, fingerprint, this space, whatever the class,
 * as in one's own personal space: a closed one (saved closed or hidden by the author) — already_known with the full mark view (a
 * session reads closed) and "already uploaded here and hidden from agents"; an open one — already_known, as a search in the open
 * database would too. A dead one (the worker refused it after conversion) — not "the same file"; awaiting a move retry — said so.
 * No own one — null: then the earlier search in the open database (another's file, placement). The search — firstLiveOwn: all own
 * candidates page by page, a record mid-move — in_progress, not a new document.
 */
async function ownFileHere(app: App, caller: Caller, space: SpaceAccess, hashes: Buffer[], bytes: number) {
  const hit = await firstLiveOwn(app, caller, { hashes, spaceId: space.id, onlyHere: true });
  if (hit) {
    const { own, cls: ownCls, db, rec } = hit;
    const mark = parseOpenCheckFallback(own.open_check);
    const view = mark ? await markViewFor(app, caller, { id: rec.id, spaceId: space.id, ownerId: caller.person!.id, raw: own.open_check }) : null;
    const older = olderVersionNote(rec, caller.scope.classes.includes(ownCls));
    const result = { id: rec.id as string, path: recordPath(space.slug, "document", rec.occurred_at, rec.id), type: "document", space: space.slug, class: ownCls, already_known: true, bytes,
                     placed: true, note: older, stages: await stagesOf(db, rec.id), queue: await queueOf(app, rec),
                     ...(view ? { open_check: view } : {}) };
    const tail = older ? ` · ${older}` : "", chain = chainFacts(rec);
    if (ownCls === "closed") return { result, text: `This file was already uploaded here and is hidden from agents: ${result.path}${repeatMarkTail(view, mark, "closed")}${tail}`, chain };
    // in a team or project, a file with its attempts used up is not deleted — it is saved, "Retry" moves it
    const held = rec.conv === "failed" && rec.conv_error === "open_check_fallback_failed"
      ? " · the document is waiting to move to the closed class. It has been saved and is unavailable to everyone until the memory administrator retries the move with “Retry”" : "";
    // the bytes of an older version — the English template of the session branch
    return { result, text: older ? `${docVersionText("known_older", { path: result.path, note: older })}${held}` : `This file is already in memory: ${result.path}${held}${tail}`, chain };
  }
  return null;
}

export async function upload(app: App, caller: Caller, a: UploadArgs, headCaller?: Caller) {
  const max = app.settings.get("limits.upload_max_bytes", 20_971_520);
  if (a.bytes.length > max) throw tooLarge(`The file exceeds ${Math.floor(max / 1_048_576)} MB`);
  if (!a.bytes.length) throw invalid("The file is empty");
  // name and title — in NFC: Finder gives them in NFD, and a title like "Résumé" was not found by the search
  // "résumé", and the name in the key and download got "_" mid-word. It is the common entry of MCP, REST and the workplace; the
  // fingerprint below — by the NFC name, and "the same file" is also sought by the name as sent (uploadHashes)
  const sentName = a.filename;
  a = { ...a, filename: a.filename.normalize("NFC"), ...(typeof a.title === "string" ? { title: a.title.normalize("NFC") } : {}) };
  // a stop on space: the database or storage disk is low on space or the path is unreadable — the file is not
  // accepted at all, before parsing and the "same file" search; reading and search are not affected
  await checkDiskForUpload(app);
  const entityKeys = checkEntityList(a.entities);
  let mime = a.mime.split(";")[0]!.trim().toLowerCase();
  // Text goes into the record as is; a converter format is accepted only when the converter is configured — then the record
  // gets the `converted` stage, and has no text before it. Without a configured converter a binary file is not accepted at all
  // (the converter_url setting used to only lift the MIME check, and a PDF was indexed as "text").
  // The format is decided by the name and bytes (sniffDocument), the type is only a hint; intake — by
  // the list accepted now (the setting and the converter fast lane), a refusal — in plain words listing what is allowed.
  // `original_mime` holds the normalized type of the recognized format, not the one the browser sent.
  const converterReady = converterConfiguredBySettings(app.settings);
  let converting = false, format: ConverterFormat | undefined;
  // A declared text is only a hint too: bytes with a document signature (PDF, ZIP, OLE, RTF) or binary ones
  // take the document path — otherwise `contract.rtf` typed text/plain would land as raw markup past the refusals (macros,
  // `.xls`, a format not enabled) and the converter-text open check, and the original without `attrs.conversion` went to agents
  if (!TEXT_MIME.has(mime) || declaredTextLooksLikeDocument(a.bytes)) {
    const sniff = sniffDocument(a.bytes, a.filename, mime);
    if (sniff.ok && sniff.kind === "text") mime = sniff.mime;          // text without a type (`octet-stream` named .txt or .md)
    else if (!converterReady)
      throw invalid(`The document converter is not configured (${converterMissing(app.settings).join(", ") || "integrations.converter_url"}). Accepted formats are markdown and text (${[...TEXT_MIME].join(", ")})`,
                    { accepted: [...TEXT_MIME] });
    else {
      const { formats, viaTestHook } = await converterFormatsFor(app, caller);
      const { accepted_mime: accepted } = await uploadCapabilities(app, formats);
      if (!sniff.ok) {
        // only codes and the extension the uploader named: neither the file name nor the content
        log.info("upload_format_refused", { refusal: sniff.refusal, ext: sniff.ext, declared: mime.slice(0, 100) });
        throw invalid(sniffRefusalText(sniff, formats), { accepted, refusal: sniff.refusal });
      }
      if (!formats.includes(sniff.format)) {
        log.info("upload_format_refused", { refusal: "not_enabled", format: sniff.format });
        throw invalid(sniffRefusalText({ refusal: "unsupported" }, formats), { accepted, refusal: "not_enabled" });
      }
      // accepted only by the test hook: a trace in the log — the format, without the file name and content
      if (viaTestHook.includes(sniff.format)) log.info("upload_office_test_hook", { format: sniff.format });
      mime = sniff.mime;
      converting = true;
      format = sniff.format;
    }
  }
  // a new version of an existing document — its own path (doc-versions.ts); without `replaces` nothing below changes
  if (a.replaces !== undefined && a.replaces !== "")
    return uploadVersion(app, caller, a, { mime, converting, ...(format ? { format } : {}), hashes: uploadHashes(a.bytes, sentName), entityKeys }, headCaller);
  const space = await spaceForWrite(app, caller, a.space);
  const cls: DataClass = space.default_class;
  // the first — by the NFC name (the new record writes it), the others — by the name as sent and in NFD: a file from a Mac
  // before the fix is recognized
  const hashes = uploadHashes(a.bytes, sentName), hash = hashes[0]!;
  const mode = personalMode(caller, space);
  // a person in the workspace whose default for the own personal space is open takes the same "personal open" path;
  // decided once per call, before the lock (a choice changed meanwhile applies to the next upload)
  const humanOpen = mode === null && await humanOpenDefault(app, caller, space);
  // a person in the workplace uploads a file into an open team or project — a finding that may be shown
  // "despite" — the file survives closed in the same space (the server derives the decision: keepClosedHere)
  const keep = keepClosedHere(app, caller, space);
  // the "same file" search, the check, saving the original and the write — in one queue by the file fingerprint: a parallel
  // second upload waits for the first and gets already_known (or a placement) with the same id. Dead records (a refusal after
  // conversion) are still skipped — a repeat after such a refusal makes a new record, but only one
  return withKeyLock(sameFileKey(hash), async () => {

  // the same file into the same team or project: one's own record here — by locator, whatever the class (one saved closed
  // is unknown to the open database); no own one — the earlier search below (another's file, placement)
  // with the open default the person's own file in this personal space is found the same way, whatever its class
  const again = (keep || humanOpen) ? await ownFileHere(app, caller, space, hashes, a.bytes.length) : null;
  if (again) return again;

  // the same file is not a duplicate but a placement. The match is sought only among records the caller sees anyway:
  // otherwise the already_known answer would reveal that another's file exists. A placement is a write into the space: it needs
  // the right to write there (an org reader used to "place" a document for the whole company), and it goes into the log.
  const spaces = await readableSpaces(app, caller);
  if (mode !== null) {
    // one's own personal space with a personal key (personal open, script, off): "the same file"
    // is sought by locator among OWN records whatever the class — it is one for open and closed; the answer class is the class
    // of the found record. The closed database is read only for one's own closed record (date and stages)
    // A dead record — a document the worker refused after conversion (busy, too slow, a check failure: the original is deleted,
    // conversion failed / open_check) — is not "the same file": otherwise the repeat the refusal asks for would forever hit
    // already_known. So there are several candidates, and the first live one is taken — among all, page by page;
    // a record mid-move — in_progress, not a second document
    // the external agents' address does not look for its own closed file as "the same" — the answer does not tell if it exists
    const hit = await firstLiveOwn(app, caller, { hashes, spaceId: space.id, onlyHere: false, openOnly: closedRepeatsHidden(caller) });
    if (hit) {
      const { own, cls: ownCls, db, rec } = hit;
      const slug = spaces.get(own.space_id)?.slug ?? (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [own.space_id])).rows[0]?.slug ?? space.slug;
      const placeNote = own.space_id === space.id ? null
        : ownCls === "closed" ? `a personal key cannot place a closed record in ${space.slug}. Promote the record with memory_promote or upload through a T0 service`
        : `the file already exists in space ${slug}. It is already visible to you, so no placement is created in your personal space`;
      const note = [placeNote, olderVersionNote(rec, caller.scope.classes.includes(ownCls))].filter(Boolean).join(" · ") || null;
      const mark = parseOpenCheckFallback(own.open_check);
      // `by_word` — by the record itself: the document is no longer only in one's own personal space — false
      const view = mark ? await markViewFor(app, caller, { id: rec.id, spaceId: own.space_id, ownerId: caller.person!.id, raw: own.open_check }) : null;
      const result = { id: rec.id, path: recordPath(slug, "document", rec.occurred_at, rec.id), type: "document", space: slug, class: ownCls, already_known: true, bytes: a.bytes.length,
                       placed: placeNote === null, note, stages: await stagesOf(db, rec.id), queue: await queueOf(app, rec),
                       ...(view ? { open_check: view } : {}) };
      // the fallback path used up its move attempts: the document is hidden and waits for the administrator — say so
      const held = rec.conv === "failed" && rec.conv_error === "open_check_fallback_failed"
        ? " · the document is waiting to move to the closed class. It has run out of attempts, and the administrator can retry the move" : "";
      // the bytes of an older version — the English template of the session branch
      const lead = rec.older !== undefined && note ? docVersionText("known_older", { path: result.path, note }) : `This file is already in memory: ${result.path}${note ? ` · ${note}` : ""}`;
      return { result, text: `${lead}${repeatMarkTail(view, mark, "closed")}${held}`, chain: chainFacts(rec) };
    }
  } else if (caller.scope.classes.includes(cls)) {
    const db = app.db.records(cls, caller.scope);
    let placeMark: ExtendedMark | null = null;
    for (const rec of (await db.query("SELECT * FROM records_live WHERE source_hash = ANY($1::bytea[]) AND type = 'document'", [hashes])).rows) {
      if (!(await recordVisible(db, caller, rec, spaces))) continue;
      // a document the worker refused by the open check (busy, too slow, a check failure) is not "the same file", as in the
      // personal branch above: otherwise the repeat the refusal asks for hit already_known with an empty card
      if (rec.attrs?.conversion?.status === "failed" && ["open_check", "version_refused"].includes(rec.attrs?.conversion?.error_kind)) continue;
      if (rec.space_id !== space.id) {
        if (!canWrite(space)) throw classDenied("This space is read-only");
        // a document of an archived space is not placed into another: its reader circle only narrows. One already
        // placed here — the earlier already_known answer
        const home = await spaceArchived(app, rec.space_id as string);
        if (home && !(await db.query("SELECT 1 FROM record_placements WHERE record_id = $1 AND space_id = $2", [rec.id, space.id])).rowCount)
          throw archivedDenied(home.slug, home.archived_at, `This file is already in the archived space ${home.slug} (archived on ${home.archived_at.toISOString().slice(0, 10)}). An archived document cannot be placed in other spaces. The space owner or memory administrator can restore the space.`);
        // placing an open document in another space widens its reader circle — its texts pass the open-class check
        // under the current rules: the document may have reached open before the rules or before the NDA list
        if (cls === "open" && !(await db.query("SELECT 1 FROM record_placements WHERE record_id = $1 AND space_id = $2", [rec.id, space.id])).rowCount) {
          // an agent that reads closed does not place a file in open without permission: before reading the texts;
          // with permission — the placement is logged (extended_open), the record itself is neither changed nor marked
          placeMark = await extendedOpenGate(app, caller, { attempt: "placement", space: { id: space.id, slug: space.slug }, recordId: rec.id });
          // the original is unreadable or over the limit — a refusal without findings; conversion is unrelated to placement.
          // A document shown to agents "as text only" (original_closed) — scans are not dropped: the consent was for the reader
          // circle of that space
          const tree = await treeTexts(app, "open", rec.id, { live: true });
          const guard = { via: "upload" as const, spaceId: space.id, recordId: rec.id, texts: tree.texts, unchecked: moveUnchecked(tree.unchecked, rec.attrs?.original_closed === true) };
          if (keep) {
            // a person in the workplace uploads a file into an open team or project: an open
            // copy from another space with a finding (shown there "despite" or opened by word) or one shown there
            // "as text only" is not placed here — the consent was for its circle. The file lands as a new record here, as if
            // there were no first copy: a finding that may be shown — closed with a mark (admitRecord → guardOpenKeepClosed),
            // the rest — the earlier refusal; the worker checks a PDF. The source record and its placements stay, there is no
            // open_check_refused event for another's record. "Not checked" (busy, the original unreadable) — the earlier refusal
            const out = await openCheckOutcome(app, caller, guard);
            if (out.unchecked && out.unchecked !== "partial_text") await refuseOpen(app, caller, guard, out);
            if (out.unchecked || out.findings.length) { placeMark = null; continue; }
          } else await guardOpen(app, caller, guard);
        }
        const placed = await db.query("INSERT INTO record_placements (record_id, space_id, placed_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [rec.id, space.id, caller.person!.id]);
        if (placed.rowCount) await audit(app, caller, { event_type: "write", class: cls, record_ids: [rec.id], space_id: space.id,
          details: { op: "placement", type: "document", from_space: rec.space_id, ...markEvent(placeMark), ...(caller.transport ? { via: caller.transport } : {}) } });
        else placeMark = null;
      }
      const slug = spaces.get(rec.space_id)?.slug ?? space.slug;
      const result = { id: rec.id, path: recordPath(slug, "document", rec.occurred_at, rec.id), type: "document", space: slug, class: cls, already_known: true, bytes: a.bytes.length,
                       placed: true, note: null as string | null, stages: await stagesOf(db, rec.id), queue: await queueOf(app, rec.attrs) };
      return { result, text: `This file is already in memory: ${result.path}${placeMark ? JOURNAL_TAIL : ""}`, chain: chainFacts(rec) };
    }
    // no current document has these bytes, an older version of one does — the answer is its current version, not a new record
    const older = await olderVersionHit(db, caller, cls, hashes, spaces);
    if (older) {
      const { head, version } = older;
      const slug = spaces.get(head.space_id)?.slug ?? space.slug;
      const note = olderVersionNote({ ...head, older: version })!;
      const result = { id: head.id, path: recordPath(slug, "document", head.occurred_at, head.id), type: "document", space: slug, class: cls, already_known: true, bytes: a.bytes.length,
                       placed: head.space_id === space.id, note, stages: await stagesOf(db, head.id), queue: await queueOf(app, head.attrs) };
      return { result, text: docVersionText("known_older", { path: result.path, note }), chain: chainFacts(head) };
    }
  } else if (!closedRepeatsHidden(caller)) {
    // the space class is unavailable to the key (a T2 key → closed): "the same file" is sought by locator among OWN records
    // (the external agents' address does not look: the document lands as a new record)
    // (owner = the caller) — the closed database is not read. The contract's already_known promise is kept;
    // a placement into another closed space is not made without reading the closed database — the answer text says so honestly.
    const own = (await app.db.control.query(
      "SELECT record_id, space_id FROM record_locations WHERE owner_id = $1 AND source_hash = ANY($2::bytea[]) AND class = $3 AND type = 'document' AND NOT deleted ORDER BY (space_id = $4) DESC, updated_at LIMIT 1",
      [caller.person!.id, hashes, cls, space.id])).rows[0];
    if (own) {
      const db = app.db.recordsForWrite(cls, caller.scope);   // own record metadata (date, stages) — as for memory_remember into closed
      let rec = (await db.query("SELECT id, occurred_at, version, supersedes_id, is_current, attrs ->> 'process_now_at' AS process_now_at, attrs ->> 'process_now_by' AS process_now_by, attrs ->> 'deferred_reason' AS deferred_reason FROM records WHERE id = $1 AND deleted_at IS NULL", [own.record_id])).rows[0];
      // the bytes of an older version of an own document — the answer is its current version (own chain ids only)
      if (rec && rec.is_current === false) {
        const headId = (await db.query(CHAIN_HEAD, [rec.id])).rows[0]?.id;
        const head = headId && headId !== rec.id
          ? (await db.query("SELECT id, occurred_at, version, supersedes_id, is_current, source_hash, attrs ->> 'process_now_at' AS process_now_at, attrs ->> 'process_now_by' AS process_now_by, attrs ->> 'deferred_reason' AS deferred_reason FROM records WHERE id = $1 AND deleted_at IS NULL AND is_current", [headId])).rows[0] : undefined;
        // after a revert the head carries these very bytes again: just the current version, no note
        rec = head ? (sameBytes(hashes, head.source_hash) ? head : { ...head, older: rec.version }) : undefined;
      }
      if (rec) {
        const slug = spaces.get(own.space_id)?.slug ?? (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [own.space_id])).rows[0]?.slug ?? space.slug;
        // no placement into the requested space was made — we say so in both MCP and REST:
        // otherwise the client gets 200 and a link to ANOTHER space, and nobody knows the request was not done
        const placeNote = own.space_id !== space.id
          ? `a personal key cannot place a closed record in ${space.slug}. Promote the record with memory_promote or upload through a T0 service` : null;
        // the key does not read this class: the note sends it to the workspace, not to "replaces" (which would answer not_found)
        const note = [placeNote, olderVersionNote(rec, false)].filter(Boolean).join(" · ") || null;
        const result = { id: rec.id, path: recordPath(slug, "document", rec.occurred_at, rec.id), type: "document", space: slug, class: cls, already_known: true, bytes: a.bytes.length,
                         placed: placeNote === null, note, stages: await stagesOf(db, rec.id), queue: await queueOf(app, rec) };
        // the bytes of an older version — the English template of the session branch
        const text = rec.older !== undefined && note ? docVersionText("known_older", { path: result.path, note }) : `This file is already in memory: ${result.path}${note ? ` · ${note}` : ""}`;
        return { result, text, chain: chainFacts(rec) };
      }
    }
  }
  // A file for conversion has no text yet: the `converted` stage brings the markdown and fills record_content.text.
  // A text file in UTF-16 or in the configured legacy code page (locale.legacy_charset) is read as such, not as "\uFFFD"
  const profile = CONVERTER_FAST_PROFILE;   // memory works with the converter in fast mode only
  // a UTF-8 file with broken bytes is checked in both readings: the first is stored. JSON text with non-Latin
  // letters as "\uXXXX" codes — decoded as well: the agent reads the codes, the rules would not
  // the record text — in NFC with LF: a Mac file in NFD, with CRLF or only CR is found by a "résumé" search, and the outline and
  // section reads work; the original is stored byte for byte, the fingerprint is by bytes. Other readings are checked alike
  const legacy = legacyCharsetOf(app.settings);
  const readings = converting ? [""] : decodeVariants(a.bytes, legacy, legacyScanCharsetsOf(app.settings)).map(recordText);
  const [text = "", ...otherReadings] = readings;
  const jsonReadings = [...new Set(readings.flatMap((r) => jsonTextVariants(r, mime)))];
  const occurredAt = parseWhen(a.occurred_at, instanceTz(app.settings));
  const entities = await resolveEntities(app, entityKeys, caller);
  // the record id — in advance: it is part of the original's key, and the original goes into storage before the rows are written
  const recordId = newId();
  // processing lane of the new document: set here, by the upload path, never inside createRecord — copies made by
  // hand-over, custody or the work profile keep their own lane
  const lane = await intakeLane(app, documentEstimate(app, text, converting));
  const draft: NewRecord = {
    id: recordId, type: "document", space, title: a.title?.trim() || a.filename, text, method: "source_document", origin: "human", sourceKind: "upload", sourceRef: a.sourceRef ?? a.filename,
    sourceHash: hash, occurredAt, domains: checkDomains(app, a.domains), entities, ownerId: caller.person!.id, needsConversion: converting, convertFormat: format,
    // a PDF into a team or project from the workplace: the worker lets a finding in the converted text survive
    // closed in the same space, not as a final refusal (convert.ts)
    // the text original's encoding — for charset on output (originals.ts): the parameter is not written into original_mime —
    // the type goes to the edge too, where the bridge accepts only "type/subtype" (x-mime in bridge-api.yaml)
    attrs: { filename: a.filename, ...(converting ? { conversion: { status: "pending", profile } } : { original_charset: textCharset(a.bytes, legacy) }),
             ...(keep && converting ? { keep_closed_on_findings: true } : {}), ...lane },
    openCheckExtra: [...otherReadings, ...jsonReadings].map((value) => ({ field: "text", value })),
    // personal open: a document into one's own personal space — open after the check, a finding — closed with a mark
    ...(mode === "open" || humanOpen ? { classOverride: "open" as const, personalOpen: true } : {}),
    ...(keep ? { keepClosed: true } : {}),
  };
  // the right to write, the class and the open check (title, file name, text; the text of a converter format
  // the worker checks at the converted stage) — before saving the original: a refused file does not land in open storage, and
  // a file with a finding in the personal space goes straight to closed — the open bucket is not touched
  // the person's daily volume (limits.upload_daily): only a new file spends it — a repeat and a placement have answered above;
  // a check refusal, an unsaved original or a write failure give the room back
  const { created, original } = await withUploadDaily(app, caller, a.bytes.length, async () => {
  const admitted = await admitRecord(app, caller, draft);
  // each record has its own key: an identical file of another person lands next to it, not under the same key
  const key = originalKey(app.instanceId, occurredAt, hash, recordId, a.filename);
  // storage down — the document is accepted (it has the text), but the lost original goes to the log and health, not swallowed
  const original = await originalPut(app, admitted.cls, () => app.storage.put(admitted.cls, key, a.bytes, mime));
  // …except a document for conversion: nothing to convert if the original is not saved — the converter reads it from storage
  if (converting && !original.ok) throw invalid(originalRefusal(original.reason));
  draft.original = { key: original.ok ? key : null, mime, bytes: a.bytes.length, pages: (text.match(/<!--\s*page:\s*\d+\s*-->/g) ?? []).length || null, language: null };
  return { created: await createRecord(app, caller, draft, admitted), original };
  });
  const note = original.ok ? null : originalNote(original.reason), originalTail = note ? ` · ${note}` : "";
  const result = { id: created.id, path: created.path, type: "document", space: created.space, class: created.class, already_known: false, bytes: a.bytes.length,
                   placed: true, note, original_stored: original.ok, ...(!original.ok ? { original_reason: original.reason } : {}),
                   stages: created.stages, queue: await queueOf(app, lane, created.stages.length),
                   ...(outsideView(caller, created.openCheck) ? { open_check: outsideView(caller, created.openCheck)! } : {}),
                   // an upload by an agent with extended access by the administrator's permission: marked and in the log
                   ...(created.extended ? { extended_write: true as const } : {}),
                   // explicit entities of the call (contract 0.20.0): what did not link — as in memory_remember
                   ...(entityKeys?.length ? { entities_unresolved: entities.unresolved } : {}) };
  const marked = created.extended ? MARKED_TAIL : "", unresolved = unresolvedTail(entities.unresolved) + originalTail;
  // personal open: open, a PDF before the text check, or closed with the reason. The REST answer (IngestResult) carries no text
  if (mode === "open") return { result, text: `${personalOpenText(created.path, created.fallback, converting ? "pdf" : "document", profile, adviceFor(caller), describeWhen(lane))}${unresolved}` };
  if (humanOpen)
    return { result, text: `${uploadDefaultText(created.fallback ? "saved_hidden_by_check" : converting && created.class === "open" ? "saved_open_pending_conversion" : "saved_open", created.path)}${unresolved}` };
  // saved closed in a team or project — the reason (this is the author and their own file) and where to show it to agents
  if (keep && created.fallback)
    return { result, text: `Document saved, but agents cannot see it yet: ${created.path} · ${openCheckWhy(created.fallback)}. People of the space see it in the workspace. `
                           + `Its author can show it to agents with the button “Make available to agents”: ${showAnywayWhere(created.id, workplaceUrl(app, showAnywayPath(created.id)))}${unresolved}` };
  // to a script key and with agents' writes off, the MCP answer says why the document in the personal space is closed
  const hint = `${mode === "script" && created.class === "closed" ? ` · ${SCRIPT_HINT}` : ""}${closedHint(app, caller, created.class, created.id)}${mode === "off" ? ` · ${OFF_HINT}: ${workplaceWhere(app, "/keys", "Keys and agents")}` : ""}`;
  return { result, text: converting
    ? `Document accepted: ${created.path} · class ${created.class} · it will be converted to markdown (profile ${profile}), then indexed and described — follow the stage converted${hint}${unresolved}${marked}`
    : `Document accepted: ${created.path} · class ${created.class} · indexing has started, ${describeWhen(lane)}${hint}${unresolved}${marked}` };
  });
}

/** "Process now": the right — as for reading; a T2 key and a closed record — class_denied without reading the closed DB. */
export async function processNow(app: App, caller: Caller, id: string) {
  const loc = await locate(app, id);
  if (!loc || loc.deleted) throw notFound();
  // the external agents' address: one's own closed record — as a missing one, without hints about it
  if (isExternal(caller) && loc.class === "closed") throw notFound();
  const spaces = await readableSpaces(app, caller, { archived: true });   // processing is not content: for an archive member — as reading
  const mine = loc.owner_id === caller.person?.id || spaces.has(loc.space_id);
  if (!mine) throw notFound();
  // another's closed record to an extended key — "no such record": decided by locator, the closed database is not opened
  if (!classAllowed(caller, loc.class, loc.owner_id)) throw notFound();   // vis-ok: the gate from visibility.ts
  // own closed record with a T2 key: ownership comes from the locator, no closed database needed — an honest class_denied, not "no record"
  if (!caller.scope.classes.includes(loc.class)) {
    // one's own record closed by the open check: the reason from the locator — to the author only; the person cannot open it
    // (the same finding), so the advice is "remove it and write it again", not "open it"
    const mark = loc.owner_id === caller.person?.id ? parseOpenCheckFallback(loc.open_check) : null;
    const view = mark ? await markViewFor(app, caller, { id, spaceId: loc.space_id, ownerId: loc.owner_id, raw: loc.open_check }) : null;
    // outside own personal space (view `foreign`): no reasons — else "process now" would probe a closed record's findings
    if (mark && view && !view.kinds)
      throw new MemoryError("class_denied", `The record is hidden from agents. It is processed automatically, and this key cannot process it. Only the author can show it to agents in the workspace: ${showAnywayWhere(id, workplaceUrl(app, showAnywayPath(id)))}`,
                            { details: { open_check: view } });
    if (mark && view) throw new MemoryError("class_denied", `The open check closed the record: ${openCheckWhy(mark)}. It is processed automatically, and this key cannot process it. ${openCheckAdvice(mark, { tool: openByWordCaller(caller), byWord: view.by_word })}`,
                                    { details: { open_check: view } });
    throw classDenied("A T2 key cannot process closed records. Use a T0 service or ask the person to show the record to agents in the workspace");
  }
  const db = app.db.records(loc.class, caller.scope);
  const rec = (await db.query("SELECT id, type, class, token_count, space_id, audience, owner_id FROM records_live WHERE id = $1", [id])).rows[0];
  if (!rec || !(await recordVisible(db, caller, rec, spaces))) throw notFound();
  app.limiter.check(caller, "memory_process_now");

  // a long transcript runs in the day too — in parts, one long meeting at a time (it used to be night only).
  // The button is an explicit request: the daily token cap does not apply, the earlier night move (deferred_*) is lifted
  const before = await stagesOf(db, id);
  const raised = Boolean((await db.query("SELECT 1 FROM records WHERE id = $1 AND attrs ? 'process_now_at'", [id])).rowCount);
  // wake_requested_at — "now" for the pass running this minute: its converter wait (StageWait) ends with a retry
  // at once, not at the term; process_now_at gives the place in the converter queue
  // an explicit request outranks documents that entered the day lane by default: the intake mark goes
  await db.query("UPDATE records SET attrs = (attrs - 'deferred_reason' - 'deferred_to_night_at' - 'process_now_by') || jsonb_build_object('process_now_at', now(), 'wake_requested_at', now()) WHERE id = $1", [id]);
  // a failed conversion: the cycle counters start anew (run retries, generations,
  // document errors), but `action_seq` and `gen` never do: the keys of the new run and upload are fresh, the converter processes
  // the document anew instead of repeating the earlier answer. What to do next is decided by `next_action` (the worker)
  await db.query(
    `UPDATE records SET attrs = jsonb_set(attrs, '{conversion}', (attrs -> 'conversion')
              || '{"reruns": 0, "gen_bumps": 0, "doc_errors": 0, "ocr_reruns": 0, "failed_reruns": 0, "doc_error_limit_at": null, "first_doc_error_at": null}'::jsonb)
      WHERE id = $1 AND jsonb_typeof(attrs -> 'conversion') = 'object'
        AND EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = $1 AND s.stage = 'converted' AND s.status = 'failed')`, [id]);
  await markVersionRetried(db, id);   // a failed converted version is a retry for the worker (head_newer), before the reset below
  // failed ones, ones waiting for the model and ones waiting for the converter (`converter_wait:*`): the retry term and the
  // "busy"/"slow" counters start anew, the job moves to now (kick → schedule, the "now" lane); the model pause and fallback,
  // the converter pause and switch still apply — the button does not bypass them, waiting spends no attempts
  await db.query(
    `UPDATE record_stages SET status = 'pending', attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END, last_error = NULL,
            retry_at = NULL, first_busy_at = NULL, busy_retries = 0, slow_retries = 0, updated_at = now()
      WHERE record_id = $1 AND (status = 'failed'
            OR (status = 'pending' AND (busy_retries > 0 OR slow_retries > 0 OR retry_at IS NOT NULL OR COALESCE(last_error, '') LIKE 'model_%'
                                        OR COALESCE(last_error, '') LIKE 'converter_wait:%')))`, [id]);
  await app.queue.kick({ instance: app.instanceId, class: loc.class, record_id: id, lane: "now" });
  const pending = before.filter((s) => s.status !== "done" && s.status !== "skipped").length;
  const queue = await queueOf(app, { process_now_at: true }, pending);
  const result = { id, stages: await stagesOf(db, id), queue, priority_raised: raised };
  await audit(app, caller, { event_type: "processing", class: loc.class, record_ids: [id], details: { tool: "memory_process_now", lane: queue.lane } });
  return { result, slugPath: { space_id: rec.space_id as string, type: rec.type as string }, text: `Added to the “now” queue. Jobs ahead: ${queue.position ?? "?"}` };
}

/**
 * The person in memory_me and GET /me. given_name — the name to address them by (people.attrs.given_name: the directory,
 * the identity provider or the org table) — only when known: the workplace greets by it, else takes a name from the full name (display_name).
 */
export function mePerson(p: PersonRow, instance: string) {
  const given = p.given_name?.replace(/\s+/g, " ").trim().slice(0, 100);
  return { login: p.login, display_name: p.display_name, ...(given ? { given_name: given } : {}), department: p.department, role: p.role, instance };
}

/**
 * key.expires_warning of memory_me: 14 days before the end of a person's key; none for a service acting on
 * behalf of a person (not about its key), a preview key and a workplace session (the person just signs in again). An
 * agent connection gets the text of its origin: the built-in sign-in — English, without the identity provider in the
 * advice; the external identity provider — as before.
 */
export function meExpiresWarning(app: App, caller: Caller, now = Date.now()): string | null {
  if (caller.onBehalfOf || caller.preview || caller.keyKind === "session") return null;
  if (caller.keyKind === "connection" && caller.expiresAt) return connectionExpiryWarning(caller.expiresAt, now, caller.connectionOrigin ?? "keycloak");
  return personKeyWarning(app, caller.expiresAt, now);
}

/**
 * `o.mcp` — the answer of tools/call memory_me: the text gets the first-minute lines in the words of `texts`, and the
 * latest personal notes are read (their ids join the read event; `recent_notes` goes into a lean answer, mcp-shape.ts).
 * Without it (REST GET /me) — the answer, the journal and the text as before.
 */
export async function me(app: App, caller: Caller, tools: string[], o: { mcp?: { texts: McpTexts } } = {}) {
  if (!caller.person) throw notFound();
  // spaces — only active ones (the meaning and counts as before); archived_spaces — readable archived ones with records
  const all = [...(await readableSpaces(app, caller, { archived: true })).values()];
  const spaces = all.filter((s) => !s.archived_at);
  const archivedSpaces = (await archivedWithRecords(app, all.filter((s) => s.archived_at).map((s) => s.id))).size;
  const spaceIds = spaces.map((s) => s.id);
  // The count is what the person sees in the space: before, only records of the
  // "space" scope counted, and meetings with their summaries and decisions ("people" scope) did not — "Personal: 0 records" with
  // 18 in "My records". Now — the same builder and the same selection as the space list (memory_list /spaces/<slug>,
  // list.ts): the selection visibility rule (listingSpec: the "space" scope, the author by access.author_rule, the people list),
  // the class gate (an extended key in closed — own ones only), the record's home in the space; those held in "Company
  // common knowledge" are not counted. Others' records the person does not read are not counted.
  const counts = await spaceRecordCounts(app, caller, spaceIds);
  // "hidden by the closed class": the person must tell "empty" from "there, but not visible".
  // Counted by control DB locators — the closed DB is not queried. To the external agents' address — 0 (hiddenClosedSql — null)
  const hidden = new Map<string, number>();
  // the department code — only for department spaces: the workplace does not promise AD groups, a name and
  // ownership transfer there — the org table sets them. Others have no field: the answer at each agent session start stays lean
  const unitIds = [...new Set(spaces.map((s) => s.org_unit_id).filter((x): x is string => Boolean(x)))];
  const unitCode = new Map<string, string>(unitIds.length
    ? (await app.db.control.query("SELECT id, code FROM org_units WHERE id = ANY($1::uuid[])", [unitIds])).rows.map((r) => [r.id as string, r.code as string]) : []);
  const hiddenCond = hiddenClosedSql(caller);
  if (hiddenCond && spaceIds.length) {
    const args: unknown[] = hiddenCond.includes("$me") ? [spaceIds, caller.person.id] : [spaceIds];
    const { rows } = await app.db.control.query(
      `SELECT l.space_id, count(*)::int AS n FROM record_locations l
       WHERE l.space_id = ANY($1::uuid[]) AND l.class = 'closed' AND NOT l.deleted AND ${hiddenCond.replace("$me", "$2")} GROUP BY l.space_id`, args);
    for (const r of rows) hidden.set(r.space_id, r.n);
  }
  // the work profile: only to the person's agent with its own key and with the switch on — otherwise no field
  const prof = await meProfile(app, caller, new Map(all.map((s) => [s.id, s])));
  // the "How we work" map: the path of a map visible to the caller — with the switch on and not for a workplace
  // session; otherwise no guide_path field (the answer as before)
  const guides = await meGuidePaths(app, caller, spaces);
  const result = {
    person: mePerson(caller.person, app.instanceId),
    key: { kind: caller.keyKind, tier: caller.tier, client_label: caller.clientLabel,
           // the key program and the personal mode: null — not set (cloud), for a session and a service
           client_kind: caller.clientKind, ...personalClassForKey(caller),
           // writing into open: allowed — as usual; denied — the agent reads closed and does not write into open;
           // marked — writes with a mark and a log entry by the administrator's permission
           open_write_mode: openWriteMode(caller),
           expires_at: caller.expiresAt ? new Date(caller.expiresAt).toISOString() : null,
           on_behalf_of: caller.onBehalfOf ? caller.person.login : null, preview: caller.preview,
           // 14 days before the end of a person's key term; to a service key "on behalf of" — not about its key; a workplace
           // session is not a key: when it ends the person just signs in again
           expires_warning: meExpiresWarning(app, caller) },
    // the memory address for this key: to a cloud agent — access.cloud_agent_base_url, otherwise (and to a workplace
    // session) — access.public_base_url; empty — the panel takes it from the request URL. The "Skill archive" line uses it too
    public_base_url: agentBaseUrl(app, caller),
    // the cloud agents' address setting value: the workplace builds connection commands from it; not set — null
    cloud_agent_base_url: cloudAgentBaseUrl(app),
    // the person's workplace address: "Meetings with me" — <address>/meetings; not set — no field
    ...(workplaceUrl(app) ? { workplace_url: workplaceUrl(app)! } : {}),
    // the agent's personal notebook: on — notes of a key without the closed class into personal are open, the owner sees them
    notebook: caller.person.notebook !== false,
    // "what to write here" — trimmed: the answer at the start of every agent session stays lean;
    // in full — memory_list of the space and the card GET /me/spaces/{slug}
    spaces: spaces.sort((a, b) => a.slug.localeCompare(b.slug)).map((s) => ({ slug: s.slug, kind: s.kind, name: s.name, description: shortDescription(s.description),
      role: s.role, default_class: s.default_class, counts: counts.get(s.id) ?? { records: 0, unprocessed: 0 }, hidden_closed: hidden.get(s.id) ?? 0,
      ...(s.org_unit_id && unitCode.has(s.org_unit_id) ? { org_unit: unitCode.get(s.org_unit_id)! } : {}),
      ...(guides ? { guide_path: guides.get(s.id)?.path ?? null } : {}) })),
    // archived ones (read only, outside the default search): the list — memory_list /spaces with filters.archived: true
    archived_spaces: archivedSpaces,
    limits: app.limiter.snapshot(caller, tools),
    // what a document upload accepts — from the same place in the code as the check in upload()
    upload: await uploadCapabilities(app, undefined, caller),
    // the client program — as a short line and only for one's own actions (actor "me"): the full object — GET /me/audit;
    // the agent does not see a colleague's program, the answer at the start of every agent session stays lean; without
    // the workplace's automatic lists and without widened_by_human: the recent_actions schema is strict
    // to the external agents' address — without record_ids
    recent_actions: await recentActions(app, caller.person.id, { noRecordIds: isExternal(caller) }),
    ...(prof ? { profile: prof.profile } : {}),
  };
  // the latest personal notes of the open class — only for the MCP answer (me-first-minute.ts)
  const notes = o.mcp ? await recentNotes(app, caller, spaces, tools) : [];
  // the shown profile — in the read event: the record id, no text; the ids of the shown notes, in the same event
  const shown = [...(prof?.recordId ? [prof.recordId] : []), ...notes.map((n) => n.id)];
  await audit(app, caller, { event_type: "read", ...(shown.length ? { class: "open" as const, record_ids: shown } : {}), details: { tool: "memory_me" } });
  const hiddenTotal = [...hidden.values()].reduce((a, b) => a + b, 0);
  return { result, text: meResultText(result, archivedSpaces, hiddenTotal, prof?.line ?? "", o.mcp?.texts ?? textsOf(app), o.mcp ? meFirstMinuteView(result, notes, tools) : undefined),
           ...(o.mcp ? { lean: { recent_notes: recentNotesView(notes) } } : {}) };
}

/**
 * Records per space that the caller sees there: memory_me `spaces[].counts` (the rule is described in me()), and "What my
 * agent sees" with a personal key's caller of the same person and the open class only. `classes` — the classes to
 * count; by default the caller's.
 */
export async function spaceRecordCounts(app: App, caller: Caller, spaceIds: string[], classes: readonly DataClass[] = caller.scope.classes)
  : Promise<Map<string, { records: number; unprocessed: number }>> {
  const counts = new Map<string, { records: number; unprocessed: number }>();
  const spec = listingSpec(app, caller, spaceIds);
  const org = await orgSpace(app);
  const orgShown = !!org && spaceIds.includes(org.id);
  for (const cls of classes) {
    const args: unknown[] = [], bind = binder(args);
    const vis = visibleSql(spec, cls, bind);
    if (vis === null) continue;                                 // gate none: the class is not queried
    const held = orgShown ? await heldIds(app, caller, cls) : [];
    const { rows } = await app.db.records(cls, caller.scope).query(
      `SELECT r.space_id, count(*)::int AS n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = r.id AND s.status IN ('pending','running','failed')))::int AS u
       FROM records_live r WHERE ${vis} AND r.space_id = ANY(${bind(spaceIds)}::uuid[])${held.length ? ` AND r.id <> ALL(${bind(held)}::uuid[])` : ""} GROUP BY r.space_id`, args);
    for (const r of rows) { const c = counts.get(r.space_id) ?? { records: 0, unprocessed: 0 }; c.records += r.n; c.unprocessed += r.u; counts.set(r.space_id, c); }
  }
  return counts;
}

/** The memory_me answer fields its text shows. */
export interface MeTextResult {
  person: { display_name: string; login: string };
  key: { kind: string; tier: string; client_kind: string | null; on_behalf_of: string | null; open_write_mode: OpenWriteMode; expires_warning: string | null };
  spaces: { length: number };
}

/** The gateway part of the line for meText: its key and profile lines start with « · » — mcp-core puts the separator. */
const mePart = (s: string): string => s.replace(/^ · /, "");

/**
 * The view and gateway parts for the memory_me text (@memory/mcp-core meText): the key — kind and level, script key, service
 * on behalf, writing into open; after the space count — hidden by the closed class (not in mcp-core views) and the profile.
 */
export function meTextArgs(result: MeTextResult, archivedSpaces: number, hiddenTotal: number, profileLine: string, firstMinute?: MeFirstMinute): [MeView, string[]] {
  const k = result.key;
  return [{
    display_name: result.person.display_name, login: result.person.login,
    key_marks: [`${k.kind}/${k.tier} key`, k.client_kind === "script" ? "script key: writes to your personal space are closed" : "", k.on_behalf_of ? `service on behalf of ${k.on_behalf_of}` : "",
                mePart(openWriteLine(k.open_write_mode))],
    spaces: result.spaces.length, archived_spaces: archivedSpaces, warning: k.expires_warning, ...(firstMinute ? { first_minute: firstMinute } : {}),
  }, [hiddenTotal ? `hidden by the closed class: ${hiddenTotal}` : "", mePart(profileLine)]];
}

/**
 * The memory_me answer text (pinned by golden files): one line about the person, key and spaces, then —
 * a key-term warning. `profileLine` — the profile line from meProfile (with « · » first) or empty. `firstMinute` —
 * the lines after them (the MCP answer); absent — the text of 0.27.0.
 */
export function meResultText(result: MeTextResult, archivedSpaces: number, hiddenTotal: number, profileLine: string, texts: McpTexts, firstMinute?: MeFirstMinute): string {
  return meText(...meTextArgs(result, archivedSpaces, hiddenTotal, profileLine, firstMinute), texts);
}
