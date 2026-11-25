// Project spaces in the workplace. Any employee
// creates a project space (kind project) and becomes its owner; the default class is open, and only with an explicit
// confirmation (open_ack, the "I understand the consequences" checkbox). An agent (memory_space_create) still creates
// a closed team space — by the same creation code: a per-person limit, reserved slugs, the metadata check, a slug without
// a race. The name, description and slug of any space being created or renamed, except personal and department ones,
// pass the open class check (via space): members' cloud agents see them, and the slug gets into repository
// files (the line "Project memory: space <slug>" in CLAUDE.md or AGENTS.md).
import { archivedDenied, ensureProjectEntity, groupStaleHours, groupValidity, invalid, ldapConfig, MemoryError, neverOpen, newId, notFound, openCheckReasons, openCheckTruncated, slugify, tx, type DataClass, type OpenCheckFinding, type OpenCheckText } from "@memory/shared";
import { randomInt } from "node:crypto";
import type pg from "pg";
import type { App, Caller } from "./context.ts";
import { archivedWithRecordsSql, insertSpace, OWNER_IN_FORCE_SQL, readableSpaces, resolveSpace, setSpaceOwner, slugCandidates, type SpaceAccess } from "./access.ts";
import { audit } from "./audit.ts";
import { guardOpen, openCheckOutcome, refuseOpen, type GuardArgs } from "./open-check.ts";
import { ORG_SPACE_NAME } from "./org-space.ts";
import { GUIDE_SETTING, instanceReadmeTemplate, README_MAX, readmeDisabled, readmeEnabled, readmeOf } from "./space-readme.ts";
import { requireHuman } from "./workplace.ts";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
const NAME_MAX = 120, DESCRIPTION_MAX = 2000, MEMBERS_MAX = 100;
/** "What to write here" in memory_me — no longer than this many characters: in full — memory_list and the card. */
export const ME_DESCRIPTION_MAX = 300;
/** The workplace section where a person creates and runs projects: the link in "people only" refusals. */
// the workplace section is one "Spaces and projects" list; the old /projects address leads there too
export const PROJECTS = { path: "/projects", section: "Spaces and projects" } as const;

/**
 * Reserved slugs: me — the alias of personal (resolveSpace, memory_list), org — the organizational one
 * (the org table upload makes it under this slug), u- — personal ones, dep- — departments, demo- — the role showcase
 * (demo-showcase), zz- — the space of the post-deploy check. A suffix does not help here: a project "u-smith" would look
 * like someone's personal space, and a taken "me" would be unreachable.
 */
export const reservedSlug = (slug: string): boolean => slug === "me" || slug === "org" || /^(u|dep|demo|zz)-/.test(slug);

/**
 * Slug candidates of a space the person creates: base, base-2… without reserved ones. The base "dep", "demo",
 * "zz" is free, but its suffixes are the dep-, demo-, zz- prefixes: a taken "dep" would give a project dep-2 — the slug
 * of the department space with code 2, and the department itself would get dep-2-2. Such candidates are skipped.
 */
export function* projectSlugCandidates(base: string, entitySlugs: ReadonlySet<string> = new Set(), hidden: ReadonlySet<string> = new Set(),
                                       random: () => string = randomSlugSuffix, visible?: ReadonlySet<string>): Generator<string> {
  for (const slug of slugCandidates(base)) {
    if (reservedSlug(slug)) continue;
    // a candidate taken by a space the caller cannot see switches to random suffixes — a numbered
    // one would tell that the hidden space exists and how many share its name. That the requested slug itself is taken
    // stays visible (the answer is another slug); the alternative, a refusal "taken", says the same and more. Checked
    // before the entity slugs: a project space always has its entity under the same slug, and skipping it as an entity
    // would hand out base-2 over a hidden project
    if (hidden.has(slug)) { yield* randomSlugCandidates(base, entitySlugs, random); return; }
    // an entity without a space of its own (a manager's project from before the space) keeps the numbered suffix
    if (entitySlugs.has(slug)) continue;
    yield slug;
    // Resumed: insertSpace asks for the next candidate only when this one failed to insert. With the caller's visible
    // slugs known, a slug held by a space the caller does not see — also one committed by someone else after the
    // `hidden` snapshot, e.g. a simultaneous creation — switches to random suffixes here, at the conflict
    if (visible && !visible.has(slug)) { yield* randomSlugCandidates(base, entitySlugs, random); return; }
  }
}

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Four random characters of [a-z0-9] (36^4 ≈ 1.7 M values) from the system's cryptographic generator. */
export const randomSlugSuffix = (): string => Array.from({ length: 4 }, () => SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)]).join("");
/** Up to 20 slugs `<base, at most 58 characters>-<4 random>`; reserved prefixes and entity slugs are skipped as above. */
function* randomSlugCandidates(base: string, entitySlugs: ReadonlySet<string>, random: () => string): Generator<string> {
  const head = base.slice(0, 58);
  for (let i = 0; i < 20; i++) {
    const slug = `${head}-${random()}`;
    if (!reservedSlug(slug) && !entitySlugs.has(slug)) yield slug;
  }
}

