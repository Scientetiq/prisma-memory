import { colleagues as M } from "../messages/colleagues";
import type { McpFail, McpResult } from "./mcp-parse";
import type { ListResult } from "./types";
import { publicCopyName } from "./work-profile";




export const PEOPLE_PAGE = 50;


export const PEOPLE_FILL_CALLS = 4;
export const peopleNotFound = (q: string): string => M.noOneFoundForCheckTheSpelling(q);
export const peopleMore = (shown: number): string => M.showingTheFirstRefineYourSearchTo(shown);



export const peopleQuery = (raw: string | null | undefined): string => (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

export const peopleSearchArgs = (org: string, q: string) =>
  ({ query: q, mode: "keyword" as const, filters: { space: org, types: ["profile"] }, limit: PEOPLE_PAGE });

export const peopleListArgs = (org: string, cursor?: string | null, limit: number = PEOPLE_PAGE) =>
  ({ path: `/spaces/${org}/profile`, limit, ...(cursor ? { cursor } : {}) });

export interface PersonRow { id: string; name: string; role: string | null; department: string | null; about?: true }

const DEPT = /Department:\s*([^·\n]+)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRecordId = (s: string | null | undefined): s is string => Boolean(s && UUID.test(s));

export function personRow(r: { id?: string | null; path?: string; title?: string | null; summary_line?: string | null; snippet?: string | null }): PersonRow | null {
  const id = r.id ?? r.path?.split("/").pop() ?? null;
  if (!isRecordId(id)) return null;
  const [name, ...rest] = (r.title ?? "").split(" — ");
  const role = rest.join(" — ").trim() || null;
  let department: string | null = null;
  if (r.summary_line) {
    const head = `${role ?? "colleague"}, `, cut = r.summary_line.lastIndexOf(", ");
    department = (r.summary_line.startsWith(head) ? r.summary_line.slice(head.length) : cut >= 0 ? r.summary_line.slice(cut + 2) : "").trim() || null;
  } else if (r.snippet) department = DEPT.exec(r.snippet)?.[1]?.trim() || null;
  if (department === "—") department = null;
  return { id, name: name?.trim() || M.unnamed, role, department };
}

export function peopleRows(items: ReadonlyArray<Parameters<typeof personRow>[0] & { kind?: string; hidden?: boolean }>, copies: "skip" | "fallback"): PersonRow[] {
  const cards: PersonRow[] = [], about: PersonRow[] = [], order: PersonRow[] = [], seen = new Set<string>();
  for (const it of items) {
    if (it.kind === "folder" || it.hidden) continue;
    const copyName = publicCopyName(it.title);
    const p = personRow(it);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    if (copyName !== null) {
      if (copies === "skip") continue;
      const row: PersonRow = { id: p.id, name: copyName, role: null, department: null, about: true };
      about.push(row); order.push(row);
    } else { cards.push(p); order.push(p); }
  }
  const named = new Set(cards.map((c) => c.name.toLowerCase()));
  return order.filter((r) => !r.about || !named.has(r.name.toLowerCase()));
}

export async function peopleListPage(org: string, cursor: string | null | undefined,
                                     list: (args: ReturnType<typeof peopleListArgs>) => Promise<McpResult<Pick<ListResult, "entries" | "next_cursor">>>,
): Promise<{ rows: PersonRow[]; next: string | null; failed: McpFail | null }> {
  let rows: PersonRow[] = [], at: string | null = cursor || null;
  for (let call = 1; ; call++) {
    const res = await list(peopleListArgs(org, at, PEOPLE_PAGE - rows.length));
    if (!res.ok) return call === 1 ? { rows: [], next: null, failed: res } : { rows, next: at, failed: null };
    const entries = res.data.entries ?? [];
    rows = rows.concat(peopleRows(entries, "skip"));
    at = res.data.next_cursor ?? null;
    const copies = entries.some((e) => e.kind !== "folder" && publicCopyName(e.title) !== null);
    if (!at || !copies || rows.length >= PEOPLE_PAGE || call >= PEOPLE_FILL_CALLS) return { rows, next: at, failed: null };
  }
}

export const personRecordsHref = (cardId: string, q?: string): string =>
  `/colleagues?card=${encodeURIComponent(cardId)}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

export const peopleBackHref = (q?: string | null): string => (q ? `/colleagues?q=${encodeURIComponent(q)}` : "/colleagues");

export { colleagues as COLLEAGUES_MESSAGES } from "../messages/colleagues";
