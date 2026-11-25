import { log } from "./log.ts";
import { titleRuleRe } from "./record-text.ts";
import { BUILTIN_OPEN_CHECK_RULES, OPEN_CHECK_MAX_FINDINGS, openCheckReasons, type OpenCheckFinding, type OpenCheckKind, type OpenCheckSettings } from "./open-check.ts";

export type FallbackKind = OpenCheckKind | "never_open" | "unchecked";
export type FallbackUnchecked = "empty_text" | "partial_text";
const FALLBACK_UNCHECKED: ReadonlySet<string> = new Set<FallbackUnchecked>(["empty_text", "partial_text"]);
const UNCHECKED_WHY: Record<FallbackUnchecked, string> = {
  empty_text: "no text was extracted, so there is nothing to check",
  partial_text: "some pages are scans and could not be checked",
};
const UNCHECKED_SHORT: Record<FallbackUnchecked, string> = { empty_text: "no text extracted", partial_text: "some pages are scans" };
export type FallbackVia = "remember" | "upload" | "convert" | "nda_recheck";
export type PublicFallbackVia = Exclude<FallbackVia, "nda_recheck">;
export const publicVia = (via: FallbackVia): PublicFallbackVia | undefined => (via === "nda_recheck" ? undefined : via);

export interface FallbackFinding { rule: string; kind: FallbackKind; reason: string; field: string; at?: number }

export interface OpenCheckFallback {
  at: string; via: FallbackVia; kinds: FallbackKind[]; rules: string[]; findings: FallbackFinding[];
  openable: boolean; text_checked: boolean; unchecked?: FallbackUnchecked; move_id?: string; tries?: number;
}

export interface OpenCheckView {
  result: "passed" | "closed" | "pending"; via?: PublicFallbackVia; at?: string; kinds?: FallbackKind[]; findings?: FallbackFinding[];
  openable?: boolean; by_word?: boolean; text_checked?: boolean; unchecked?: FallbackUnchecked;
}

/** Reasons of `conversion.agent_file_why` that mean the document holds pictures nobody read as text (converter.ts, AgentFileWhy). */
const UNREAD_MEDIA_WHY: ReadonlySet<string> = new Set(["images", "pictures_skipped"]);

/**
 * The open check reads text only: true when part of the record was not checked — scanned pages without a text
 * layer (`unchecked`: partial_text / empty_text) or pictures in the document (`conversion.agent_file_why`: images,
 * pictures_skipped). Unknown or damaged input — false. A statement for people, not a gate: it changes no decision.
 */
export function uncheckedMedia(conversion: unknown, unchecked?: FallbackUnchecked | null): boolean {
  if (unchecked === "partial_text" || unchecked === "empty_text") return true;
  if (!conversion || typeof conversion !== "object" || Array.isArray(conversion)) return false;
  const why = (conversion as Record<string, unknown>).agent_file_why;
  return Array.isArray(why) && why.some((w) => typeof w === "string" && UNREAD_MEDIA_WHY.has(w));
}

export type ByWordConfirmation = "agent_relayed" | "human_workplace";

export interface OpenCheckAccepted { move_id: string; rules: string[]; at: string; confirmation: ByWordConfirmation; text_only?: true; scope?: "solo" | "shared" }

export const NOT_OPENABLE_KINDS: ReadonlySet<FallbackKind> = new Set<FallbackKind>(["secret", "nda", "custom", "never_open", "unchecked"]);
export const OPENABLE_BY_WORD_KINDS: ReadonlySet<string> = new Set(["pii", "contract", "money"]);

export function ruleOpenableByWord(rule: string): boolean {
  const r = BUILTIN_OPEN_CHECK_RULES.find((x) => x.name === rule);
  return !!r && OPENABLE_BY_WORD_KINDS.has(r.kind);
}

export function acceptedReasons(rules: readonly string[]): string[] {
  return [...new Set(rules.map((n) => BUILTIN_OPEN_CHECK_RULES.find((r) => r.name === n)?.reason).filter((x): x is string => !!x))];
}

export function acceptedKinds(rules: readonly string[]): OpenCheckKind[] {
  return [...new Set(rules.map((n) => BUILTIN_OPEN_CHECK_RULES.find((r) => r.name === n)?.kind).filter((x): x is OpenCheckKind => !!x))];
}

