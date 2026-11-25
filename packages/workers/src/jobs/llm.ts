import { estimateTokens, log, type DataClass } from "@memory/shared";
import { recordsDb, type Ctx, type DbCtx } from "../ctx.ts";
import type { StageJob } from "../stages.ts";
import { buildMessages, defang, eventLocator, loadOutputSchema, loadPromptVersion, parseTranscriptText, renderEvent, renderSummary, QUOTE_CHECK_BUDGET_MS, sourceBlock, splitFrontMatter, splitToFit, verifyEvents, verifyParams,
         type RawEvent, type Segment, type SummaryData } from "../pipeline/index.ts";
import { dateLabel, loadRecordForModel, modelDispatchFence, modelRecheck, openDerivedRefused, peopleOf, replaceDerived, untilHandoff, type Rec } from "./common.ts";
import { linkMeetingChildren } from "./named.ts";
import { rebuildSummaryActions, withCardActions } from "./summary-actions.ts";

async function linkChildrenSafe(ctx: DbCtx, cls: DataClass, recordId: string): Promise<void> {
  try { await linkMeetingChildren(ctx, cls, recordId); }
  catch (e) { log.warn("child_links_failed", { record_id: recordId, error: String((e as Error)?.message ?? e).slice(0, 160) }); }
}

const segLine = (s: Segment): string => `[${String(Math.floor((s.startSec ?? 0) / 60)).padStart(2, "0")}:${String(Math.floor((s.startSec ?? 0) % 60)).padStart(2, "0")}] ${s.speaker ? s.speaker + ": " : ""}${s.text}`;

