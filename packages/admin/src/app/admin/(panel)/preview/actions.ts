"use server";
import { TEXT } from "@/messages/panel-preview";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor, redirectAuditor } from "@/lib/admin-guard";
import { gw, tryGw } from "@/lib/api";
import { DEMO_PEOPLE, DEMO_ROLE_TITLES, DEMO_SAMPLES, DEMO_SPACE, demoPeopleBody, type DemoRole } from "@/lib/demo";
import { GatewayError } from "@/lib/gateway";
import { callTool } from "@/lib/mcp";
import { PREVIEW_OPS } from "@/lib/preview";
import { setPreviewCookies } from "@/lib/user-session";
import { CLASS_TITLES } from "@/lib/labels";
import type { KeyIssueResponse, ListResult, Me, Page, PeopleUpsertResponse, Person, Space, SpaceDetail, WriteResult } from "@/lib/types";
import { setAdminView } from "@/lib/view-as";
import { webRole } from "@/lib/web-role";
import { workplaceHome } from "@/lib/workplace-home";

const PREVIEW_TTL_SEC = 3600;
const FILL_TTL_SEC = 600;

export async function findDemoPeople(): Promise<Partial<Record<DemoRole, Person>>> {
  const res = await tryGw<Page<Person>>("/api/v1/admin/people", { query: { q: "demo.", limit: 50 } });
  const out: Partial<Record<DemoRole, Person>> = {};
  if (!res.ok) return out;
  for (const p of res.data.items) {
    if (p.attrs?.demo !== true || !p.active) continue;
    const role = p.attrs.demo_role === "head" ? "head" : p.attrs.demo_role === "employee" ? "employee" : null;
    if (role) out[role] = p;
  }
  return out;
}

async function issueViewKey(login: string): Promise<KeyIssueResponse> {
  return gw<KeyIssueResponse>("/api/v1/admin/keys", {
    method: "POST",
    body: { kind: "personal", principal: login, preview: true, ops_override: [...PREVIEW_OPS], expires_at: new Date(Date.now() + PREVIEW_TTL_SEC * 1000).toISOString() },
  });
}

async function issueFillKey(login: string): Promise<KeyIssueResponse> {
  return gw<KeyIssueResponse>("/api/v1/admin/keys", {
    method: "POST",
    body: { kind: "personal", principal: login, preview: true, expires_at: new Date(Date.now() + FILL_TTL_SEC * 1000).toISOString() },
  });
}

const revokeKey = async (id: string): Promise<void> => { await tryGw(`/api/v1/admin/keys/${encodeURIComponent(id)}`, { method: "DELETE" }); };

export async function switchViewAction(formData: FormData): Promise<void> {
  const view = String(formData.get("view") ?? "");
  if (view === "auditor") { await setAdminView("auditor"); redirect("/admin/audit"); }
  if (view === "admin") { await setAdminView("admin"); redirect("/admin"); }
  if (view !== "head" && view !== "employee") redirect("/admin");
  await redirectAuditor();
  const people = await findDemoPeople();
  const person = people[view];
  if (!person) redirect(`/admin/preview?missing=${view}`);
  let issued: KeyIssueResponse;
  try { issued = await issueViewKey(person.login); }
  catch (e) { if (e instanceof GatewayError) redirect(`/admin/preview?error=${encodeURIComponent(e.message)}`); throw e; }
  await setPreviewCookies(issued.secret, { key_id: issued.key.id, login: person.login, persona: person.display_name, role: view }, PREVIEW_TTL_SEC);
  const role = webRole();
  let home = "/";
  if (role === "panel") {
    const settings = await tryGw<{ items: Array<{ category: string; key: string; value: unknown }> }>("/api/v1/admin/settings");
    home = workplaceHome(role, settings.ok ? settings.data.items.find((i) => i.category === "access" && i.key === "workplace_url")?.value : null);
  }
  redirect(home);
}

async function ensureShowcaseSpace(): Promise<{ slug: string | null; line: string }> {
  const found = await tryGw<SpaceDetail>(`/api/v1/admin/spaces/${DEMO_SPACE.slug}`);
  if (!found.ok && found.status !== 404) return { slug: null, line: TEXT.showcaseSpaceWasNotVerified(String(found.message)) };
  const existing = found.ok ? { slug: found.data.slug, default_class: found.data.default_class ?? "open" } : null;
  if (existing) {
    const m = await tryGw<{ added: number }>(`/api/v1/admin/spaces/${DEMO_SPACE.slug}/members`, { method: "PUT", body: { add: [{ login: DEMO_PEOPLE.employee.login, role: "member" }], remove: [] } });
    return { slug: existing.slug, line: TEXT.showcaseSpaceAlreadyExistsData(String(existing.slug), String(CLASS_TITLES[existing.default_class] ?? existing.default_class), String(m.ok && m.data.added ? TEXT.demoEmployeeSMembershipWasRestored : "")) };
  }
  const created = await tryGw<Space>("/api/v1/admin/spaces", { method: "POST", body: { kind: "team", slug: DEMO_SPACE.slug, name: DEMO_SPACE.name, description: DEMO_SPACE.description, owner: DEMO_PEOPLE.head.login, members: [DEMO_PEOPLE.employee.login], default_class: "open" } });
  if (!created.ok) return { slug: null, line: TEXT.showcaseSpaceWasNotCreated(String(created.message)) };
  return { slug: created.data.slug, line: TEXT.showcaseSpaceCreatedDataMembersIncludingTheOwner(String(created.data.slug), String(CLASS_TITLES[created.data.default_class] ?? created.data.default_class), String(created.data.members_count)) };
}