export function acceptedSettings(s: OpenCheckSettings, rules: readonly string[]): OpenCheckSettings {
  const off = new Set(s.disabled_rules);
  for (const r of rules) if (ruleOpenableByWord(r)) off.add(r);
  return { ...s, disabled_rules: [...off].sort() };
}

export function openableByWord(mark: Pick<OpenCheckFallback, "openable" | "kinds" | "rules">): boolean {
  return mark.openable && mark.kinds.length > 0 && mark.kinds.every((k) => OPENABLE_BY_WORD_KINDS.has(k))
    && mark.rules.length > 0 && mark.rules.every(ruleOpenableByWord);
}

const STRICT_KINDS: ReadonlySet<string> = new Set(["secret", "nda", "custom"]);

export function strictOpenCheckSettings(s: OpenCheckSettings): OpenCheckSettings {
  const off = new Set(s.disabled_rules);
  for (const r of BUILTIN_OPEN_CHECK_RULES) if (!STRICT_KINDS.has(r.kind)) off.add(r.name);
  return { ...s, disabled_rules: [...off], extra_rules: (Array.isArray(s.extra_rules) ? s.extra_rules : []).filter((r) => STRICT_KINDS.has(r.kind)) };
}

export const openCheckTruncated = (findings: readonly unknown[]): boolean => findings.length >= OPEN_CHECK_MAX_FINDINGS;

const clean = (f: FallbackFinding | OpenCheckFinding): FallbackFinding =>
  ({ rule: String(f.rule), kind: f.kind as FallbackKind, reason: String(f.reason), field: String(f.field), ...(typeof f.at === "number" && f.at >= 0 ? { at: Math.floor(f.at) } : {}) });

export function openCheckFallback(via: FallbackVia, found: ReadonlyArray<FallbackFinding | OpenCheckFinding>,
  opts: { strict?: ReadonlyArray<FallbackFinding | OpenCheckFinding> | null; textChecked?: boolean; unchecked?: FallbackUnchecked; now?: Date } = {}): OpenCheckFallback {
  const findings = found.slice(0, OPEN_CHECK_MAX_FINDINGS).map(clean);
  const truncated = openCheckTruncated(found);
  const kinds = new Set<FallbackKind>(findings.map((f) => f.kind)), rules = new Set(findings.map((f) => f.rule));
  if (truncated && opts.strict) for (const f of opts.strict) { kinds.add(f.kind as FallbackKind); rules.add(String(f.rule)); }
  if (opts.unchecked) kinds.add("unchecked");
  const openable = ![...kinds].some((k) => NOT_OPENABLE_KINDS.has(k)) && !(truncated && !opts.strict);
  return { at: (opts.now ?? new Date()).toISOString(), via, kinds: [...kinds], rules: [...rules], findings, openable,
           text_checked: opts.textChecked !== false, ...(opts.unchecked ? { unchecked: opts.unchecked } : {}) };
}

const FALLBACK_VIAS = new Set(["remember", "upload", "convert", "nda_recheck"]);

export function parseOpenCheckFallback(raw: unknown): OpenCheckFallback | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.via !== "string" || !FALLBACK_VIAS.has(m.via) || !Array.isArray(m.findings)) return null;
  const findings = (m.findings as unknown[]).filter((f): f is FallbackFinding => !!f && typeof f === "object" && typeof (f as FallbackFinding).rule === "string")
    .slice(0, OPEN_CHECK_MAX_FINDINGS).map(clean);
  return {
    at: typeof m.at === "string" ? m.at : new Date(0).toISOString(), via: m.via as FallbackVia,
    kinds: Array.isArray(m.kinds) ? (m.kinds as unknown[]).map(String) as FallbackKind[] : [...new Set(findings.map((f) => f.kind))],
    rules: Array.isArray(m.rules) ? (m.rules as unknown[]).map(String) : [...new Set(findings.map((f) => f.rule))],
    findings, openable: m.openable === true, text_checked: m.text_checked !== false,
    ...(typeof m.unchecked === "string" && FALLBACK_UNCHECKED.has(m.unchecked) ? { unchecked: m.unchecked as FallbackUnchecked } : {}),
    ...(typeof m.move_id === "string" ? { move_id: m.move_id } : {}), ...(typeof m.tries === "number" ? { tries: m.tries } : {}),
  };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(["secret", "pii", "money", "contract", "nda", "custom", "never_open", "unchecked"]);