// ---------------------------------------------------------------- request body parsing (contract: MySpaceCreate, MySpaceUpdate)
const isObject = (b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b);
const extraKeys = (b: Record<string, unknown>, allowed: readonly string[]): string[] => Object.keys(b).filter((k) => !allowed.includes(k));

function nameOf(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > NAME_MAX) throw invalid(`name: a name of 1 to ${NAME_MAX} characters`);
  return v.trim();
}

/** "What to write here": null and an empty string — not set. */
function descriptionOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > DESCRIPTION_MAX) throw invalid(`description: “What to write here” — a string of up to ${DESCRIPTION_MAX} characters`);
  return v.trim() || null;
}

/** Member logins: lower case, no repeats. */
export function membersOf(v: unknown, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw invalid(`members: a list of logins (email addresses), at most ${max}`);
  const out = new Set<string>();
  for (const x of v) {
    const login = typeof x === "string" ? x.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(login) || login.length > 254) throw invalid("members: a login is a company email address");
    out.add(login);
  }
  return [...out];
}

export interface CreateInput { name: string; slug?: string; description: string | null; defaultClass: DataClass; members: string[];
  /** "More about the space": only with onboarding.readme_templates_enabled on; otherwise the column is empty. */
  readme?: string | null }

/** Parsing: whether the "Space description from a template" switch is on — the readme field is refused without it. */
export interface ParseOpts { readme?: boolean }

/**
 * Body of POST /me/spaces. The default class is open, and an open one is created only with open_ack: true —
 * the person confirmed that members' cloud agents on external models read the records; a closed one — without the checkbox.
 */
export function parseCreate(b: unknown, o: ParseOpts = {}): CreateInput {
  if (!isObject(b)) throw invalid("The request body is a JSON object: name, slug, description, default_class, open_ack, members");
  if (b.readme !== undefined && !o.readme) throw readmeDisabled();
  const bad = extraKeys(b, ["name", "slug", "description", "default_class", "open_ack", "members", ...(o.readme ? ["readme"] : [])]);
  if (bad.length) throw invalid(`Extra fields: ${bad.join(", ")}`);
  const name = nameOf(b.name);
  if (b.slug !== undefined && (typeof b.slug !== "string" || !SLUG_RE.test(b.slug)))
    throw invalid("slug: lowercase Latin letters, digits and hyphens, 2 to 63 characters, starting with a letter or a digit");
  const defaultClass = b.default_class ?? "open";
  if (defaultClass !== "open" && defaultClass !== "closed") throw invalid("default_class: open or closed");
  if (b.open_ack !== undefined && typeof b.open_ack !== "boolean") throw invalid("open_ack: true or false");
  if (defaultClass === "open" && b.open_ack !== true)
    throw invalid("Confirm that you understand the consequences: the records of an open space are read by the members' cloud agents on external models (open_ack: true)");
  return { name, ...(typeof b.slug === "string" ? { slug: b.slug } : {}), description: descriptionOf(b.description), defaultClass, members: membersOf(b.members, MEMBERS_MAX),
           ...(b.readme !== undefined ? { readme: readmeOf(b.readme) } : {}) };
}

export interface SpacePatch { name?: string; description?: string | null; readme?: string | null }

/**
 * Body of PATCH /me/spaces/{slug}: only the name and description, with templates on — also "More about
 * the space" (readme). The slug is already in repositories, and a class change would open records to agents — an extra field
 * is refused, not silently skipped; readme with the switch off — the refusal "turned off by the administrator".
 */
export function parseUpdate(b: unknown, o: ParseOpts = {}): SpacePatch {
  if (!isObject(b)) throw invalid(o.readme ? "The request body is a JSON object: name, description and/or readme" : "The request body is a JSON object: name and/or description");
  if (b.readme !== undefined && !o.readme) throw readmeDisabled();
  const bad = extraKeys(b, ["name", "description", ...(o.readme ? ["readme"] : [])]);
  if (bad.length) throw invalid(`Only the name and the description change (name, description${o.readme ? ", readme" : ""}); ${bad.join(", ")} — no: the slug is already in repositories, and the kind and the class are set at creation`);
  if (b.name === undefined && b.description === undefined && b.readme === undefined) throw invalid(o.readme ? "Give name, description or readme" : "Give name or description");
  return { ...(b.name !== undefined ? { name: nameOf(b.name) } : {}), ...(b.description !== undefined ? { description: descriptionOf(b.description) } : {}),
           ...(b.readme !== undefined ? { readme: readmeOf(b.readme) } : {}) };
}

