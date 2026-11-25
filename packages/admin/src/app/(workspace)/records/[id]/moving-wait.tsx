"use client";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useTransition } from "react";
import { MOVING_PLAIN } from "@/lib/plain";
import { MOVING_POLL_S, MOVING_REFRESH_GIVE_UP_MS, movingManual, movingStart, movingStep } from "@/lib/record-moving";

export function MovingWait() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [s, dispatch] = useReducer(movingStep, undefined, movingStart);
  const ran = useRef(false);
  const nav = useRef(router);
  nav.current = router;

  useEffect(() => {
    if (s.phase !== "waiting") return;
    const t = setTimeout(() => dispatch({ type: "due" }), MOVING_POLL_S * 1000);
    return () => clearTimeout(t);
  }, [s]);

  useEffect(() => {
    if (s.phase !== "refreshing" && s.phase !== "clicked") return;
    if (!ran.current) {
      ran.current = true;
      startTransition(() => nav.current.refresh());
    }
    const t = setTimeout(() => { if (ran.current) { ran.current = false; dispatch({ type: "refreshed" }); } }, MOVING_REFRESH_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [s]);

  useEffect(() => {
    if (pending || !ran.current) return;
    ran.current = false;
    dispatch({ type: "refreshed" });
  }, [pending]);

  const manual = movingManual(s);
  return (
    <span className="moving-wait">
      {manual ? MOVING_PLAIN.slow : MOVING_PLAIN.wait}
      {manual ? " " : null}
      {manual ? (
        <button type="button" className="btn sm" disabled={s.phase === "clicked"} onClick={() => dispatch({ type: "click" })}>
          {s.phase === "clicked" ? MOVING_PLAIN.refreshing : MOVING_PLAIN.refresh}
        </button>
      ) : null}
    </span>
  );
}
