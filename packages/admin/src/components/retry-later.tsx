"use client";
import { RETRY_LATER_TEXT } from "../messages/components";

import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useTransition } from "react";
import { carriedAttempt, claimRefresh, releaseCarry, retryStart, retryStep, retryText, type CarryMap } from "@/lib/retry";

const carried: CarryMap = new Map();
const REFRESH_GIVE_UP_MS = 10_000;
const refreshSlot = { at: 0 };

export function RetryLater({ seconds, limited = false, auto, carry, onRetry }: {
  seconds: number | null;
  limited?: boolean;
  auto?: boolean;
  carry?: string;
  onRetry?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, dispatch] = useReducer(retryStep, null, () => retryStart(seconds, auto ?? (seconds !== null && seconds > 0), carriedAttempt(carried, carry)));
  const ran = useRef(false);
  const latest = useRef(seconds);
  latest.current = seconds;
  const retry = useRef(onRetry);
  retry.current = onRetry;
  const nav = useRef(router);
  nav.current = router;

  useEffect(() => {
    if (!carry) return;
    return () => releaseCarry(carried, carry);
  }, [carry]);

  useEffect(() => {
    if (state.phase !== "counting") return;
    const t = setTimeout(() => dispatch({ type: "tick" }), 1000);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    if (state.phase !== "refreshing") return;
    if (!ran.current) {
      ran.current = true;
      if (carry && state.auto) carried.set(carry, { attempt: state.attempt, at: Date.now() });
      startTransition(() => { retry.current?.(); if (claimRefresh(refreshSlot)) nav.current.refresh(); });
    }
    const t = setTimeout(() => { if (ran.current) { ran.current = false; dispatch({ type: "refreshed", seconds: latest.current }); } }, REFRESH_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [state.phase, state.attempt, state.auto, carry]);

  useEffect(() => {
    if (pending || !ran.current) return;
    ran.current = false;
    dispatch({ type: "refreshed", seconds: latest.current });
  }, [pending]);

  const line = retryText(state, limited);
  return (
    <span className="retry-later">
      <span aria-hidden="true">{line}</span>
      <span className="vis-hidden">{state.phase === "counting" ? (limited && state.attempt === 0 ? RETRY_LATER_TEXT.limited : RETRY_LATER_TEXT.refreshSoon) : line}</span>
      {state.phase === "manual" ? <button type="button" className="btn sm" onClick={() => dispatch({ type: "click" })}>{RETRY_LATER_TEXT.retry}</button> : null}
      {state.phase === "counting" ? <button type="button" className="btn sm" onClick={() => dispatch({ type: "click" })}>{RETRY_LATER_TEXT.retryNow}</button> : null}
    </span>
  );
}
