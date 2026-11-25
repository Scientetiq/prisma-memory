"use client";
import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { ResultBox } from "@/components/action-form";
import { avText } from "@/lib/agent-view.messages";
import { PLANS_MESSAGES, planApplyLabel } from "@/lib/plans";
import type { PlanOp, PlanSummary } from "@/lib/types";
import { planApplyAction } from "./actions";
import { WS_PLANS_MESSAGES } from "@/messages/ws-plans";
import { rich } from "@/i18n/rich";

export function PlanApplyForm({ id, op, count, continuing, target = null }: { id: string; op: PlanOp; count: number; continuing: boolean; target?: PlanSummary["target"] }) {
  const purge = op === "purge";
  const danger = purge || (op === "close" && (count > 0 || continuing));
  const [state, action, pending] = useActionState(planApplyAction, null);
  const submitted = useRef<FormData | null>(null);
  const continued = useRef<typeof state>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    const more = state?.ok && state.progress?.status === "applying" && state.progress.remaining > 0;
    if (pending || (!more && !state?.retryAfter) || !submitted.current || continued.current === state) return;
    const data = submitted.current;
    const run = () => { continued.current = state; setWaiting(false); startTransition(() => action(data)); };
    if (!state?.retryAfter) { run(); return; }
    setWaiting(true);
    const timer = setTimeout(run, state.retryAfter * 1000);
    return () => clearTimeout(timer);
  }, [state, pending, action]);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    submitted.current = data;
    startTransition(() => action(data));
  }
  return (
    <form action={action} onSubmit={submit} className="form full plan-apply">
      <input type="hidden" name="id" value={id} />
      {purge ? <label className="check"><input type="checkbox" name="confirm" required disabled={pending || waiting} /> {PLANS_MESSAGES.planPurgeConfirm}</label> : null}
      {/* op open: the person confirms that agents will read the records; the server checks it by the stored op.
          A plan with every record excluded opens nothing — it is closed without the tick */}
      {op === "open" && (count > 0 || continuing) ? <label className="check"><input type="checkbox" name="confirm" required disabled={pending || waiting} /> {avText("plan_confirm")}</label> : null}
      <div className="form-actions"><button type="submit" className={`btn ${danger ? "danger" : "primary"}`} disabled={pending || waiting}>
        {waiting ? WS_PLANS_MESSAGES.pausedFor(state?.retryAfter ?? 0) : pending ? WS_PLANS_MESSAGES.applying : planApplyLabel(op, count, { continuing, target })}
      </button></div>
      {!count && !continuing ? <p className="hint">{PLANS_MESSAGES.planEmptyApplyHint}</p> : null}
      <p className="hint">{WS_PLANS_MESSAGES.largeListsAreAppliedIn}</p>
      <noscript><p className="hint">{WS_PLANS_MESSAGES.javascriptIsDisabledSelectContinue}</p></noscript>
      <ResultBox state={state} />
      {state?.retryAfter ? <p className="hint" role="status">{rich(WS_PLANS_MESSAGES.retryInSCompletedChanges, null, { value1: state.retryAfter })}</p> : null}
    </form>
  );
}