async function writeSamples(keys: Partial<Record<DemoRole, KeyIssueResponse>>, showcaseSlug: string | null, lines: string[]): Promise<void> {
  let written = 0, skipped = 0;
  for (const s of DEMO_SAMPLES) {
    const key = keys[s.who]?.secret;
    if (!key) { skipped++; continue; }
    const space = s.space === "showcase" && showcaseSlug ? showcaseSlug : "me";
    const res = s.kind === "upload"
      ? await callTool<WriteResult>(key, "memory_upload", { filename: s.filename, mime: "text/markdown", content_base64: Buffer.from(s.text, "utf8").toString("base64"), space, title: s.title })
      : await callTool<WriteResult>(key, "memory_remember", { text: s.text, title: s.title, space, kind: s.eventKind ?? "note", origin: "human" });
    if (!res.ok) { skipped++; lines.push(TEXT.couldNotSave(String(s.title), String(res.message))); continue; }
    if (res.data.already_known) skipped++; else written++;
  }
  lines.push(TEXT.sampleMaterialsSaved(String(written), String(skipped ? TEXT.skippedAlreadyPresentOrRejected(String(skipped)) : "")));
}

export async function createShowcaseAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const lines: string[] = [];
  let upsert: PeopleUpsertResponse;
  try { upsert = await gw<PeopleUpsertResponse>("/api/v1/admin/people", { method: "PUT", body: demoPeopleBody(), timeoutMs: 120_000 }); }
  catch (e) { if (e instanceof GatewayError) return failState(TEXT.demoPersonasWereNotCreated(String(e.message))); throw e; }
  if (upsert.errors?.length) return failState(TEXT.theGatewayRejectedTheDemoPersonas, { lines: upsert.errors.map((e) => TEXT.personFailure(e.login, e.message)) });
  lines.push(TEXT.demoPersonasCreatedUpdatedDepartmentSpacesCreated(String(upsert.created), String(upsert.updated), String(upsert.access?.spaces_created.length ?? 0)));
  const showcase = await ensureShowcaseSpace();
  lines.push(showcase.line);

  const keys: Partial<Record<DemoRole, KeyIssueResponse>> = {};
  try {
    for (const role of ["head", "employee"] as DemoRole[]) keys[role] = await issueFillKey(DEMO_PEOPLE[role].login);
    if (!showcase.slug) lines.push(TEXT.withoutAShowcaseSpaceSampleMaterialsWereSaved);
    await writeSamples(keys, showcase.slug, lines);
  } finally {
    for (const k of Object.values(keys)) if (k) await revokeKey(k.key.id);
  }
  return okState(TEXT.showcaseReadySwitchThroughPreviewHeadEmployee, { lines });
}

export async function rebuildShowcaseAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const people = await findDemoPeople();
  if (!people.head || !people.employee) return failState(TEXT.noDemoPersonasCreateTheShowcaseFirst);
  const lines: string[] = [];
  const showcase = await ensureShowcaseSpace();
  lines.push(showcase.line);

  const keys: Partial<Record<DemoRole, KeyIssueResponse>> = {};
  try {
    for (const role of ["head", "employee"] as DemoRole[]) keys[role] = await issueFillKey(DEMO_PEOPLE[role].login);
    let deleted = 0, failed = 0;
    for (const role of ["head", "employee"] as DemoRole[]) {
      const key = keys[role]!.secret;
      for (const id of await demoRecordIds(key)) {
        const res = await callTool<{ id: string }>(key, "memory_delete", { id });
        if (res.ok) deleted++; else failed++;
      }
    }
    lines.push(TEXT.demoPersonaRecordsMovedToTrash(String(deleted), String(failed ? TEXT.failedAPersonaCannotDeleteSomeoneElseS(String(failed)) : "")));
    await writeSamples(keys, showcase.slug, lines);
  } finally {
    for (const k of Object.values(keys)) if (k) await revokeKey(k.key.id);
  }
  return okState(TEXT.showcaseRebuilt, { lines });
}

const MAX_LIST_CALLS = 60;

async function demoRecordIds(key: string): Promise<string[]> {
  const me = await callTool<Me>(key, "memory_me", {}, 20_000);
  const queue = (me.ok ? me.data.spaces.filter((s) => s.kind !== "org").map((s) => s.slug) : [DEMO_SPACE.slug]).map((slug) => `/spaces/${slug}`);
  const seen = new Set<string>(queue);
  const ids = new Set<string>();
  let calls = 0;

  while (queue.length && calls < MAX_LIST_CALLS) {
    const path = queue.shift()!;
    let cursor = "";
    do {
      calls++;
      const res = await callTool<ListResult>(key, "memory_list", { path, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!res.ok) break;
      for (const e of res.data.entries) {
        if (e.kind === "folder") { if (!seen.has(e.path)) { seen.add(e.path); queue.push(e.path); } continue; }
        const id = e.id ?? e.path.split("/").pop() ?? "";
        if (/^[0-9a-f-]{36}$/i.test(id)) ids.add(id);
      }
      cursor = res.data.next_cursor ?? "";
    } while (cursor && calls < MAX_LIST_CALLS);
  }
  return [...ids];
}

export const previewRoleTitle = async (role: DemoRole): Promise<string> => DEMO_ROLE_TITLES[role];
