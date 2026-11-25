// The people of a space in the workplace:
//  - everyone who reads the space sees its members: the owner — as before (email, basis, term, groups) and the invited;
//    a project or team member and reader — name, department and role, no email; a department — only the count (members from
//    the org table can be many); for "Company common knowledge" — neither a list nor a count (all employees see it);
//  - call in a colleague with the "member" or "read only" role, including someone who has never signed in to memory: if they are
//    in the company directory, the invitation waits for their first sign-in (access.space_invite_days, 90 days by default) and
//    turns into membership by itself; if it does not, it is removed by itself. Only a person in the workplace; agents still call
//    memory_space_add_member (a full member, only with a card);
//  - the owner changes "Who sees new records" themselves: to "people only" — at once, to "and AI agents" — with the same
//    confirmation and check of name, description and address as on creation. It touches only new records: already
//    saved ones stay as they were. The space_class_change {from, to} event — in the log and in the morning report.
import { invalid, log, MemoryError, neverOpen, notFound, searchTokens, tx, type DataClass } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import type { SpaceAccess } from "./access.ts";
import { audit } from "./audit.ts";
import { lookupDirectory } from "./directory.ts";
import { directoryReject } from "./space-groups.ts";
import { archivedManageDenied, checkSpaceMeta, managedSpace, mySpace, neverOpenSlug, ownerMeta, PROJECTS, resolveWithArchive } from "./spaces.ts";
import { readmeEnabled } from "./space-readme.ts";
import { isHumanSession, requireHuman } from "./workplace.ts";

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
export type MemberRole = "member" | "reader";
const ROLES: readonly MemberRole[] = ["member", "reader"];

/** The invitation term in days (access.space_invite_days): an integer 1–365, 90 by default. */
export function inviteDays(app: App): number {
  const n = Math.round(Number(app.settings.get("access.space_invite_days", 90)));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 90;
}

const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);

/** How many people are members (current membership): the "Seen by N people" header, the space card. */
export async function membersCount(app: App, spaceId: string): Promise<number> {
  return (await app.db.control.query("SELECT count(*)::int AS n FROM space_members_effective WHERE space_id = $1", [spaceId])).rows[0]?.n ?? 0;
}

/**
 * GET /me/spaces/{slug}/members. The owner — all members (email, role, basis, term, directory groups, department and
 * position) and current invitations; a member and reader in the workplace — name, department and role (no email, basis or
 * buttons); a department — just the count, "Company common knowledge" — nothing. Agents and non-owner services — forbidden,
 * as before. Someone else's and a missing one — not_found.
 */
export async function spaceMembersView(app: App, caller: Caller, ref: string) {
  if (!caller.person) throw notFound();
  const s = await resolveWithArchive(app, caller, ref);    // archived too: members can be narrowed, and read too
  if (!s) throw notFound();
  const me = caller.person.id;
  if (s.role === "owner") {
    const { rows } = await app.db.control.query(
      `SELECT p.id, p.login, p.display_name, p.department, p.role AS title, m.role, m.source, m.expires_at,
              COALESCE((SELECT array_agg(DISTINCT g.display_name ORDER BY g.display_name) FROM space_groups g
                        JOIN directory_group_members d ON d.group_key = g.group_key AND d.instance_id = $2 AND d.person_id = m.person_id
                        WHERE g.space_id = m.space_id), '{}') AS groups
       FROM space_members_effective m JOIN people p ON p.id = m.person_id
       WHERE m.space_id = $1 ORDER BY (m.role = 'owner') DESC, p.login`, [s.id, app.instanceId]);
    return {
      view: "owner" as const, count: rows.length,
      members: rows.map((x) => ({ login: x.login as string, display_name: x.display_name as string, role: x.role as string, source: x.source as string,
                                  expires_at: iso(x.expires_at), groups: (x.groups ?? []) as string[], department: (x.department ?? null) as string | null,
                                  title: (x.title ?? null) as string | null, self: x.id === me })),
      invited: await invitesOf(app, s),
    };
  }
  // To a non-owner, the members go only to a person in the workplace and the panel preview: the rule is
  // about what people see on the project page. A member's agent (personal or extended key, OAuth) and a service "on behalf of"
  // get the old refusal: a cloud agent does not gather colleagues' names and departments from all a person's projects — like the
  // people search of the directory (directory.ts), only for the workplace
  if (!isHumanSession(caller) && !caller.preview) throw new MemoryError("forbidden", "The members of a space are visible to its owner");
  if (s.kind === "org") return { view: "count" as const, count: null, members: [] };
  const count = await membersCount(app, s.id);
  if (s.org_unit_id) return { view: "count" as const, count, members: [] };
  // a project or team member and reader: who else will read their records — without email and basis
  const { rows } = await app.db.control.query(
    `SELECT p.id, p.display_name, p.login, p.department, m.role FROM space_members_effective m JOIN people p ON p.id = m.person_id
     WHERE m.space_id = $1 ORDER BY (m.role = 'owner') DESC, p.display_name, p.login`, [s.id]);
  return {
    view: "reader" as const, count,
    // no name (a card without a full name) — "Colleague", not the email: we do not show the email to a member
    members: rows.map((x) => ({ display_name: ((x.display_name as string | null)?.trim() || "Colleague"), department: (x.department ?? null) as string | null,
                                role: x.role as string, self: x.id === me })),
  };
}