const safe = (value: unknown, max: number): string => { const cps = [...defang(String(value ?? ""))]; return cps.length > max ? cps.slice(0, max).join("") + "…" : cps.join(""); };
export const safeLine = (value: unknown, max: number): string => safe(oneLineText(value), max);
const oneLineText = (value: unknown): string => String(value ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ");

const segPrefix = (s: Segment): string => segLine({ ...s, text: "" });

function splitLong(s: Segment, limit: number): Segment[] {
  if (estimateTokens(segLine(s)) <= limit) return [s];
  const room = Math.max(1, limit - estimateTokens(segPrefix(s)) - 1);
  return splitToFit(s.text, room, estimateTokens).map((text) => ({ ...s, text }));
}

function cutHead(s: Segment, room: number): [Segment, Segment] | null {
  const free = room - estimateTokens(segPrefix(s)) - 1;
  if (free < 1) return null;
  const cps = [...s.text], max = free * 4;
  if (cps.length <= max) return null;
  let cut = max;
  for (let i = max; i > 0; i--) if (/\s/u.test(cps[i]!)) { cut = i; break; }
  const head = cps.slice(0, cut).join("").trimEnd(), rest = cps.slice(cut).join("").trimStart();
  return head && rest ? [{ ...s, text: head }, { ...s, text: rest }] : null;
}

function pack(pieces: Segment[], part: number, overlap: number, fill: boolean): Segment[][] {
  const parts: Segment[][] = [];
  let cur: Segment[] = [], n = 0, fresh = 0, i = 0, carry: Segment | null = null;
  while (carry || i < pieces.length) {
    const s: Segment = carry ?? pieces[i++]!, t = estimateTokens(segLine(s));
    carry = null;
    if (n + t > part && fresh > 0) {
      const head = fill ? cutHead(s, part - n) : null;
      if (head) { cur.push(head[0]); carry = head[1]; }
      else carry = s;
      parts.push(cur);
      const tail: Segment[] = []; let o = 0;
      for (let k = cur.length - 1; k >= 0; k--) {
        const tk = estimateTokens(segLine(cur[k]!));
        if (o + tk > overlap) break;
        tail.unshift(cur[k]!); o += tk;
      }
      cur = tail; n = o; fresh = 0;
      continue;
    }
    cur.push(s); n += t; fresh++;
  }
  if (fresh > 0) parts.push(cur);
  return parts;
}

export function splitParts(segments: Segment[], partTokens: number, overlapTokens: number, recordId?: string): Segment[][] {
  const part = Math.max(2, Math.floor(partTokens));
  const overlap = Math.max(0, Math.min(Math.floor(overlapTokens), Math.floor(part / 2)));
  const pieces = segments.flatMap((s) => splitLong(s, part - overlap));
  const total = pieces.reduce((sum, s) => sum + estimateTokens(segLine(s)), 0);
  const limit = Math.ceil(total / (part - overlap)) + 1;
  const parts = pack(pieces, part, overlap, false);
  if (parts.length <= limit) return parts;
  const dense = pack(pieces, part, overlap, true);
  log.warn("llm_parts_limited", { record_id: recordId ?? null, by_replies: parts.length, dense: dense.length, limit, tokens: total });
  return dense;
}

async function meetingValues(ctx: Ctx, job: StageJob, rec: Rec, texts: EnglishPromptTexts) {
  const people = await peopleOf(ctx, job.class, rec.id);
  return { meeting_title: safeLine(rec.title || texts.meetingTitle, 300), meeting_date: dateLabel(rec.occurred_at), participants: people.map((p) => safeLine(p.display_name, 120)).join(", ") || texts.noParticipants,
           speaker_legend: texts.speakerLegend, source_id: rec.id };
}

function budgets(ctx: Ctx) { return ctx.settings.get("processing.budgets", { single_call_tokens: 20000, part_tokens: 12000, part_overlap_tokens: 1000, describe_head_tokens: 8000 }); }

// Every model call of a stage re-checks the record (modelRecheck — the embedding senders' rule heldBack) — a close requested between two
// calls of one stage stops the next call; the stage ends `handoff`
export async function summarize(ctx: Ctx, job: StageJob): Promise<"done" | "skipped" | "handoff"> {
  return untilHandoff(async () => {
    const loaded = await loadRecordForModel(ctx, job);
    if (loaded === "handoff") return loaded;
    if (!loaded || loaded.rec.type !== "transcript") return "skipped";
    const { rec, text } = loaded, prompt = loadPromptVersion(job.version), schema = loadOutputSchema(prompt);
    const segments = parseTranscriptText(text), b = budgets(ctx);
    if (!segments.length) return "skipped";
    const texts = ENGLISH_PROMPT_TEXTS, base = await meetingValues(ctx, job, rec, texts);
    const maxTokens = Number(prompt.meta.max_output_tokens ?? 1200);
    const recheck = modelRecheck(ctx, job), fence = modelDispatchFence(ctx, job);   // and at every send
    const call = async (body: string, partInfo: string) => {
      const [src, sha256] = sourceBlock(rec.id, body);
      await recheck();
      return ctx.chat<SummaryData>({ messages: buildMessages(prompt, { ...base, part_info: partInfo, transcript: src, sha256 }), schemaName: prompt.version, schema, maxTokens, use: { dataClass: job.class, stage: job.stage }, beforeDispatch: fence });
    };
    const whole = segments.map(segLine).join("\n");
    let out;
    if (estimateTokens(whole) <= b.single_call_tokens) out = await call(whole, texts.wholeTranscript);
    else {
      const parts = splitParts(segments, b.part_tokens, b.part_overlap_tokens, rec.id), partial: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const r = await call(parts[i]!.map(segLine).join("\n"), texts.summaryPart(i + 1, parts.length));
        partial.push(renderSummary(r.data, { title: `${oneLineText(rec.title)} — part ${i + 1}`, dateLabel: base.meeting_date }));
      }
      out = await call(partial.join("\n\n"), texts.combine(parts.length));
    }
    const md = await withCardActions(ctx, job.class, rec, renderSummary(out.data, { title: oneLineText(rec.title ?? texts.meetingTitle), dateLabel: base.meeting_date }));
    // a close requested while the text was on the way — the answer is not written (handoff)
    await recheck();
    await replaceDerived(ctx, rec, "summary", [{
      type: "summary", title: `Summary: ${oneLineText(rec.title ?? "meeting")}`, text: md, summaryLine: String(out.data.headline ?? "").slice(0, 160),
      processor: { model: out.servedModel, prompt: prompt.version }, attrs: { language: out.data.language, mentions: out.data.mentions ?? [] },
    }]);
    await recordsDb(ctx, job.class).query(
      "UPDATE records SET attrs = attrs || jsonb_build_object('pipeline_mentions', COALESCE(attrs->'pipeline_mentions', '{}'::jsonb) || jsonb_build_object('summary', $2::jsonb)) WHERE id = $1",
      [rec.id, JSON.stringify(out.data.mentions ?? [])]);
    await linkChildrenSafe(ctx, job.class, rec.id);
    return "done";
  });
}

export async function knownEntityNames(ctx: DbCtx, cls: DataClass, recordId: string): Promise<string[]> {
  const known = (await recordsDb(ctx, cls).query("SELECT DISTINCT entity_id FROM record_entities WHERE record_id = $1 AND role <> 'space'", [recordId])).rows.map((r) => r.entity_id);
  return known.length ? (await ctx.db.control.query("SELECT display_name FROM entities WHERE id = ANY($1) UNION SELECT display_name FROM people WHERE id = ANY($1)", [known])).rows.map((r) => safeLine(r.display_name, 120)) : [];
}

