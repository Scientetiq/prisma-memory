import { instanceLocale } from "@memory/i18n/context";
import { renderMail, type MailText } from "./mail-render.ts";
import { BUILTIN_OPEN_CHECK_RULES, ndaNameKey, type OpenCheckFinding, type OpenCheckSettings } from "./open-check.ts";
import { openCheckFallback, type FallbackFinding, type OpenCheckFallback } from "./personal-open.ts";

export type OpenRecheckReason = "added" | "full" | "manual" | "held" | "nfd";
export const OPEN_RECHECK_REASONS: readonly OpenRecheckReason[] = ["added", "full", "manual", "held", "nfd"];
export type OpenRecheckHoldState = "pending" | "held" | "kept" | "released" | "on_restore" | "failed" | "gone";
export const OPEN_RECHECK_STATE_KEY = "open_recheck";
export const OPEN_RECHECK_MAX_TRIES = 3;
export const OPEN_RECHECK_RETRY_GAP_MS = 5 * 60_000;
export const OPEN_RECHECK_TAIL_MS = 10 * 60_000;
export const OPEN_RECHECK_BATCH = 100;
export const OPEN_RECHECK_BATCH_RANGE: readonly [number, number] = [10, 1000];

export function openRecheckBatch(v: unknown): number {
  return Number.isInteger(v) && (v as number) >= OPEN_RECHECK_BATCH_RANGE[0] && (v as number) <= OPEN_RECHECK_BATCH_RANGE[1] ? (v as number) : OPEN_RECHECK_BATCH;
}

export function ndaListDiff(baseline: readonly string[], next: readonly unknown[]): { added: string[]; baseline: string[]; removed: number } {
  const before = new Set(baseline), keys = new Map<string, string>();
  for (const n of next) {
    const k = ndaNameKey(n);
    if (k !== null && !keys.has(k)) keys.set(k, (n as string).trim());
  }
  const added = [...keys].filter(([k]) => !before.has(k)).map(([, n]) => n);
  const removed = [...before].filter((k) => !keys.has(k)).length;
  return { added, baseline: [...keys.keys()].sort(), removed };
}

export const ndaBaseline = (list: readonly unknown[]): string[] => ndaListDiff([], list).baseline;

export function ndaStillListed(names: readonly unknown[], current: readonly unknown[]): string[] {
  const now = new Set(current.map(ndaNameKey).filter((k): k is string => k !== null));
  return names.filter((n): n is string => typeof n === "string" && now.has(ndaNameKey(n) ?? "\u0000"));
}

export function ndaOnlySettings(base: Pick<OpenCheckSettings, "timeout_sec">, names: readonly string[]): OpenCheckSettings {
  return { enabled: true, disabled_rules: BUILTIN_OPEN_CHECK_RULES.map((r) => r.name), extra_rules: [], nda_customers: [...names], timeout_sec: base.timeout_sec };
}

export const nfdSettings = (base: OpenCheckSettings): OpenCheckSettings => ({ ...base, enabled: true });

export const NFD_MARKS_RE = /[\u0300-\u036f]/;
export const NFD_MARKS_SQL = "[\u0300-\u036f]";
export const hasNfdMarks = (s: string | null | undefined): boolean => typeof s === "string" && NFD_MARKS_RE.test(s);

export function recheckMark(found: ReadonlyArray<FallbackFinding | OpenCheckFinding>, o: { moveId: string; run: string; unchecked?: boolean; now?: Date }): OpenCheckFallback & { run: string } {
  const base = openCheckFallback("nda_recheck", o.unchecked ? [] : found, { now: o.now });
  const kinds = o.unchecked ? [...new Set([...base.kinds, "unchecked" as const])] : base.kinds;
  return { ...base, kinds, openable: o.unchecked ? false : base.openable, move_id: o.moveId, run: o.run };
}

export const recheckRules = (found: ReadonlyArray<{ rule: string }>): string[] => [...new Set(found.map((f) => String(f.rule)))].sort();
export const recheckKinds = (found: ReadonlyArray<{ kind: string }>): string[] => [...new Set(found.map((f) => String(f.kind)))].sort();

export function recheckFindings(rules: readonly string[], extraRules: ReadonlyArray<{ name?: unknown; kind?: unknown }> = []): OpenCheckFinding[] {
  const builtin = new Map<string, OpenCheckFinding["kind"]>(BUILTIN_OPEN_CHECK_RULES.map((r) => [r.name, r.kind]));
  const extra = new Map<string, OpenCheckFinding["kind"]>();
  for (const r of extraRules) if (typeof r?.name === "string" && typeof r.kind === "string" && RECHECK_KINDS.has(r.kind)) extra.set(r.name, r.kind as OpenCheckFinding["kind"]);
  return [...new Set(rules.map(String))].sort().map((rule) => ({
    rule, kind: rule === "nda" ? "nda" : builtin.get(rule) ?? extra.get(rule) ?? "custom",
    reason: rule === "nda" ? "customer on the strict NDA list" : "recheck finding", field: "text", at: 0 }));
}
const RECHECK_KINDS: ReadonlySet<string> = new Set(["secret", "pii", "money", "contract", "nda", "custom"]);