export function parseOpenCheckMarkStrict(raw: unknown): OpenCheckFallback | null {
  const mark = parseOpenCheckFallback(raw);
  if (!mark || !raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (!Array.isArray(m.kinds) || !Array.isArray(m.rules) || !Array.isArray(m.findings) || typeof m.openable !== "boolean") return null;
  if (!(m.kinds as unknown[]).every((k) => typeof k === "string" && KNOWN_KINDS.has(k))) return null;
  if (!(m.rules as unknown[]).every((r) => typeof r === "string" && r.length > 0 && r.length <= 100)) return null;
  if (!(m.findings as unknown[]).every((f) => !!f && typeof f === "object" && KNOWN_KINDS.has(String((f as FallbackFinding).kind)) && typeof (f as FallbackFinding).rule === "string")) return null;
  const emptyText = !!mark.unchecked && mark.kinds.includes("unchecked");
  if ((!mark.findings.length || !mark.rules.length) && !emptyText) return null;
  return mark;
}

export function parseOpenCheckAccepted(raw: unknown): OpenCheckAccepted | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.move_id !== "string" || !Array.isArray(m.rules) || (m.confirmation !== "agent_relayed" && m.confirmation !== "human_workplace")) return null;
  return { move_id: m.move_id, rules: (m.rules as unknown[]).map(String), at: typeof m.at === "string" ? m.at : new Date(0).toISOString(), confirmation: m.confirmation,
           ...(m.text_only === true ? { text_only: true as const } : {}), ...(m.scope === "solo" || m.scope === "shared" ? { scope: m.scope } : {}) };
}

export function openCheckView(mark: OpenCheckFallback, o: { reachable?: boolean; foreign?: boolean } = {}): OpenCheckView {
  if (o.foreign) return { result: "closed", at: mark.at, by_word: false };
  const via = publicVia(mark.via);
  return { result: "closed", ...(via ? { via } : {}), at: mark.at, kinds: mark.kinds, findings: mark.findings, openable: mark.openable, by_word: openableByWord(mark) && o.reachable !== false,
           text_checked: mark.text_checked, ...(mark.unchecked ? { unchecked: mark.unchecked } : {}) };
}

export const openCheckViewOf = (raw: unknown, o: { reachable?: boolean; foreign?: boolean } = {}): OpenCheckView | null => { const m = parseOpenCheckFallback(raw); return m ? openCheckView(m, o) : null; };

const where = (f: FallbackFinding): string => `field ${f.field}${typeof f.at === "number" ? `, position ${f.at}` : ""}`;