/** The space's current invitations (for the owner): expired ones are removed along the way. An archived one — no invitations. */
async function invitesOf(app: App, s: SpaceAccess) {
  await app.db.control.query("DELETE FROM space_invites WHERE space_id = $1 AND expires_at <= now()", [s.id]).catch(() => undefined);
  if (s.archived_at) return [];
  const { rows } = await app.db.control.query(
    "SELECT login, display_name, department, role, created_at, expires_at FROM space_invites WHERE space_id = $1 AND expires_at > now() ORDER BY created_at, login", [s.id]);
  return rows.map((x) => ({ login: x.login as string, display_name: (x.display_name ?? null) as string | null, department: (x.department ?? null) as string | null,
                            role: x.role as MemberRole, invited_at: iso(x.created_at)!, expires_at: iso(x.expires_at)! }));
}

/**
 * A space whose members the person manages: the owner role of a project and a team one (including a department —
 * manual members are added to it by the owner, as memory_space_add_member). Someone else's — not_found, member and reader — 403,
 * personal and common knowledge — 400. An archived one only narrows (`narrow`): remove, cancel an invitation, lower to reader.
 */
async function staffedSpace(app: App, caller: Caller, ref: string, what: string, o: { archived?: "deny" | "narrow" } = {}): Promise<SpaceAccess> {
  const s = await resolveWithArchive(app, caller, ref);
  if (!s) throw notFound();
  if (s.role !== "owner") throw new MemoryError("forbidden", `To ${what}, you must own space ${s.slug}`);
  if (s.kind !== "team" && s.kind !== "project") throw invalid(s.kind === "personal" ? "A personal space is yours alone: it has no members" : "Everyone in the company sees “Company knowledge”: nobody is invited into it");
  if (s.archived_at && o.archived !== "narrow") throw archivedManageDenied(s);
  return s;
}

function loginOf(v: unknown): string {
  const login = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(login) || login.length > 254) throw invalid("login: a colleague's email address");
  return login;
}
function roleOf(v: unknown): MemberRole {
  if (v === undefined || v === null) return "member";
  if (!ROLES.includes(v as MemberRole)) throw invalid("role: member (reads and adds) or reader (only reads)");
  return v as MemberRole;
}

/** Body of POST /me/spaces/{slug}/members: {login, role?}. */
export function parseInvite(b: unknown): { login: string; role: MemberRole } {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid("The request body is {\"login\": a colleague's email address, \"role\": member | reader}");
  const extra = Object.keys(b).filter((k) => k !== "login" && k !== "role");
  if (extra.length) throw invalid(`Extra fields: ${extra.join(", ")} — login and role are allowed`);
  const o = b as Record<string, unknown>;
  return { login: loginOf(o.login), role: roleOf(o.role) };
}

export interface CallOut { status: "added" | "already" | "invited"; login: string; role: MemberRole | "owner"; display_name: string | null; expires_at?: string }

