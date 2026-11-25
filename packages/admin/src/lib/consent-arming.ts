// When the decision buttons of the consent screen may act (double-click-jacking). Framing is
// already refused (X-Frame-Options, frame-ancestors), but a page can still open a popup that asks for a double click and,
// meanwhile, navigate its opener to /oauth/authorize: the consent screen loads behind the popup in the person's own
// browser, the first click closes the popup and the second lands on "Allow", whose place is predictable.
//
// What the guard is, exactly: with JavaScript a press counts only CONSENT_ARM_MS or more after the page
// became visible and focused, without a break since. An earlier press is ignored and the form shows a short hint; the next
// press after the wait works. Nothing more: the former second condition — "a pointer or key event came after the wait" —
// was always met by the press itself (its pointerdown or keydown reaches the page before its submit), so it added no
// protection and is gone. The guard does not stop a lure that asks for a click, a pause and another click (the consent
// lines say "Allow only if you just started connecting … yourself"); without JavaScript, and before the page has hydrated,
// the plain form posts as it is.
//
// Pure: watchArming takes the window, the document and a clock (consent-form.tsx passes the browser's own); the tests give
// it EventTargets and a test clock.

/** How long the page must have been visible and focused before a press counts. */
export const CONSENT_ARM_MS = 700;

export interface Arming {
  /** since when the page is visible and focused without a break; null — not now */
  readonly focusedSince: number | null;
}

export type ArmingEvent = { readonly type: "focus" | "visible" | "blur" | "hidden"; readonly at: number };

/** The state at mount: focused and visible now, or not. */
export const initialArming = (at: number, focused: boolean): Arming => ({ focusedSince: focused ? at : null });

/** The next state after one browser event (focus/blur of the window, visibilitychange). */
export function nextArming(s: Arming, e: ArmingEvent): Arming {
  switch (e.type) {
    case "focus":
    case "visible":
      return s.focusedSince === null ? { focusedSince: e.at } : s;
    case "blur":
    case "hidden":
      return { focusedSince: null };
  }
}

/** May a press at `at` decide: the page has been visible and focused for CONSENT_ARM_MS without a break. */
export const armed = (s: Arming, at: number): boolean => s.focusedSince !== null && at - s.focusedSince >= CONSENT_ARM_MS;

/** What a press does: decide, or nothing yet (too early — the form shows the hint). */
export type PressOutcome = "decide" | "early";

/** The parts of window and document the guard listens to. */
export interface ArmingTarget {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}
export interface ArmingDocument extends ArmingTarget {
  readonly visibilityState: string;
  hasFocus(): boolean;
}

export interface ArmingWatch {
  /** The press of a decision button, asked from the form's submit. */
  press(): PressOutcome;
  /** Would a press count now (the form clears its hint once it does). */
  armed(): boolean;
  /** Stop listening (the form unmounts). */
  stop(): void;
}

/**
 * The guard as the form mounts it: the state at mount is the page's own at that moment — a page loaded behind a popup is
 * not focused yet, a focused page starts its wait now and not at navigation — then the window's focus and blur and the
 * document's visibility move it.
 */
export function watchArming(win: ArmingTarget, doc: ArmingDocument, now: () => number): ArmingWatch {
  const visibleAndFocused = () => doc.visibilityState === "visible" && doc.hasFocus();
  let s = initialArming(now(), visibleAndFocused());
  const feed = (type: ArmingEvent["type"]) => { s = nextArming(s, { type, at: now() }); };
  const onFocus = () => feed(visibleAndFocused() ? "focus" : "hidden");
  const onBlur = () => feed("blur");
  const onVisibility = () => feed(visibleAndFocused() ? "visible" : "hidden");
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onBlur);
  doc.addEventListener("visibilitychange", onVisibility);
  return {
    press: () => (armed(s, now()) ? "decide" : "early"),
    armed: () => armed(s, now()),
    stop: () => {
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("blur", onBlur);
      doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