/** Body of POST /me/spaces/{slug}/owner: the new owner's login. */
export function parseTransfer(b: unknown): string {
  if (!isObject(b) || extraKeys(b, ["login"]).length || typeof b.login !== "string") throw invalid("The request body is {\"login\": the new owner's login}");
  const login = b.login.trim().toLowerCase();
  if (!EMAIL_RE.test(login) || login.length > 254) throw invalid("login: the new owner's login is a company email address");
  return login;
}

/** "What to write here" for memory_me: up to ME_DESCRIPTION_MAX characters (code points), a long one — with "…" at the end. */
export function shortDescription(d: string | null | undefined, max = ME_DESCRIPTION_MAX): string | null {
  if (d === null || d === undefined) return null;
  const chars = Array.from(d);
  return chars.length <= max ? d : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

// ---------------------------------------------------------------- metadata check (via space)
/** Space metadata that members' agents see: the name, "What to write here", "More about the space", the slug. */
export interface SpaceMeta { name?: string | null; description?: string | null; readme?: string | null; slug?: string | null }

/** Metadata texts for the open class check: only the set fields; the slug — with spaces instead of hyphens. */
export function spaceMetaTexts(m: SpaceMeta): OpenCheckText[] {
  const out: OpenCheckText[] = [];
  if (m.name) out.push({ field: "name", value: m.name });
  if (m.description) out.push({ field: "description", value: m.description });
  if (m.readme) out.push({ field: "readme", value: m.readme });
  if (m.slug) out.push({ field: "slug", value: m.slug.replaceAll("-", " ") });
  return out;
}

/**
 * The name and description after an edit (PATCH /me/spaces, PUT /admin/spaces): checked whole, not only the changed field
 * — combination rules (an email next to a full name) see both texts, as the agent does in memory_me; a full name in the name,
 * then an email in the description do not pass in two steps. A finding in the old field — the same refusal: both must be fixed.
 */
export function metaAfterUpdate(s: { name: string; description?: string | null; readme?: string | null }, changed: SpacePatch): { name: string; description: string | null; readme: string | null } {
  return { name: changed.name ?? s.name, description: "description" in changed ? (changed.description ?? null) : (s.description ?? null),
           readme: "readme" in changed ? (changed.readme ?? null) : (s.readme ?? null) };
}

/**
 * "More about the space" in the owner's metadata check (an edit, the switch to "and AI agents") — only with templates
 * on. Off — as before, without readme: the owner does not see a description saved earlier now and cannot
 * fix it (no field in the card or in PATCH), and a finding in it must not lock the name and "what to write here". Such a
 * description is shown by the administrator's morning report (space_meta_findings).
 */
export const ownerMeta = <T extends SpaceMeta>(m: T, readmeOn: boolean): T => (readmeOn ? m : { ...m, readme: null });

/** Findings of the full text that are absent without the added part (key — the rule, the field and the position in the field). */
export function addedFindings(full: readonly OpenCheckFinding[], base: readonly OpenCheckFinding[]): OpenCheckFinding[] {
  const key = (f: OpenCheckFinding) => `${f.rule}\u0000${f.field}\u0000${f.at}`;
  const had = new Set(base.map(key));
  return full.filter((f) => !had.has(key(f)));
}

const ORG_README_HINT = "Every employee’s AI agents read “About this space” along with the title and short description of “Company "
  + "knowledge”, so the open check examines them together. Remove the flagged content from “About this space” and save again. The title and short description "
  + "are maintained by the memory administrator";

/**
 * "More about the space" of "Company common knowledge" by a curator. An agent reads it together with the name and
 * org's "what to write here" (memory_list), so all three are checked together — combinations (a full name in the administrator's
 * description and an email in the curator's, in any order) are caught, as elsewhere. A refusal — only for what the curator's
 * text brought: findings absent from the same name and description without it. Findings in the name and description alone are
 * the administrator's (the curator cannot fix them; see the morning report). A list limit could hide the curator's findings
 * behind the administrator's — then the curator's text is also checked alone. Removing the description (null) is always allowed.
 */
async function checkOrgReadme(app: App, caller: Caller, s: SpaceAccess, readme: string | null): Promise<void> {
  if (!readme) return;
  const a: GuardArgs = { via: "space", spaceId: s.id, texts: spaceMetaTexts({ name: s.name, description: s.description, readme }),
                         refusal: (f) => ({ message: `The “Company knowledge” description was not saved because it appears to contain ${openCheckReasons([...f])}`, hint: ORG_README_HINT }) };
  const full = await openCheckOutcome(app, caller, a);
  if (full.unchecked) await refuseOpen(app, caller, a, full);
  if (!full.findings.length) return;
  const base = await openCheckOutcome(app, caller, { ...a, texts: spaceMetaTexts({ name: s.name, description: s.description }) });
  if (base.unchecked) await refuseOpen(app, caller, a, base);
  let added = addedFindings(full.findings, base.findings);
  if (!added.length && openCheckTruncated(full.findings)) {
    const own = await openCheckOutcome(app, caller, { ...a, texts: spaceMetaTexts({ readme }) });
    if (own.unchecked) await refuseOpen(app, caller, a, own);
    added = own.findings;
  }
  if (added.length) await refuseOpen(app, caller, a, { findings: added, unchecked: null });
}

/**
 * The space's name, description and slug — the open class check (via space; closed ones too):
 * a finding — refusal open_check with a hint about the repository, a log event without the class. spaceId — on a rename.
 */
export async function checkSpaceMeta(app: App, caller: Caller, m: SpaceMeta, spaceId: string | null = null): Promise<void> {
  const texts = spaceMetaTexts(m);
  if (texts.length) await guardOpen(app, caller, { via: "space", texts, spaceId });
}

// ---------------------------------------------------------------- creation
/** The limit of spaces a person creates (limits.projects_per_person): an integer from 0, 20 by default. */
export function projectsLimit(app: App): number {
  const n = Math.round(Number(app.settings.get("limits.projects_per_person", 20)));
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

/** The reason of the "never open" rule of the space kind for this slug (an open space is not created with it). */
export async function neverOpenSlug(q: Pick<pg.PoolClient, "query">, instanceId: string, slug: string): Promise<string | null> {
  return (await q.query("SELECT reason FROM never_open_rules WHERE instance_id = $1 AND active AND kind = 'space' AND pattern = $2 LIMIT 1", [instanceId, slug])).rows[0]?.reason ?? null;
}

export interface OwnedSpaceInput extends CreateInput { kind: "team" | "project"; via: "workplace" | "mcp";
  /** Extra for the space_create event: a description by an agent with extended access by permission (extended_open). */
  auditDetails?: Record<string, unknown> }
export interface OwnedSpace { id: string; slug: string; name: string; kind: "team" | "project"; default_class: DataClass; members_added: string[]; members_unknown: string[] }

/**
 * A space the person creates and owns: a project in the workplace (POST /me/spaces) or a closed
 * team space by an agent (memory_space_create). Order: a reserved slug — refusal; the name, description and slug — the
 * open class check before the lock; the limit limits.projects_per_person counts the person's created current
 * spaces (not those they own: an ownership transfer takes no limit) and applies in one transaction
 * with the insert under the per-person lock; a taken slug — a suffix without a race (insertSpace), and the suffix does not
 * lead into a reserved prefix (dep → dep-2 — no); the final slug with a suffix is checked once more before
 * commit. A refusal — neither a space nor a space_create event.
 * Members — only active people with a card, not demo personas: the rest — in members_unknown.
 */
export async function createOwnedSpace(app: App, caller: Caller, a: OwnedSpaceInput): Promise<OwnedSpace> {
  const me = caller.person;
  if (!me) throw notFound();
  const base = a.slug ?? slugify(a.name, a.kind);
  if (reservedSlug(base))
    throw invalid(`slug ${base} is reserved (me, org, u-…, dep-…, demo-…, zz-… — aliases, personal spaces, departments, the showcase, the release check): choose another one`);
  await checkSpaceMeta(app, caller, { name: a.name, description: a.description, readme: a.readme ?? null, slug: base });
  const max = projectsLimit(app);
  // spaces the caller reads now: a slug taken by one of them keeps the numbered suffix, as before; one taken by an
  // archived space gets a random suffix — the safe side, and the map with archived spaces stays in its reviewed places (a guard test)
  const readable = [...(await readableSpaces(app, caller)).values()];
  const visible = readable.map((s) => s.id), visibleSlugs = new Set(readable.map((s) => s.slug));
  const out = await tx(app.db.control, async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext('spaces_by:' || $1))", [me.id]);
    const created = (await q.query(
      `SELECT count(*)::int AS n FROM spaces
       WHERE created_by = $1 AND instance_id = $2 AND kind IN ('team','project') AND org_unit_id IS NULL AND archived_at IS NULL`, [me.id, app.instanceId])).rows[0].n as number;
    if (created >= max) return { limited: created };
    const id = newId();
    // Entities made by a manager before the space existed take a slug too. As with a taken
    // space, we pick a suffix without revealing someone else's name; ensureProjectEntity checks the insert race again.
    const entities = a.kind === "project" ? (await q.query(
      "SELECT external_id, attrs->>'space_id' AS space_id FROM entities WHERE kind = 'project' AND external_system = 'memory' AND (external_id = $1 OR external_id LIKE $2)",
      [base, `${base.slice(0, 56)}-%`])).rows as Array<{ external_id: string; space_id: string | null }> : [];
    const entitySlugs = new Set<string>(entities.map((e) => e.external_id));
    const hidden = new Set<string>((await q.query(
      "SELECT slug FROM spaces WHERE (slug = $1 OR starts_with(slug, $2)) AND NOT (id = ANY($3::uuid[]))",
      [base, `${base.slice(0, 56)}-`, visible])).rows.map((r) => r.slug as string));
    // an entity linked to a space the caller does not see is that hidden project's — random suffix too
    for (const e of entities) if (e.space_id && !visible.includes(e.space_id)) hidden.add(e.external_id);
    const slug = await insertSpace(q, { id, kind: a.kind, name: a.name, description: a.description, readme: a.readme ?? null, owner_id: me.id, instance_id: app.instanceId,
                                        default_class: a.defaultClass, created_by: me.id, created_via: a.via },
                                   projectSlugCandidates(base, entitySlugs, hidden, randomSlugSuffix, visibleSlugs));
    if (!slug) throw invalid(`There is no free slug based on ${base}: choose another one`);
    if (a.kind === "project" && !await ensureProjectEntity(q, { id, slug, name: a.name, instance_id: app.instanceId }, { update: true }))
      throw invalid("This slug is already taken by a project entity: choose another one");
    if (slug !== base) await checkSpaceMeta(app, caller, { slug });
    if (a.defaultClass === "open") { const reason = await neverOpenSlug(q, app.instanceId, slug); if (reason) throw neverOpen(reason); }
    await q.query("INSERT INTO space_members (space_id, person_id, role, added_by, source) VALUES ($1,$2,'owner',$2,'manual')", [id, me.id]);
    const added: string[] = [], unknown: string[] = [];
    for (const login of a.members) {
      const p = (await q.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2 AND active AND COALESCE(attrs->>'demo','') <> 'true'", [login, app.instanceId])).rows[0];
      if (!p) { unknown.push(login); continue; }
      if (p.id !== me.id) await q.query("INSERT INTO space_members (space_id, person_id, role, added_by, source) VALUES ($1,$2,'member',$3,'manual') ON CONFLICT DO NOTHING", [id, p.id, me.id]);
      added.push(login);
    }
    return { id, slug, added, unknown };
  });
  if ("limited" in out)
    throw invalid(`You have already created ${out.limited} spaces (limit ${max}): the administrator archives the ones you do not need and also raises the limit`,
                  { limit: { setting: "limits.projects_per_person", max, created: out.limited } });
  // in the log — the creation fact without the name and description
  await audit(app, caller, { event_type: "admin", space_id: out.id, details: { op: "space_create", slug: out.slug, kind: a.kind, class: a.defaultClass, via: a.via,
                                                                               members: out.added.length, ...(a.via === "mcp" ? { tool: "memory_space_create" } : {}), ...(a.auditDetails ?? {}) } });
  return { id: out.id, slug: out.slug, name: a.name, kind: a.kind, default_class: a.defaultClass, members_added: out.added, members_unknown: out.unknown };
}

/** POST /me/spaces: a project space — only a person in the workplace (not a key, not "on behalf of", not a preview, not demo). */
export async function createProject(app: App, caller: Caller, body: unknown) {
  await requireHuman(app, caller, "Create a project space", PROJECTS);
  if (caller.person!.demo) throw new MemoryError("forbidden", "A showcase demo persona does not create spaces");
  const out = await createOwnedSpace(app, caller, { ...parseCreate(body, { readme: readmeEnabled(app.settings) }), kind: "project", via: "workplace" });
  return { slug: out.slug, path: `/spaces/${out.slug}`, name: out.name, kind: "project" as const, default_class: out.default_class,
           members_added: out.members_added, members_unknown: out.members_unknown };
}

// ---------------------------------------------------------------- card, management, transfer
/**
 * What the owner does not manage alone (null — manages): personal — only theirs, org is run by the administrator, for a
 * department space the members, name and owner are set by the org table (a reconcile would override a manual edit).
 */
export function unmanageableWhy(s: Pick<SpaceAccess, "kind" | "org_unit_id">): string | null {
  if (s.kind === "personal") return "A personal space is yours alone: its name, members and owner do not change";
  if (s.kind === "org") return `The memory administrator manages ${ORG_SPACE_NAME} under “Spaces” in the admin panel`;
  if (s.org_unit_id) return "A department space is run by the org table: its name, members and owner come from it";
  return null;
}

/**
 * A refusal to the owner of an archived space to change members and metadata: an archive only narrows —
 * removing a member, unlinking a group is allowed; adding, linking, "Update now", renaming, transferring — not.
 */
export const archivedManageDenied = (s: Pick<SpaceAccess, "slug" | "archived_at">): MemoryError => {
  const since = s.archived_at ? new Date(s.archived_at).toISOString().slice(0, 10) : null;
  return archivedDenied(s.slug, s.archived_at ?? null,
    `Space ${s.slug} is archived${since ? ` since ${since}` : ""}. You can only reduce its membership by removing a member or unbinding a group. Adding people, binding a group, syncing group membership, renaming or transferring ownership requires restoring the space first. The owner can restore it in “Spaces and projects”, or the memory administrator can restore it.`);
};

/**
 * A space among the readable ones together with archived ones: the owner of an archived one gets the archive refusal, not
 * "not found"; to an outsider an archived one is still not found.
 */
export async function resolveWithArchive(app: App, caller: Caller, ref: string): Promise<SpaceAccess | null> {
  return caller.person ? resolveSpace(app, caller, ref, await readableSpaces(app, caller, { archived: true })) : null;
}

/**
 * A space the caller manages: members, directory groups and the name — the owner role (the owner, a
 * space_owner assignment, a manager). Someone else's and a missing one — not_found, a member and a reader — 403: they
 * know about the space anyway; personal, org and departments — 400 (unmanageableWhy). Archived: `archived` —
 * deny (the default: name, transfer, adding — archivedManageDenied) or narrow (narrowing members — allowed).
 */
export async function managedSpace(app: App, caller: Caller, ref: string, what: string, o: { archived?: "deny" | "narrow"; orgReadme?: boolean } = {}): Promise<SpaceAccess> {
  const s = await resolveWithArchive(app, caller, ref);
  if (!s) throw notFound();
  // "More about the space" of "Company common knowledge": edited by curators — org owners by
  // assignment — and the org owner; only this field: the name and "What to write here" of org are still run by the administrator
  if (o.orgReadme && s.kind === "org") {
    if (s.role !== "owner") throw new MemoryError("forbidden", `Company knowledge curators edit the “${ORG_SPACE_NAME}” description`);
    return s;
  }
  if (s.role !== "owner") throw new MemoryError("forbidden", `To ${what}, you must own space ${s.slug}`);
  const why = unmanageableWhy(s);
  if (why) throw invalid(why);
  if (s.archived_at && o.archived !== "narrow") throw archivedManageDenied(s);
  return s;
}

/**
 * The "How we work" map mark in the space card: `guide_enabled: true` — the administrator turned on
 * the map (`access.space_guide_enabled`), and the workplace puts a "How we work" tab link at the project and team. Off
 * — no field, the card byte for byte as before (like readme of templates). Only an explicit true turns it on, not a panel typo.
 * This is a memory setting, not space data: the mark does not say whether the space has a map.
 */
export const guideCardFlag = (s: { get: <T>(key: string, fallback: T) => T }): { guide_enabled?: true } =>
  (s.get<unknown>(GUIDE_SETTING, false) === true ? { guide_enabled: true } : {});

/**
 * The space card through the caller's eyes (the MySpace schema): role and access basis — from readableSpaces. For the owner —
 * active: dismissal keeps owner_id (the administrator assigns the owner, report spaces_without_owner), and without the mark
 * the workplace would send members to "ask the owner" — a dismissed one. For a department space
 * the owner is the one with an owner row (the current manager or one assigned by the administrator), or a dismissed one:
 * a working removed manager that owner_id still remembers is not named owner by the card.
 */
export async function spaceCard(app: App, s: SpaceAccess) {
  const r = (await app.db.control.query(
    `SELECT s.created_at, s.archived_at, p.login AS owner_login, p.display_name AS owner_name, p.active AS owner_active, u.code AS org_unit,
            ab.login AS archived_by_login, ab.display_name AS archived_by_name,
            (SELECT count(*)::int FROM space_members_effective m WHERE m.space_id = s.id) AS members_count
     FROM spaces s LEFT JOIN people p ON p.id = s.owner_id AND ${OWNER_IN_FORCE_SQL} LEFT JOIN org_units u ON u.id = s.org_unit_id LEFT JOIN people ab ON ab.id = s.archived_by
     WHERE s.id = $1`, [s.id])).rows[0];
  return { slug: s.slug, path: `/spaces/${s.slug}`, name: s.name, description: s.description ?? null,
           // "More about the space" — only with templates on: by the field the workplace knows whether to show the form
           ...(readmeEnabled(app.settings) ? { readme: s.readme ?? null } : {}),
           // the "How we work" map — only when on: by the mark the workplace puts the tab link
           ...guideCardFlag(app.settings),
           kind: s.kind, default_class: s.default_class,
           role: s.role, via: s.via,
           owner: r?.owner_login ? { login: r.owner_login as string, display_name: r.owner_name as string, active: r.owner_active === true } : null,
           org_unit: (r?.org_unit as string | undefined) ?? null, created_at: new Date(r?.created_at ?? Date.now()).toISOString(),
           // archive: since when and who sent it in the workplace (null — the panel, a dismissal, or before archives existed)
           archived_at: r?.archived_at ? new Date(r.archived_at).toISOString() : null,
           archived_by: r?.archived_at && r?.archived_by_login ? { login: r.archived_by_login as string, display_name: r.archived_by_name as string } : null,
           // how many people are members ("Seen by N people"): for a project and a team; personal and common knowledge — null
           members_count: s.kind === "team" || s.kind === "project" ? (r?.members_count as number | undefined) ?? null : null };
}

/**
 * GET /me/spaces/{slug}: to whoever reads the space, archived ones included (a member sees the
 * "in archive" banner); someone else's and a missing one cannot be told apart — not_found.
 */
export async function mySpace(app: App, caller: Caller, ref: string) {
  const s = await resolveWithArchive(app, caller, ref);
  if (!s) throw notFound();
  return spaceCard(app, s);
}

/**
 * PATCH /me/spaces/{slug}: the owner changes the name and description — only a person in the workplace; with templates on —
 * also "More about the space" (readme), for "Company common knowledge" — only it, and curators edit it. If something
 * changed — the name, description and readme are checked whole, as they will be (via space, metaAfterUpdate; readme — only
 * with templates on, ownerMeta; for org — all three together, and a refusal only for what the curator added, checkOrgReadme);
 * a refusal — the old values stay. In the log — which fields, without values.
 */
export async function updateMySpace(app: App, caller: Caller, ref: string, body: unknown) {
  await requireHuman(app, caller, "Edit the space name and description", PROJECTS);
  const patch = parseUpdate(body, { readme: readmeEnabled(app.settings) });
  const onlyReadme = patch.readme !== undefined && patch.name === undefined && patch.description === undefined;
  const s = await managedSpace(app, caller, ref, "edit the name and description", { orgReadme: onlyReadme });
  const changed: SpacePatch = {};
  if (patch.name !== undefined && patch.name !== s.name) changed.name = patch.name;
  if (patch.description !== undefined && patch.description !== (s.description ?? null)) changed.description = patch.description;
  if (patch.readme !== undefined && patch.readme !== (s.readme ?? null)) changed.readme = patch.readme;
  const fields = Object.keys(changed);
  if (fields.length) {
    if (s.kind === "org") await checkOrgReadme(app, caller, s, changed.readme ?? null);
    else await checkSpaceMeta(app, caller, ownerMeta(metaAfterUpdate(s, changed), readmeEnabled(app.settings)), s.id);
    await tx(app.db.control, async (q) => {
      const updated = (await q.query(
        `UPDATE spaces SET name = COALESCE($2, name), description = CASE WHEN $3 THEN $4 ELSE description END, readme = CASE WHEN $5 THEN $6 ELSE readme END
         WHERE id = $1 RETURNING id, slug, name, kind`,
        [s.id, changed.name ?? null, "description" in changed, changed.description ?? null, "readme" in changed, changed.readme ?? null])).rows[0];
      if (updated.kind === "project") await ensureProjectEntity(q, { ...updated, instance_id: app.instanceId }, { update: true });
    });
    await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_update", slug: s.slug, fields, via: s.kind === "org" ? "curator" : "owner" } });
  }
  return mySpace(app, caller, s.slug);
}

/**
 * GET /me/space-readme: whether description templates are on and the blank itself for the workplace forms — "New project",
 * the project "Settings", the curator's "Company common knowledge" description. One blank for gateway and workplace: the gateway
 * also uses it to recognize an untouched template. Only a person in the workplace; no log entry (as /me/show-anyway).
 */
export async function spaceReadmeConfig(app: App, caller: Caller): Promise<{ enabled: boolean; template: string | null; max_chars: number }> {
  await requireHuman(app, caller, "Check whether the template-based space description is enabled", PROJECTS);
  const on = readmeEnabled(app.settings);
  return { enabled: on, template: on ? instanceReadmeTemplate(app.settings) : null, max_chars: README_MAX };
}

/**
 * POST /me/spaces/{slug}/owner: only the space owner (owner_id) transfers, only a person in the workplace. The new
 * owner — an active person with a card, not a demo persona and not the caller; the old one stays a member (member,
 * manual). "I am the owner" is checked once more in the transaction under the space row lock.
 */
export async function transferMySpace(app: App, caller: Caller, ref: string, body: unknown) {
  await requireHuman(app, caller, "Transfer space ownership", PROJECTS);
  const login = parseTransfer(body);
  const s = await managedSpace(app, caller, ref, "Transfer ownership");
  const me = caller.person!;
  const notOwner = () => new MemoryError("forbidden", `Ownership is handed over only by the owner of the space ${s.slug}: an assigned role or managing the department does not give that right`);
  if (s.owner_id !== me.id) throw notOwner();
  const target = (await app.db.control.query(
    "SELECT id, active, COALESCE(attrs->>'demo','') = 'true' AS demo FROM people WHERE login = $1 AND instance_id = $2", [login, app.instanceId])).rows[0];
  if (!target?.active) throw invalid(`${login}: the person is not found in memory or is inactive`);
  if (target.demo) throw invalid(`${login} is a showcase demo persona: it does not become an owner`);
  if (target.id === me.id) throw invalid("You are already the owner of this space");
  await tx(app.db.control, async (q) => {
    const cur = (await q.query("SELECT id, owner_id, archived_at FROM spaces WHERE id = $1 FOR UPDATE", [s.id])).rows[0];
    if (!cur || cur.archived_at) throw notFound();
    if (cur.owner_id !== me.id) throw notOwner();
    if (!(await q.query("SELECT 1 FROM people WHERE id = $1 AND active", [target.id])).rowCount) throw invalid(`${login}: the person is not found in memory or is inactive`);
    await setSpaceOwner(q, cur, target.id);
    // the old owner becomes a member: their manual owner row is lowered by setSpaceOwner, and if there was no row — one is made
    await q.query("INSERT INTO space_members (space_id, person_id, role, added_by, source) VALUES ($1,$2,'member',$2,'manual') ON CONFLICT (space_id, person_id) DO NOTHING", [s.id, me.id]);
  });
  await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_owner_transfer", slug: s.slug, from: me.id, to: target.id, via: "owner" } });
  return mySpace(app, caller, s.slug);
}

// ---------------------------------------------------------------- directory groups: reading links and the reconcile result
/** Directory group links of a space with the reconcile result (the SpaceGroup schema): the panel card and the owner's list. */
export async function spaceGroupsOf(app: App, spaceId: string) {
  const hours = groupStaleHours(ldapConfig(app.settings));
  const { rows } = await app.db.control.query(
    `SELECT g.id, g.group_dn, g.display_name, g.role, g.status, g.members_seen, g.members_matched, g.synced_at, g.missing_since, g.last_error, a.login AS added_by, g.created_at,
            now() AS validity_at,
            (SELECT max(COALESCE(b.synced_at, b.created_at)) FROM space_groups b JOIN spaces s ON s.id = b.space_id
             WHERE b.group_key = g.group_key AND s.instance_id = $2 AND s.kind IN ('team','project') AND s.org_unit_id IS NULL
               AND (s.archived_at IS NULL OR ${archivedWithRecordsSql("s")})) AS verified_at
     FROM space_groups g LEFT JOIN people a ON a.id = g.added_by WHERE g.space_id = $1 ORDER BY g.created_at, g.id`, [spaceId, app.instanceId]);
  const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
  // The cache and expiry are per group key, across its live bindings (including archives with records), as in staleKeys.
  // Keep this binding's own synced_at in the response; only the deadline uses the newest verification of the shared key.
  return rows.map((g) => ({ id: g.id as string, group_dn: g.group_dn as string, display_name: g.display_name as string, role: g.role as "member" | "reader",
                            status: g.status as string, members_seen: g.members_seen ?? null, members_matched: g.members_matched ?? null, synced_at: iso(g.synced_at),
                            missing_since: iso(g.missing_since), last_error: g.last_error ?? null, added_by: g.added_by ?? null, created_at: iso(g.created_at)!,
                            ...groupValidity({ synced_at: g.verified_at ?? g.synced_at, created_at: g.created_at }, hours, new Date(g.validity_at).getTime()) }));
}

/**
 * Group reconcile state (GroupSyncState schema): the last full reconcile result (maintenance_state, key group_sync; written by
 * the group reconcile), the number of links in current spaces and links in a bad state — the group is not in the directory, it is
 * over the limit (members frozen) or a failure. For the morning report and the "Sign-in and LDAP" panel.
 */
export async function groupSyncState(app: App) {
  const ctl = app.db.control;
  const raw = (await ctl.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'group_sync'", [app.instanceId])).rows[0]?.value ?? null;
  const bindings = (await ctl.query(
    "SELECT count(*)::int AS n FROM space_groups g JOIN spaces s ON s.id = g.space_id AND s.instance_id = $1 AND s.archived_at IS NULL", [app.instanceId])).rows[0].n as number;
  const problems = (await ctl.query(
    `SELECT s.slug, s.name, g.display_name, g.status, CASE WHEN g.status = 'missing' THEN g.missing_since ELSE g.synced_at END AS since
     FROM space_groups g JOIN spaces s ON s.id = g.space_id AND s.instance_id = $1 AND s.archived_at IS NULL
     WHERE g.status IN ('missing','too_large','error') ORDER BY s.slug, g.display_name LIMIT 100`, [app.instanceId])).rows;
  return {
    // the group reconcile writes the result; an incomplete or foreign entry (before the first one) — "no reconcile yet"
    last: raw && typeof raw === "object" && typeof raw.at === "string" && typeof raw.ok === "boolean" ? raw : null,
    bindings,
    // name — the space name for people: the panel shows it, the slug — small
    problems: problems.map((p) => ({ slug: p.slug as string, name: (p.name as string | null) ?? p.slug as string, group: p.display_name as string,
                                     status: p.status as "missing" | "too_large" | "error", since: p.since ? new Date(p.since).toISOString() : null })),
  };
}