/**
 * POST /me/spaces/{slug}/members — "Call in" in the workplace. With a card — membership at once with the chosen role
 * (an explicit role is set as is: "read only" is not raised to member; the owner's row is kept); no card, but the person is in
 * the company directory — invited until the first sign-in. No directory, or the person is not in it — a refusal in words.
 */
export async function callToSpace(app: App, caller: Caller, ref: string, body: unknown): Promise<CallOut> {
  await requireHuman(app, caller, "Invite a colleague to the space", PROJECTS);
  const { login, role } = parseInvite(body);
  const s = await staffedSpace(app, caller, ref, "invite colleagues");
  const me = caller.person!;
  const p = (await app.db.control.query(
    "SELECT id, display_name, COALESCE(attrs->>'demo','') = 'true' AS demo FROM people WHERE login = $1 AND instance_id = $2 AND active", [login, app.instanceId])).rows[0];
  if (p) {
    if (p.demo) throw invalid("A showcase demo persona does not become a member of a space");
    if (p.id === me.id) throw invalid("You are already the owner of this space");
    // the owner is already in the space (the same as memory_space_add_member): their row does not change
    // in role or source — the owner's membership by org table or assignment does not become manual; the answer — already, owner
    const ownerAlready: CallOut = { status: "already", login, role: "owner", display_name: (p.display_name ?? null) as string | null };
    if (p.id === s.owner_id && !s.org_unit_id) return ownerAlready;
    const r = await tx(app.db.control, async (q) => {
      const ids = [s.id, p.id];
      for (;;) {
        const { rows: [before] } = await q.query<{ role: MemberRole | "owner"; source: string; has_grant_or_expiry: boolean }>(
          `SELECT role, source, (grant_id IS NOT NULL OR expires_at IS NOT NULL) AS has_grant_or_expiry
           FROM space_members WHERE space_id = $1 AND person_id = $2 FOR UPDATE`, ids);
        if (!before) {
          const inserted = await q.query(
            `INSERT INTO space_members (space_id, person_id, role, added_by, source) VALUES ($1,$2,$3,$4,'manual')
             ON CONFLICT (space_id, person_id) DO NOTHING`, [...ids, role, me.id]);
          if (inserted.rowCount) return { role, inserted: true };
          // A concurrent insert won. Read and lock its row before deciding whether to update.
          continue;
        }
        if (before.role === "owner") return null;
        if (before.role === role && before.source === "manual" && !before.has_grant_or_expiry) return { role, inserted: false };
        await q.query(
          "UPDATE space_members SET source = 'manual', grant_id = NULL, expires_at = NULL, role = $3 WHERE space_id = $1 AND person_id = $2",
          [...ids, role]);
        return { role, inserted: false, before };
      }
    });
    if (!r) return ownerAlready;                    // the owner's row (a manager by the org table, an assigned one) — as it was
    await app.db.control.query("DELETE FROM space_invites WHERE space_id = $1 AND login = $2", [s.id, login]).catch(() => undefined);
    if (r.inserted || r.before) {
      await audit(app, caller, { event_type: "admin", space_id: s.id, details: {
        op: "space_member_add", person: p.id, role: r.role, via: "owner", outcome: r.inserted ? "added" : "changed",
        ...(r.before ? { role_before: r.before.role, source_before: r.before.source, source: "manual" } : {}),
      } });
    }
    return { status: r.inserted ? "added" : "already", login, role: r.role, display_name: (p.display_name ?? null) as string | null };
  }
  // no card: the person must be in the company directory — the same search as the "Whom to call in?" hints
  let found: Awaited<ReturnType<typeof lookupDirectory>>;
  try { found = await lookupDirectory(app, searchTokens(login), 10); }
  catch (e) { throw directoryReject(e, "space_invite"); }            // directory down — 503 with a code, as in group search
  if (!found) throw invalid("This person has not signed in to memory yet, and the company directory is not connected: you can invite only someone who has already signed in");
  const hit = found.items.find((h) => h.login.toLowerCase() === login) ?? null;
  if (!hit) throw invalid("There is no such person in memory or in the company directory: check the email address");
  const days = inviteDays(app);
  const row = (await app.db.control.query(
    `INSERT INTO space_invites (space_id, login, instance_id, role, display_name, department, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8))
     ON CONFLICT (space_id, login) DO UPDATE SET role = EXCLUDED.role, display_name = EXCLUDED.display_name, department = EXCLUDED.department,
       invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at
     RETURNING expires_at`, [s.id, login, app.instanceId, role, hit.display_name ?? null, hit.department ?? null, me.id, days])).rows[0];
  // in the log — the fact and the role, without the invitee's email (they have no card yet)
  await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_invite", role, days, via: "owner" } });
  return { status: "invited", login, role, display_name: hit.display_name ?? null, expires_at: iso(row?.expires_at) ?? undefined };
}

