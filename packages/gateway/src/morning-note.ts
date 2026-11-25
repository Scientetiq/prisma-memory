// Personal morning note in the workspace: GET /api/v1/me/morning-note — the numbers
// of the person's note for the window of the latest slot, the same computation and window the e-mail job uses
// (@memory/shared morning-note.ts), and whether an e-mail goes out; PUT /api/v1/me/morning-note {enabled} — the person's own
// switch of the e-mail (people.morning_note). A person in the workspace only; counts are not content — no read event.
// With weekdays: [] there is no slot and no e-mail; the card then shows the window of the latest daily slot.
import type { Hono } from "hono";
import {
  MAIL_RE, MemoryError, morningNoteConfig, morningNoteCounts, morningNoteMailReady, morningNoteSlot, noteRetryLimit, smtpConfig, countsTotal, invalid,
  type MorningNoteCounts,
} from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";
import { isHumanSession } from "./workplace.ts";
import { KEY_EXPIRY_WARN_DAYS } from "./key-expiry.ts";

export const MORNING_NOTE_PATH = "/api/v1/me/morning-note";

export const MORNING_NOTE_ROUTE_MESSAGES = {
  human_only: "Only you, signed in to the workspace, can see your morning note and switch its e-mail.",
  human_only_hint: "Open the workspace",
  enabled_invalid: "enabled: true or false.",
} as const;

export interface MorningNoteView {
  /** The window of the note: from the previous slot to the latest one (ISO); the zone and wall time of the slot. */
  window: { from: string; to: string; tz: string; time: string };
  counts: MorningNoteCounts;
  total: number;
  email: {
    /** The person's switch: false — turned off; null — never touched (the instance setting decides). */
    personal: boolean | null;
    /** access.morning_note.enabled — the administrator sends notes on this installation. */
    instance_enabled: boolean;
    smtp_enabled: boolean;
    /** The login is an e-mail address (the note goes to the login). */
    address: boolean;
    /** Enabled weekdays (1 — Monday … 7 — Sunday); empty — no e-mail on any day. */
    weekdays: number[];
    /** The mail kind is registered on this installation (until then no note is sent). */
    kind_ready: boolean;
    /** Everything above allows it: the person gets the e-mail on enabled days when a counter is not zero. */
    will_send: boolean;
  };
}

function human(caller: Caller): void {
  if (!isHumanSession(caller)) throw new MemoryError("forbidden", MORNING_NOTE_ROUTE_MESSAGES.human_only, { hint: MORNING_NOTE_ROUTE_MESSAGES.human_only_hint });
}

/** The person's note: numbers of the latest slot's window and the state of the e-mail. */
export async function morningNoteView(app: App, caller: Caller, now = new Date()): Promise<MorningNoteView> {
  human(caller);
  const me = caller.person!;
  const cfg = morningNoteConfig(app.settings);
  const slot = morningNoteSlot(now, cfg) ?? morningNoteSlot(now, { ...cfg, weekdays: [1, 2, 3, 4, 5, 6, 7] })!;
  const src = { control: app.db.control, records: (cls: "open" | "closed") => app.db.records(cls, caller.scope) };
  const [counts, row] = await Promise.all([
    morningNoteCounts(src, app.instanceId, [me.id], { from: slot.from, to: slot.start }, { keyWarnDays: KEY_EXPIRY_WARN_DAYS, retryLimit: noteRetryLimit(app.settings) }),
    // a person marked as test or demo gets no scheduled e-mail (the job's filter of recipients)
    app.db.control.query(`SELECT morning_note, COALESCE(attrs->>'test', '') = 'true' OR COALESCE(attrs->>'demo', '') = 'true' AS excluded
                            FROM people WHERE id = $1 AND instance_id = $2`, [me.id, app.instanceId]),
  ]);
  const c = counts.get(me.id)!;
  const personal = (row.rows[0]?.morning_note ?? null) as boolean | null;
  const excluded = row.rows[0]?.excluded === true || me.demo === true;
  const smtp = smtpConfig(app.settings).enabled, address = MAIL_RE.test(me.login), kind = morningNoteMailReady();
  return {
    window: { from: slot.from.toISOString(), to: slot.start.toISOString(), tz: cfg.tz, time: cfg.time },
    counts: c, total: countsTotal(c),
    email: { personal, instance_enabled: cfg.enabled, smtp_enabled: smtp, address, weekdays: cfg.weekdays, kind_ready: kind,
             will_send: cfg.enabled && smtp && address && kind && personal !== false && cfg.weekdays.length > 0 && !excluded },
  };
}

/** Body of the PUT: exactly {enabled: boolean}. */
export function parseMorningNoteBody(b: unknown): boolean {
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "enabled") || typeof (b as { enabled?: unknown }).enabled !== "boolean")
    throw invalid(MORNING_NOTE_ROUTE_MESSAGES.enabled_invalid);
  return (b as { enabled: boolean }).enabled;
}

/** The person's switch of the e-mail; an admin event with the value only. */
export async function setMorningNote(app: App, caller: Caller, enabled: boolean): Promise<{ enabled: boolean }> {
  human(caller);
  await app.db.control.query("UPDATE people SET morning_note = $2 WHERE id = $1 AND instance_id = $3", [caller.person!.id, enabled, app.instanceId]);
  await audit(app, caller, { event_type: "admin", details: { op: "morning_note_set", enabled } });
  return { enabled };
}

export function registerMorningNote(r: Hono<any>, app: App): void {
  r.get(MORNING_NOTE_PATH, async (c) => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, "nav");
    return c.json(await morningNoteView(app, caller));
  });
  r.put(MORNING_NOTE_PATH, async (c) => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, "me_keys");
    human(caller);
    return c.json(await setMorningNote(app, caller, parseMorningNoteBody(await c.req.json().catch(() => null))));
  });
}
