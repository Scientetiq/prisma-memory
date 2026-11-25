"use client";
import { stageChips as M } from "@/messages/ws-materials";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ActionForm, type FormAction } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { recordState } from "@/lib/home";
import { failedStageReason } from "@/lib/stage-errors";
import type { Conversion } from "@/lib/types";
import { converterWaitLine, isConverterWait, processNowLabel, processNowOffer, STAGE_STATUS_TITLES, stageTitle, stagesAdvice, stillProcessing, summarizeStages, type QueueLike,
         type StageLike } from "@/lib/stages";

const POLL_MS = 30_000;
const MAX_TICKS = 20;
const MAX_IDS = 50;

export type StagesMap = Record<string, StageLike[]>;
export type QueuesMap = Record<string, QueueLike | null>;
export type ConversionsMap = Record<string, Partial<Conversion> | null>;
interface Live { stages: StagesMap; queues: QueuesMap; conversions: ConversionsMap; now: number | null; error: string | null }

const Ctx = createContext<Live>({ stages: {}, queues: {}, conversions: {}, now: null, error: null });

const unfinished = (map: StagesMap): string[] => Object.entries(map).filter(([, s]) => stillProcessing(summarizeStages(s))).map(([id]) => id);

export function mergeStages(prev: StagesMap, items: ReadonlyArray<{ id: string; stages?: StageLike[] }>): StagesMap {
  const next = { ...prev };
  for (const it of items) next[it.id] = it.stages ?? [];
  return next;
}

export function mergeQueues(prev: QueuesMap, items: ReadonlyArray<{ id: string; queue?: QueueLike | null }>): QueuesMap {
  const next = { ...prev };
  for (const it of items) next[it.id] = it.queue ?? null;
  return next;
}

export function mergeConversions(prev: ConversionsMap, items: ReadonlyArray<{ id: string; conversion?: Partial<Conversion> | null }>): ConversionsMap {
  const next = { ...prev };
  for (const it of items) next[it.id] = it.conversion ?? null;
  return next;
}

export function StagesLive({ initial, queues: initialQueues = {}, conversions: initialConversions = {}, now: serverNow = null, children }:
                           { initial: StagesMap; queues?: QueuesMap; conversions?: ConversionsMap; now?: number | null; children: ReactNode }) {
  const [stages, setStages] = useState<StagesMap>(initial);
  const [queues, setQueues] = useState<QueuesMap>(initialQueues);
  const [conversions, setConversions] = useState<ConversionsMap>(initialConversions);
  const [now, setNow] = useState<number | null>(serverNow);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [delay, setDelay] = useState(POLL_MS);
  const [snapshot, setSnapshot] = useState(initial);
  if (snapshot !== initial) {
    setSnapshot(initial);
    setStages((prev) => ({ ...prev, ...initial }));
    setQueues((prev) => ({ ...prev, ...initialQueues }));
    setConversions((prev) => ({ ...prev, ...initialConversions }));
    setNow(serverNow);
    setTick(0);
  }

  useEffect(() => {
    const pending = unfinished(stages).slice(0, MAX_IDS);
    if (!pending.length || tick >= MAX_TICKS) return;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/records/status?ids=${pending.join(",")}`, { cache: "no-store" });
        if (r.redirected) { if (alive) { setError(M.sessionEndedRefreshThePage); setTick(MAX_TICKS); } return; }
        const body = (await r.json().catch(() => null)) as { ok?: boolean; message?: string; retryAfter?: number | null;
                                                             items?: Array<{ id: string; stages?: StageLike[]; queue?: QueueLike | null; conversion?: Partial<Conversion> | null }> } | null;
        if (!alive) return;
        if (!r.ok || !body?.ok) {
          setError(body?.message ?? M.errorCode(r.status));
          if (r.status === 429) setDelay(Math.max(POLL_MS, (body?.retryAfter ?? 60) * 1000));
          setTick((t) => t + 1);
          return;
        }
        setError(null);
        setDelay(POLL_MS);
        setStages((prev) => mergeStages(prev, body.items ?? []));
        setQueues((prev) => mergeQueues(prev, body.items ?? []));
        setConversions((prev) => mergeConversions(prev, body.items ?? []));
        setNow(Date.now());
        setTick((t) => t + 1);
      } catch {
        if (alive) { setError(M.noConnection); setTick((t) => t + 1); }
      }
    }, delay);
    return () => { alive = false; clearTimeout(timer); };
  }, [stages, tick, delay]);

  return <Ctx.Provider value={{ stages, queues, conversions, now, error }}>{children}</Ctx.Provider>;
}

const offerOf = (live: Live, id: string) => processNowOffer(live.stages[id], { queue: live.queues[id] ?? null, ...(live.now !== null ? { now: live.now } : {}) });

export function StateWhy({ detail, advice }: { detail: string; advice: string | null }) {
  return (
    <details className="st-why">
      <summary aria-label={M.whatDoesThisMean} title={M.whatDoesThisMean2}>?</summary>
      <span className="st-pop" role="note">{detail}.{advice ? <> {advice}</> : null}</span>
    </details>
  );
}

export function StageChips({ id }: { id: string }) {
  const live = useContext(Ctx);
  const own = live.stages[id];
  const now = live.now ?? undefined;
  const st = own ? recordState(own, now) : null;
  if (!own || !st) return <span className="st muted" title={live.error ?? undefined}>{live.error ? M.statusUnknown : "—"}</span>;
  const s = summarizeStages(own, now);
  const why = (x: StageLike): string => (isConverterWait(x) ? converterWaitLine(x.last_error ?? "", now !== undefined ? new Date(now) : undefined)
    : failedStageReason(x, live.conversions[id]));
  const title = own.map((x) => `${stageTitle(x.stage)}: ${STAGE_STATUS_TITLES[x.status] ?? x.status}${x.last_error ? ` — ${why(x)}` : ""}`).join("\n");
  const advice = stagesAdvice(s, offerOf(live, id));
  const say = s.state === "failed" && s.terminal && !s.tooSlow;
  return (
    <span className="stages-row">
      <span className="st-line">
        <span className={`st ${st.tone}`} title={title}><Icon name={st.icon} /><span className="st-l">{st.label}</span></span>
        {st.state !== "done" && !say ? <StateWhy detail={st.detail} advice={advice} /> : null}
      </span>
      {advice && say ? <span className="st-advice">{advice}</span> : null}
    </span>
  );
}

export function ProcessNowGate({ id, action }: { id: string; action: FormAction }) {
  const live = useContext(Ctx);
  const offer = offerOf(live, id);
  if (!offer) return null;
  const s = summarizeStages(live.stages[id], live.now ?? undefined);
  return (
    <ActionForm action={action} submitLabel={processNowLabel(offer, s)} pendingLabel="…" compact quiet>
      <input type="hidden" name="id" value={id} />
    </ActionForm>
  );
}