/** DELETE /me/spaces/{slug}/invites/{login} — cancel an invitation (in an archive too: it narrows). None — removed: false. */
export async function cancelInvite(app: App, caller: Caller, ref: string, rawLogin: string) {
  await requireHuman(app, caller, "Cancel the invitation", PROJECTS);
  const login = loginOf(rawLogin);
  const s = await staffedSpace(app, caller, ref, "Cancel the invitation", { archived: "narrow" });
  const removed = ((await app.db.control.query("DELETE FROM space_invites WHERE space_id = $1 AND login = $2", [s.id, login])).rowCount ?? 0) > 0;
  if (removed) await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_invite_cancel", via: "owner" } });
  return { login, removed };
}

/**
 * PUT /me/spaces/{slug}/members/{login} {role} — "can add" / "read only" for a manually added membership. Not for
 * the owner or oneself; membership by group, assignment or org table — invalid, naming where it changes. In an archive — only
 * towards "read only" (narrowing). Nothing changes — no event.
 */
export async function setMemberRole(app: App, caller: Caller, ref: string, rawLogin: string, body: unknown) {
  await requireHuman(app, caller, "Change the member’s role", PROJECTS);
  const login = loginOf(rawLogin);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "role")) throw invalid("The request body is {\"role\": member | reader}");
  const role = roleOf((body as { role?: unknown }).role);
  const s = await staffedSpace(app, caller, ref, "change a member’s role", { archived: "narrow" });
  if (s.archived_at && role !== "reader") throw archivedManageDenied(s);
  const p = (await app.db.control.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2", [login, app.instanceId])).rows[0];
  if (!p) throw notFound();
  if (p.id === caller.person!.id) throw invalid("The owner does not change their own role: hand over ownership");
  const out = await tx(app.db.control, async (q) => {
    const cur = (await q.query("SELECT role, source FROM space_members WHERE space_id = $1 AND person_id = $2 FOR UPDATE", [s.id, p.id])).rows[0];
    if (!cur) return { kind: "none" as const };
    if (cur.role === "owner") return { kind: "owner" as const };
    if (cur.source !== "manual") return { kind: "derived" as const, source: cur.source as string };
    if (cur.role === role) return { kind: "same" as const };
    await q.query("UPDATE space_members SET role = $3 WHERE space_id = $1 AND person_id = $2", [s.id, p.id, role]);
    return { kind: "changed" as const, from: cur.role as string };
  });
  if (out.kind === "none") throw notFound();
  if (out.kind === "owner") throw invalid("The owner's role does not change: hand over ownership");
  if (out.kind === "derived")
    throw invalid(out.source === "group" ? "The role of a member through a directory group is set by the group link: “can add” or “read only”"
      : out.source === "grant" ? "A role by assignment is changed by the memory administrator" : "Membership through the org table changes in the org table");
  if (out.kind === "changed") await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_member_role", person: p.id, from: out.from, to: role, via: "owner" } });
  return { login, role };
}

/**
 * A card appeared (first sign-in via the directory or the identity provider, an org table upload): invitations by its login become
 * membership with the role the owner chose (`manual`, added by — the inviter). Expired ones are removed; a space in
 * an archive — the invite waits for its return (an archive gets no new members). A failure is only logged; sign-in goes on.
 */