export function openCheckWhy(mark: Pick<OpenCheckFallback, "findings" | "unchecked">, max = 3): string {
  const parts: string[] = [];
  const content = mark.findings.filter((f) => f.kind !== "never_open"), never = mark.findings.filter((f) => f.kind === "never_open");
  if (content.length) {
    const seen = new Set<string>(), items: string[] = [];
    for (const f of content) {
      if (seen.has(f.reason)) continue;
      seen.add(f.reason);
      if (items.length < max) items.push(`${f.reason} (${where(f)})`);
    }
    const more = seen.size - items.length;
    parts.push(`appears to contain ${items.join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
  }
  if (never.length) parts.push(`“Never open” rule: ${[...new Set(never.map((f) => f.reason))].slice(0, max).join(", ")} (${where(never[0]!)})`);
  if (mark.unchecked) parts.push(UNCHECKED_WHY[mark.unchecked] ?? UNCHECKED_WHY.empty_text);
  return parts.join("; ") || "open check finding";
}

export const openCheckShort = (mark: Pick<OpenCheckFallback, "findings" | "unchecked">): string =>
  mark.findings.length ? openCheckReasons(mark.findings as OpenCheckFinding[]) : mark.unchecked ? UNCHECKED_SHORT[mark.unchecked] ?? UNCHECKED_SHORT.empty_text : "a check finding";

export const BY_WORD_SCOPE = "all such findings in the record and records derived from it as they stand now. Agents will not see anything the check finds later";

export function scansShowableByAuthor(mark: Pick<OpenCheckFallback, "kinds" | "rules" | "unchecked">): boolean {
  return mark.unchecked === "partial_text" && mark.kinds.every((k) => k === "unchecked" || OPENABLE_BY_WORD_KINDS.has(k)) && mark.rules.every(ruleOpenableByWord);
}
export const SCANS_SHOWABLE_ADVICE = "An agent cannot make this document open on request because some pages are scans. Only the recognized and checked text "
  + "can be shown to agents by the author in the workspace. The author can select “Make available to agents” on the record page if the administrator allows scans to be shown as text; "
  + "agents will not receive the file or the scanned pages. Do not press the button for the person";

export const openCheckAdvice = (mark: Pick<OpenCheckFallback, "openable" | "kinds" | "rules"> & Partial<Pick<OpenCheckFallback, "unchecked">>, o: { tool?: boolean; byWord?: boolean } = {}): string =>
  !openableByWord(mark) && scansShowableByAuthor({ kinds: mark.kinds, rules: mark.rules, unchecked: mark.unchecked }) ? SCANS_SHOWABLE_ADVICE
  : !openableByWord(mark) ? "This cannot be made open even on request. Remove the flagged content and save the record again"
    : o.byWord === false ? "This cannot be made open on request because other people can see the record. Only the author can show it to agents in the workspace"
    : o.tool === false ? "If agents need this record, remove the flagged content and save it again"
    : `Ask the person whether to show the record to agents (${BY_WORD_SCOPE}). Use memory_open if they explicitly confirm. Or remove the flagged content and save the record again`;

export const showAnywayPath = (id: string): string => `/records/${id}?show=anyway`;

export const showAnywayWhere = (id: string, url: string | null | undefined): string =>
  url ? url : `${showAnywayPath(id)} (the administrator knows the workspace address)`;

export const foreignHiddenText = (path: string, at: string | null | undefined, where: { id: string; url: string | null | undefined }): string =>
  `${path} · hidden from agents${at ? ` ${at.slice(0, 10)}` : ""}. This key cannot retrieve the title or text. Agents cannot see them. `
  + `Only the author can show it to agents in the workspace: ${showAnywayWhere(where.id, where.url)}. To delete it, use memory_delete.`;

export const openCheckSentence = (mark: OpenCheckFallback, advice: { tool?: boolean; byWord?: boolean } = {}): string =>
  `${openCheckWhy(mark)}. Agents cannot see this. This key cannot read the record. ${openCheckAdvice(mark, advice)}`;

export interface NeverOpenRule { id?: string; kind: string; pattern: string; reason: string }

export const isDirectoryCardRow = (r: { type?: string | null; source_kind?: string | null; source_ref?: string | null } | null | undefined): boolean =>
  !!r && r.type === "profile" && r.source_kind === "pipeline" && typeof r.source_ref === "string" && r.source_ref.startsWith("people:");

export function neverOpenFindings(rules: readonly NeverOpenRule[], rec: { type: string; title: string | null; domains: readonly string[]; entityKinds: readonly string[]; spaceSlug: string;
                                                                         sourceKind: string | null; sourceRef: string | null }): FallbackFinding[] {
  const out: FallbackFinding[] = [];
  for (const r of rules) {
    let field: string | null = null, reason = r.reason;
    if (r.kind === "domain_tag" && rec.domains.includes(r.pattern)) field = "domains";
    else if (r.kind === "pattern") {
      try { const re = titleRuleRe(r.pattern); if (rec.title && re.test(rec.title)) field = "title"; }
      catch (e) {
        field = "title"; reason = `${r.reason} (the rule pattern is invalid, so the record is kept closed as a precaution)`;
        log.warn("never_open_rule_invalid", { rule_id: r.id ?? null, error: String((e as Error)?.message ?? e).slice(0, 160) });
      }
    }
    else if (r.kind === "entity_kind" && (r.pattern === "person" ? isDirectoryCardRow({ type: rec.type, source_kind: rec.sourceKind, source_ref: rec.sourceRef })
                                                                 : rec.entityKinds.includes(r.pattern))) field = "entities";
    else if (r.kind === "space" && r.pattern === rec.spaceSlug) field = "space";
    if (field && !out.some((f) => f.reason === reason && f.field === field)) out.push({ rule: `never_open:${r.kind}`, kind: "never_open", reason, field });
  }
  return out;
}

export function openCheckFaultHit(fault: unknown, texts: ReadonlyArray<{ field: string; value: string | null | undefined }>): boolean {
  if (!fault || typeof fault !== "object") return false;
  const f = fault as { busy?: unknown; title_contains?: unknown };
  if (f.busy !== true || typeof f.title_contains !== "string" || !f.title_contains) return false;
  return texts.some((t) => (t.field === "title" || t.field === "filename") && typeof t.value === "string" && t.value.includes(f.title_contains as string));
}