export async function extractEvents(ctx: Ctx, job: StageJob): Promise<"done" | "skipped" | "handoff"> {
  return untilHandoff(async () => {
    const loaded = await loadRecordForModel(ctx, job);
    if (loaded === "handoff") return loaded;
    if (!loaded || loaded.rec.type !== "transcript") return "skipped";
    const { rec, text } = loaded, prompt = loadPromptVersion(job.version), schema = loadOutputSchema(prompt);
    const segments = parseTranscriptText(text), b = budgets(ctx), texts = ENGLISH_PROMPT_TEXTS, base = await meetingValues(ctx, job, rec, texts);
    if (!segments.length) return "skipped";
    const names = await knownEntityNames(ctx, job.class, rec.id);
    const maxTokens = Number(prompt.meta.max_output_tokens ?? 4000);
    const whole = segments.map(segLine).join("\n");
    const parts = estimateTokens(whole) <= b.single_call_tokens ? [segments] : splitParts(segments, b.part_tokens, b.part_overlap_tokens, rec.id);
    const raw: RawEvent[] = []; let served = "";
    const recheck = modelRecheck(ctx, job), fence = modelDispatchFence(ctx, job);   // and at every send
    for (let i = 0; i < parts.length; i++) {
      const [src, sha256] = sourceBlock(rec.id, parts[i]!.map(segLine).join("\n"));
      await recheck();
      const r = await ctx.chat<{ events: RawEvent[] }>({
        messages: buildMessages(prompt, { ...base, part_info: parts.length > 1 ? texts.eventsPart(i + 1, parts.length) : texts.wholeTranscript, known_entities: names.slice(0, 50).join(", ") || texts.none, transcript: src, sha256 }),
        schemaName: prompt.version, schema, maxTokens, use: { dataClass: job.class, stage: job.stage }, beforeDispatch: fence });
      raw.push(...(r.data.events ?? [])); served = r.servedModel;
    }
    const ev = ctx.settings.get("processing.events", { max_per_transcript: 40, fuzzy_threshold: 0.9, dedupe_window_sec: 600 });
    const report = verifyEvents(raw, segments, verifyParams({ maxEvents: ev.max_per_transcript, fuzzyThreshold: ev.fuzzy_threshold, dedupeWindowSec: ev.dedupe_window_sec } as any),
                                { budgetMs: QUOTE_CHECK_BUDGET_MS });
    if (report.stats.quote_check_timeout) log.warn("quote_check_timeout", { record_id: rec.id, quotes: report.stats.quote_check_timeout, events: raw.length, budget_ms: QUOTE_CHECK_BUDGET_MS });
    const actorsRole = prompt.meta.actors_role === "assignee" ? "assignee" : null;
    // a close requested while the text was on the way — the answer is not written (handoff)
    await recheck();
    const derived = await replaceDerived(ctx, rec, "event", report.kept.map((e) => ({
      type: "event" as const, eventKind: e.kind, title: e.title, summaryLine: e.statement.slice(0, 160),
      text: renderEvent({ kind: e.kind, title: e.title, statement: e.statement, quote: e.quote, timeFrom: e.timeFrom, rationale: e.rationale, alternatives: e.alternatives, due: e.due, actors: e.actors, actorsRole }),
      locator: eventLocator(e), processor: { model: served, prompt: prompt.version },
      attrs: { certainty: e.certainty, confidence: e.confidence, match: e.match, quote: e.quote, statement: e.statement, actors: e.actors, rationale: e.rationale, alternatives: e.alternatives, due: e.due, mentions: e.mentions,
               ...(actorsRole ? { actors_role: actorsRole } : {}) },
    })));
    await recordsDb(ctx, job.class).query(
      "UPDATE records SET attrs = attrs || jsonb_build_object('extraction', $2::jsonb) || jsonb_build_object('pipeline_mentions', COALESCE(attrs->'pipeline_mentions', '{}'::jsonb) || jsonb_build_object('events', $3::jsonb)) WHERE id = $1",
      [rec.id, JSON.stringify({ ...report.stats, keys: derived.keys, suppressed_by_correction: derived.suppressed, prompt: prompt.version, model: served }), JSON.stringify(report.kept.flatMap((e) => e.mentions))]);
    if (prompt.meta.summary_actions === "events") await rebuildSummaryActions(ctx, job.class, rec);
    await linkChildrenSafe(ctx, job.class, rec.id);
    return "done";
  });
}