export const RECHECK_ACTIVE_STATES: readonly OpenRecheckHoldState[] = ["on_restore", "held", "kept"];

export interface RecheckHoldSummary { run: string; found: OpenCheckFinding[]; unchecked: boolean; why: OpenRecheckWhy; rules: string[]; kinds: string[] }
export function recheckHoldSummary(rows: ReadonlyArray<{ run_id: string; rules: string[] | null; why: string | null }>,
  extraRules: ReadonlyArray<{ name?: unknown; kind?: unknown }> = []): RecheckHoldSummary | null {
  if (!rows.length) return null;
  const rules = [...new Set(rows.flatMap((h) => h.rules ?? []))];
  const unchecked = !rules.length && rows.some((h) => h.why === "unchecked");
  const why: OpenRecheckWhy = unchecked ? "unchecked" : rules.includes("nda") ? "nda" : rows.some((h) => h.why === "rules") ? "rules" : "nda";
  const found = recheckFindings(rules, extraRules);
  return { run: rows[0]!.run_id, found, unchecked, why, rules: recheckRules(found), kinds: unchecked ? ["unchecked"] : recheckKinds(found) };
}

type HoldsQuery = { query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null }> };
export async function recheckHoldsToHead(q: HoldsQuery, o: { instanceId: string; head: string; ids: readonly string[]; moveId: string; sum: RecheckHoldSummary;
  spaceId: string | null; ownerId: string | null }): Promise<void> {
  await q.query(`UPDATE open_recheck_holds SET state = 'held', move_id = $3, held_at = COALESCE(held_at, now()), updated_at = now()
                  WHERE instance_id = $1 AND record_id = $2 AND state IN ('on_restore','held','kept')`, [o.instanceId, o.head, o.moveId]);
  const parts = [...new Set(o.ids)].filter((id) => id !== o.head);
  if (!parts.length) return;
  const gone = (await q.query(`UPDATE open_recheck_holds SET state = 'gone', updated_at = now()
                                WHERE instance_id = $1 AND record_id = ANY($2::uuid[]) AND state IN ('on_restore','held','kept')`, [o.instanceId, parts])).rowCount ?? 0;
  if (!gone) return;
  await q.query(
    `INSERT INTO open_recheck_holds (run_id, record_id, instance_id, state, why, kinds, rules, move_id, attempts, space_id, owner_id, held_at)
     VALUES ($1, $2, $3, 'held', $4, $5::text[], $6::text[], $7, 1, $8, $9, now())
     ON CONFLICT (run_id, record_id) DO UPDATE SET state = 'held', why = EXCLUDED.why, kinds = EXCLUDED.kinds, rules = EXCLUDED.rules, move_id = EXCLUDED.move_id,
       space_id = COALESCE(open_recheck_holds.space_id, EXCLUDED.space_id), owner_id = COALESCE(open_recheck_holds.owner_id, EXCLUDED.owner_id),
       held_at = COALESCE(open_recheck_holds.held_at, EXCLUDED.held_at), updated_at = now()`,
    [o.sum.run, o.head, o.instanceId, o.sum.why, o.sum.kinds, o.sum.rules, o.moveId, o.spaceId, o.ownerId]);
}

export type OpenRecheckWhy = "nda" | "rules" | "unchecked";
export function recheckWhyOf(details: Record<string, unknown> | null | undefined): OpenRecheckWhy {
  const w = details?.why;
  if (w === "nda" || w === "rules" || w === "unchecked") return w;
  if (details?.unchecked === true) return "unchecked";
  return details?.reason === "nfd" ? "rules" : "nda";
}

export const OPEN_RECHECK_TEXT = {
  held: "Hidden from agents: the record contains a customer name recently added to the NDA list. People can still see the record. Anything agents read earlier cannot be taken back",
  heldRules: "Hidden from agents: a recheck found content that cannot be written to the open class. People can still see the record",
  unchecked: "Hidden from agents: the NDA recheck could not check the record after three attempts. You can use the usual button to show it to agents after a full check",
} as const;

export const recheckText = (why: OpenRecheckWhy): string => why === "unchecked" ? OPEN_RECHECK_TEXT.unchecked : why === "rules" ? OPEN_RECHECK_TEXT.heldRules : OPEN_RECHECK_TEXT.held;

/**
 * Mail to the administrator — one per run, numbers only (template openRecheck.report, messages/mail-ops.ts), in the
 * instance language. The pass over records saved from a Mac (reason nfd) checks every rule, not the names of the NDA
 * list, and the mail says so. failed — records that were busy on all three attempts: agents still see them, the mail
 * names them too.
 */
export function openRecheckMailText(c: { checked: number; held: number; unchecked: number; onRestore: number; spaces: number; entities: number; failed?: number;
  reason?: OpenRecheckReason }): MailText {
  return renderMail("openRecheck.report", instanceLocale(), c);
}

/** The body of openRecheckMailText. */
export function openRecheckMail(c: Parameters<typeof openRecheckMailText>[0]): string {
  return openRecheckMailText(c).text;
}
