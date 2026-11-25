"use client";
// Decision form of the consent screen: a plain POST to the route handler /connect/authorize/decide, so it
// works without JavaScript. With JavaScript the buttons are blocked after the first press: a second press does not send a
// second decision (without JavaScript the repeat is harmless — the gateway answers the same session's repeat with a new
// continuation key). The buttons are not `disabled`: a disabled submitter would drop its `decision` value from the form.
// Double-click-jacking (lib/consent-arming.ts): with JavaScript a press counts only 700 ms or more
// after the page became visible and focused. An earlier press is ignored: the buttons look unavailable and a short hint
// says to press again, until the wait is over. Without JavaScript the plain form posts as it is.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { consentText } from "@/lib/agent-consent-text";
import { watchArming, type ArmingWatch } from "@/lib/consent-arming";

const now = (): number => performance.now();

export function DecisionForm({ tx, csrf, decided }: { tx: string; csrf: string; decided: "allow" | "deny" | null }) {
  const sent = useRef(false);
  const [busy, setBusy] = useState(false);
  // a press came too early: the hint is shown and the buttons look unavailable until a press would count
  const [waiting, setWaiting] = useState(false);
  const guard = useRef<ArmingWatch | null>(null);
  useEffect(() => {
    const g = watchArming(window, document, now);
    guard.current = g;
    return () => { g.stop(); guard.current = null; };
  }, []);
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => { if (guard.current?.armed()) setWaiting(false); }, 100);
    return () => window.clearInterval(t);
  }, [waiting]);
  // back from the app's page (back-forward cache): the form is usable again — a repeat is the same session's "Continue"
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => { if (e.persisted) { sent.current = false; setBusy(false); setWaiting(false); } };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (sent.current) { e.preventDefault(); return; }
    // too early, or before the guard is there (the effect has not run yet): this press does not decide
    if (guard.current?.press() !== "decide") { e.preventDefault(); setWaiting(true); return; }
    sent.current = true;
    setWaiting(false);
    setBusy(true);
  };
  const btn = (decision: "allow" | "deny", label: string, primary: boolean) => (
    <button type="submit" name="decision" value={decision} className={`btn${primary ? " primary" : ""}`} aria-disabled={busy || waiting || undefined}>
      {busy ? consentText("sending") : label}
    </button>
  );
  return (
    <form method="post" action="/connect/authorize/decide" className="consent-actions" onSubmit={onSubmit} data-busy={busy || undefined} data-waiting={waiting || undefined}>
      <input type="hidden" name="tx" value={tx} />
      <input type="hidden" name="csrf" value={csrf} />
      {/* answered by this session, the app not reached yet: one button repeats the same decision */}
      {decided ? btn(decided, consentText("continue"), true) : <>{btn("allow", consentText("allow"), true)}{btn("deny", consentText("deny"), false)}</>}
      {/* the hint of an early press: a live region from the start, empty until then (screen readers announce the change) */}
      <p className="consent-wait" role="status" aria-live="polite">{waiting ? consentText("wait") : null}</p>
    </form>
  );
}