// F-A: the whole stage runs inside untilHandoff (as summarize and extractEvents) — a DispatchHandoff of the fence at
// the send ends it `handoff`, not a refusal that the runner then reports as a lost claim
export async function describe(ctx: Ctx, job: StageJob): Promise<"done" | "skipped" | "handoff"> {
  return untilHandoff(async () => {
  const loaded = await loadRecordForModel(ctx, job);
  if (loaded === "handoff") return loaded;
  if (!loaded || loaded.rec.type !== "document") return "skipped";
  const { rec, text, original } = loaded, prompt = loadPromptVersion(job.version), b = budgets(ctx);
  const domains = ctx.settings.get<string[]>("search.domains", []);
  const schema = structuredClone(loadOutputSchema(prompt)) as any;
  if (domains.length) schema.properties.domain_tags.items = { type: "string", enum: domains };
  const [front, body] = splitFrontMatter(text);
  const texts = ENGLISH_PROMPT_TEXTS, toc = body.split("\n").filter((l) => /^#{1,6}\s/.test(l)).slice(0, 60).map((l) => safe(l, 200)).join("\n") || texts.none;
  const frontMatter = safe(Object.entries(front).map(([k, v]) => `${k}: ${v}`).join("\n"), 1500) || texts.none;
  const head = [...body].slice(0, b.describe_head_tokens * 4).join("");
  const meta = (await ctx.db.control.query("SELECT (SELECT name FROM spaces WHERE id = $1) AS space, (SELECT role FROM people WHERE id = $2) AS role", [rec.space_id, rec.owner_id])).rows[0];
  const [safeHead, sha256] = sourceBlock(rec.id, head);
  const recheck = modelRecheck(ctx, job);
  await recheck();
  const out = await ctx.chat<any>({
    messages: buildMessages(prompt, { filename: safeLine(rec.attrs?.filename ?? rec.title ?? texts.documentName, 200), mime: safeLine(original.mime ?? "text/markdown", 100), pages: String(original.pages ?? "—"), uploader_role: safeLine(meta?.role ?? texts.uploaderRole, 120),
      space_name: safeLine(meta?.space ?? "—", 120), domains: domains.join(", ") || texts.none, source_id: rec.id, sha256, front_matter: frontMatter, toc, text_head: safeHead }),
    schemaName: prompt.version, schema, maxTokens: Number(prompt.meta.max_output_tokens ?? 600), use: { dataClass: job.class, stage: job.stage }, beforeDispatch: modelDispatchFence(ctx, job) });
  const d = out.data, dict = new Set(domains);
  const tags = (d.domain_tags as string[]).filter((t) => dict.has(t)).slice(0, 3);
  if ((await openDerivedRefused(ctx, rec, job.stage, [{ field: "summary", value: String(d.summary_line ?? "") }])).size) d.summary_line = null;
  // a close requested while the text was on the way — the answer is not written (handoff)
  await recheck();
  await recordsDb(ctx, job.class).query(
    `UPDATE records SET summary_line = $2, domain_tags = (SELECT ARRAY(SELECT DISTINCT unnest(domain_tags || $3::text[]))),
       attrs = attrs || jsonb_build_object('description', $4::text, 'doc_type', $5::text, 'keywords', $6::jsonb, 'document_date', $7::text, 'described_by', $8::jsonb)
                     || jsonb_build_object('pipeline_mentions', COALESCE(attrs->'pipeline_mentions', '{}'::jsonb) || jsonb_build_object('describe', $9::jsonb))
     WHERE id = $1`,
    [rec.id, d.summary_line === null ? null : String(d.summary_line).slice(0, 160), tags, d.description, d.doc_type, JSON.stringify(d.keywords ?? []), d.document_date ?? null, JSON.stringify({ model: out.servedModel, prompt: prompt.version }), JSON.stringify(d.mentions ?? [])]);
  return "done";
  });
}

// The service phrases that the stages put into the placeholders of a prompt; the records they write carry English headings and labels.
export type EnglishPromptTexts = Readonly<{
  meetingTitle: string;
  noParticipants: string;
  speakerLegend: string;
  wholeTranscript: string;
  summaryPart(i: number, n: number): string;
  combine(n: number): string;
  eventsPart(i: number, n: number): string;
  none: string;
  documentName: string;
  uploaderRole: string;
}>;

const ENGLISH_PROMPT_TEXTS: EnglishPromptTexts = {
  meetingTitle: "Meeting",
  noParticipants: "not given",
  speakerLegend: "Speakers are marked at the start of each utterance.",
  wholeTranscript: "The whole transcript.",
  summaryPart: (i, n) => `Part ${i} of ${n} of a long transcript.`,
  combine: (n) => `Below are the summaries of ${n} parts of one transcript: combine them into one summary of the meeting.`,
  eventsPart: (i, n) => `Part ${i} of ${n}.`,
  none: "none",
  documentName: "document",
  uploaderRole: "employee",
};

export function englishPromptTexts(prompt: { meta: Readonly<Record<string, string>> }): EnglishPromptTexts | null {
  return prompt.meta.texts === "en" ? ENGLISH_PROMPT_TEXTS : null;
}