export async function grantSpaceInvites(app: App, people: Array<{ id: string; login: string }>, via: string): Promise<number> {
  const idOf = new Map(people.map((p) => [p.login.toLowerCase(), p.id]));
  if (!idOf.size) return 0;
  try {
    const joined = await tx(app.db.control, async (q) => {
      await q.query("DELETE FROM space_invites WHERE login = ANY($1::text[]) AND expires_at <= now()", [[...idOf.keys()]]);
      const rows = (await q.query(
        `SELECT i.space_id, i.login, i.role, i.invited_by FROM space_invites i JOIN spaces s ON s.id = i.space_id AND s.instance_id = $2
           AND s.archived_at IS NULL AND s.kind IN ('team','project')
         WHERE i.login = ANY($1::text[]) AND i.instance_id = $2 ORDER BY i.space_id, i.login FOR UPDATE OF i`, [[...idOf.keys()], app.instanceId])).rows;
      const out: Array<{ space_id: string; person: string; role: string }> = [];
      for (const r of rows) {
        const person = idOf.get(String(r.login))!;
        await q.query(
          `INSERT INTO space_members (space_id, person_id, role, added_by, source) VALUES ($1,$2,$3,$4,'manual')
           ON CONFLICT (space_id, person_id) DO NOTHING`, [r.space_id, person, r.role, r.invited_by ?? null]);
        await q.query("DELETE FROM space_invites WHERE space_id = $1 AND login = $2", [r.space_id, r.login]);
        out.push({ space_id: r.space_id as string, person, role: r.role as string });
      }
      return out;
    });
    for (const j of joined) await audit(app, null, { event_type: "admin", space_id: j.space_id, details: { op: "space_invite_joined", person: j.person, role: j.role, via } });
    return joined.length;
  } catch (e) {
    log.warn("space_invite_grant_failed", { via, error: (e as Error).message.slice(0, 200) });
    return 0;
  }
}

// ---------------------------------------------------------------- "Who sees new records"
/** Body of POST /me/spaces/{slug}/class: {default_class, open_ack?}; to "and AI agents" — only with open_ack: true. */
export function parseClassChange(b: unknown): { to: DataClass } {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid("The request body is {\"default_class\": open | closed, \"open_ack\": true}");
  const o = b as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "default_class" && k !== "open_ack");
  if (extra.length) throw invalid(`Extra fields: ${extra.join(", ")} — default_class and open_ack are allowed`);
  if (o.default_class !== "open" && o.default_class !== "closed") throw invalid("default_class: open or closed");
  if (o.open_ack !== undefined && typeof o.open_ack !== "boolean") throw invalid("open_ack: true or false");
  if (o.default_class === "open" && o.open_ack !== true)
    throw invalid("Confirm that you understand the consequences: the space's new records will be read by the members' cloud agents on external models (open_ack: true)");
  return { to: o.default_class };
}

/**
 * POST /me/spaces/{slug}/class — the owner of a project or a team without a department, only a person in the workplace (the class
 * is opened by a person), not archived. To "people only" — at once; to "and AI agents" — with confirmation, checking the name,
 * description, address and — with templates on — "More about the space" (as on creation) and the
 * "never open" rule for the address. Already saved records do not change.
 * Repeating the same — the card without an event.
 */
export async function changeSpaceClass(app: App, caller: Caller, ref: string, body: unknown) {
  await requireHuman(app, caller, "Change who can see new records in this space", PROJECTS);
  const { to } = parseClassChange(body);
  const s = await managedSpace(app, caller, ref, "change who can see new records");
  if (s.default_class === to) return mySpace(app, caller, s.slug);
  if (to === "open") await checkSpaceMeta(app, caller, ownerMeta({ name: s.name, description: s.description, readme: s.readme, slug: s.slug }, readmeEnabled(app.settings)), s.id);
  const from = await tx(app.db.control, async (q) => {
    const cur = (await q.query("SELECT default_class, archived_at FROM spaces WHERE id = $1 FOR UPDATE", [s.id])).rows[0];
    if (!cur || cur.archived_at) throw notFound();
    if (cur.default_class === to) return null;
    if (to === "open") { const reason = await neverOpenSlug(q, app.instanceId, s.slug); if (reason) throw neverOpen(reason); }
    await q.query("UPDATE spaces SET default_class = $2 WHERE id = $1", [s.id, to]);
    return cur.default_class as DataClass;
  });
  if (from) await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_class_change", slug: s.slug, from, to, via: "owner" } });
  return mySpace(app, caller, s.slug);
}
