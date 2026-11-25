"use client";
import { PEOPLE_PICKER_TEXT } from "../messages/components";
export { PEOPLE_PICKER_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import type { ActionState } from "@/lib/action-state";
import { PICK_ROLE_TITLES, type PickRole } from "@/lib/project-people";
import { Icon } from "./icons";
import { mailBreak } from "./mail-break";
import { toastFrom, useToasts } from "./toasts";

export interface PickedPerson { login: string; display_name: string | null; department: string | null; title: string | null }
export type FoundPerson = PickedPerson & { in_memory: boolean };

export const PICKER_QUERY_MIN = 2;
export const PICKER_DEBOUNCE_MS = 250;
const CACHE_MAX = 60;

export const normQuery = (s: string): string => s.replace(/\s+/g, " ").trim();

export const looksLikeEmail = (s: string): boolean => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);

export function takeEmails(raw: string): { emails: string[]; rest: string } | null {
  if (!raw.includes("@") || !/[\s,;]/.test(raw)) return null;
  const parts = raw.split(/[\s,;]+/);
  const rest = parts.pop() ?? "";
  const done = parts.filter(Boolean);
  if (!done.length || !done.every(looksLikeEmail)) return null;
  return { emails: done.map((e) => e.toLowerCase()), rest };
}

export function initials(p: Pick<PickedPerson, "display_name" | "login">): string {
  const words = (p.display_name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : words.length === 1 ? words[0]!.slice(0, 2) : p.login.slice(0, 2);
  return letters.toUpperCase();
}

export const personSub = (p: Pick<PickedPerson, "department" | "title">): string => [p.department, p.title].filter(Boolean).join(" · ");

export function moreChars(n: number): string {
  return PEOPLE_PICKER_TEXT.moreChars(n);
}


export type PickerMode = "collect" | "act" | "single";
export type { PickRole };

export function sortFound(items: readonly FoundPerson[], o: { chosen: ReadonlySet<string>; exclude?: ReadonlySet<string>; allowWaiting?: boolean }) {
  const fresh = items.filter((h) => !o.chosen.has(h.login.toLowerCase()));
  const inside = fresh.filter((h) => o.exclude?.has(h.login.toLowerCase()));
  const rest = fresh.filter((h) => !o.exclude?.has(h.login.toLowerCase()));
  return {
    ready: rest.filter((h) => h.in_memory || o.allowWaiting).map((person) => ({ person, invite: !person.in_memory })),
    inside,
    waiting: rest.filter((h) => !h.in_memory && !o.allowWaiting),
  };
}

export function actFields(p: PickedPerson, role: PickRole, fields: Readonly<Record<string, string>>): Record<string, string> {
  return { ...fields, login: p.login, as: role, name: p.display_name || p.login };
}

type Found = { items: FoundPerson[]; truncated: boolean };
type Phase = { kind: "idle" } | { kind: "short"; left: number } | { kind: "loading" } | ({ kind: "done"; q: string } & Found) | { kind: "error"; message: string };

const byEmailPerson = (login: string): PickedPerson => ({ login, display_name: null, department: null, title: null });

export interface PickerAct {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  roles?: boolean;
}

export interface PeoplePickerProps {
  name?: string;
  max?: number;
  self?: string;
  mode?: PickerMode;
  exclude?: readonly string[];
  allowWaiting?: boolean;
  act?: PickerAct;
  current?: readonly PickedPerson[];
  label?: string;
  placeholder?: string;
  hint?: ReactNode;
}

export function PeoplePicker({ name = "members", max = 100, self, mode = "collect", exclude, allowWaiting = false, act, current, label, placeholder, hint }: PeoplePickerProps) {
  const [picked, setPicked] = useState<PickedPerson[]>([]);
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [mounted, setMounted] = useState(false);
  const [role, setRole] = useState<PickRole>("member");
  const [done, setDone] = useState<string[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, startSend] = useTransition();
  const toast = useToasts();
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answers = useRef(new Map<string, Found>());
  const uid = useId();
  const listId = `${uid}-list`;
  const hintId = `${uid}-hint`;
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const q = normQuery(query);
  const single = mode === "single";

  useEffect(() => { setMounted(true); return () => { if (blurTimer.current) clearTimeout(blurTimer.current); }; }, []);

  useEffect(() => {
    if (!q) { setPhase({ kind: "idle" }); return; }
    if (q.length < PICKER_QUERY_MIN) { setPhase({ kind: "short", left: PICKER_QUERY_MIN - q.length }); return; }
    const key = q.toLowerCase();
    const known = answers.current.get(key);
    if (known) { setPhase({ kind: "done", q, ...known }); return; }
    setPhase({ kind: "loading" });
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/directory?q=${encodeURIComponent(q)}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
        const data = await res.json().catch(() => null) as { ok?: boolean; items?: FoundPerson[]; truncated?: boolean; message?: string; retryAfter?: number | null } | null;
        if (ctrl.signal.aborted) return;
        if (!data) { setPhase({ kind: "error", message: res.status === 401 || res.redirected ? PEOPLE_PICKER_TEXT.sessionEnded : PEOPLE_PICKER_TEXT.searchFailed }); return; }
        if (!res.ok || !data.ok) {
          setPhase({ kind: "error", message: res.status === 429
            ? PEOPLE_PICKER_TEXT.rateLimited(data.retryAfter ? PEOPLE_PICKER_TEXT.seconds(Math.ceil(data.retryAfter)) : PEOPLE_PICKER_TEXT.oneMinute)
            : data.message || PEOPLE_PICKER_TEXT.searchFailed });
          return;
        }
        const found: Found = { items: (data.items ?? []).map((h) => ({ ...h, in_memory: h.in_memory !== false })), truncated: Boolean(data.truncated) };
        answers.current.set(key, found);
        while (answers.current.size > CACHE_MAX) answers.current.delete(answers.current.keys().next().value!);
        setPhase({ kind: "done", q, ...found });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPhase({ kind: "error", message: PEOPLE_PICKER_TEXT.networkFailed });
      }
    }, PICKER_DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [q]);

  const chosen = new Set([...picked.map((p) => p.login.toLowerCase()), ...(self ? [self.toLowerCase()] : [])]);
  const inProject = new Set([...(exclude ?? []), ...done].map((x) => x.toLowerCase()));
  const sorted = phase.kind === "done" && phase.q === q
    ? sortFound(phase.items, { chosen, exclude: single ? undefined : inProject, allowWaiting })
    : { ready: [], inside: [], waiting: [] };
  const typed = q.toLowerCase();
  const typedEmail = mode === "collect" && looksLikeEmail(typed) && !chosen.has(typed) ? typed : null;
  const byEmail = phase.kind === "error" && typedEmail ? typedEmail : null;
  const members = single && !q ? (current ?? []).filter((p) => !chosen.has(p.login.toLowerCase())) : [];
  const options: Array<{ person: PickedPerson; email?: boolean; invite?: boolean }> = [
    ...members.map((person) => ({ person })),
    ...sorted.ready.map((r) => ({ person: r.person, invite: r.invite })),
    ...(byEmail ? [{ person: byEmailPerson(byEmail), email: true }] : []),
  ];
  const full = !single && mode === "collect" && picked.length >= max;
  const chosenOne = single ? picked[0] ?? null : null;
  const showMenu = open && !full && !chosenOne && (q.length > 0 || members.length > 0);

  useEffect(() => { setActive(options.length ? 0 : -1); }, [phase, byEmail, members.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  function add(people: PickedPerson[]) {
    setPicked((xs) => {
      const have = new Set([...xs.map((x) => x.login.toLowerCase()), ...(self ? [self.toLowerCase()] : [])]);
      const out = [...xs];
      for (const p of people) {
        if (out.length >= max || have.has(p.login.toLowerCase())) continue;
        have.add(p.login.toLowerCase());
        out.push(p);
      }
      return out;
    });
  }

  function call(p: PickedPerson) {
    if (!act || sending) return;
    const data = new FormData();
    for (const [k, v] of Object.entries(actFields(p, act.roles ? role : "member", act.fields))) data.set(k, v);
    startSend(async () => {
      const res = await act.action(null, data);
      if (!res) return;
      setNote({ ok: res.ok, text: res.message });
      if (res.ok) setDone((xs) => [...xs, p.login.toLowerCase()]);
      toast?.(toastFrom(res, act.action));
    });
  }

  function pick(p: PickedPerson) {
    if (chosen.has(p.login.toLowerCase()) || full) return;
    if (mode === "act") call(p);
    else if (single) setPicked([p]);
    else add([p]);
    setQuery("");
    setOpen(false);
    if (!single) inputRef.current?.focus();
  }

  function remove(login: string) {
    setPicked((xs) => xs.filter((x) => x.login !== login));
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function onChange(raw: string) {
    const split = mode === "collect" ? takeEmails(raw) : null;
    if (split) { add(split.emails.map(byEmailPerson)); setQuery(split.rest); }
    else setQuery(raw);
    setOpen(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = options.length;
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); if (n) setActive((i) => (showMenu ? (i + 1) % n : 0)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setOpen(true); if (n) setActive((i) => (showMenu ? (i <= 0 ? n - 1 : i - 1) : n - 1)); return; }
    if (e.key === "Escape") { if (showMenu) { e.preventDefault(); setOpen(false); } return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const o = options[active] ?? (n === 1 ? options[0] : undefined);
      if (showMenu && o) pick(o.person);
    }
  }

  const status = phase.kind === "short" ? moreChars(phase.left)
    : phase.kind === "loading" ? PEOPLE_PICKER_TEXT.searching
    : phase.kind === "error" ? phase.message
    : phase.kind === "done" && phase.q === q && !options.length && !sorted.waiting.length && !sorted.inside.length
      ? PEOPLE_PICKER_TEXT.notFound
      : null;
  const leftover = mode === "collect" && !showMenu && q && !full ? (typedEmail ? null : PEOPLE_PICKER_TEXT.notSelected(q)) : null;
  const submitted = [...picked.map((p) => p.login), ...(typedEmail && picked.length < max ? [typedEmail] : [])];
  const fieldLabel = label ?? (mode === "act" ? PEOPLE_PICKER_TEXT.inviteColleague : single ? PEOPLE_PICKER_TEXT.newOwner : picked.length ? PEOPLE_PICKER_TEXT.inviteAnother : PEOPLE_PICKER_TEXT.inviteColleague);
  const holder = placeholder ?? (picked.length && mode === "collect" ? PEOPLE_PICKER_TEXT.anotherPlaceholder : PEOPLE_PICKER_TEXT.placeholder);
  const defaultHint = mode === "act"
    ? PEOPLE_PICKER_TEXT.actHint
    : single ? PEOPLE_PICKER_TEXT.singleHint
    : PEOPLE_PICKER_TEXT.collectHint;

  return (
    <div className={`pp pp-${mode}`}>
      {!single && picked.length ? (
        <ul className="pp-list" aria-label={PEOPLE_PICKER_TEXT.inviteToProject}>
          {picked.map((p) => (
            <li key={p.login} className="pp-row">
              <span className="pp-ava" aria-hidden="true">{p.display_name ? initials(p) : <Icon name="mail" />}</span>
              <span className="pp-who">
                <b>{p.display_name || p.login}</b>
                <small>{mailBreak([personSub(p), p.display_name ? p.login : PEOPLE_PICKER_TEXT.emailPending].filter(Boolean).join(" · "))}</small>
              </span>
              <button type="button" className="pp-remove" onClick={() => remove(p.login)} aria-label={PEOPLE_PICKER_TEXT.removePerson(p.display_name || p.login)} title={PEOPLE_PICKER_TEXT.remove}>
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {chosenOne ? (
        <div className="pp-row pp-chosen">
          <span className="pp-ava" aria-hidden="true">{initials(chosenOne)}</span>
          <span className="pp-who"><b>{chosenOne.display_name || chosenOne.login}</b><small>{mailBreak([personSub(chosenOne), chosenOne.login].filter(Boolean).join(" · "))}</small></span>
          <button type="button" className="btn sm" onClick={() => remove(chosenOne.login)}>{PEOPLE_PICKER_TEXT.chooseAnother}</button>
        </div>
      ) : full ? <p className="pp-status">{rich(PEOPLE_PICKER_TEXT.limit, null, { value1: max })}</p> : (
        <div className="pp-line">
          <div className="pp-field">
            <Icon name="search" className="ic pp-ic" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={fieldLabel}
              aria-autocomplete="list"
              aria-expanded={showMenu}
              aria-controls={listId}
              aria-activedescendant={showMenu && active >= 0 && options[active] ? optionId(active) : undefined}
              aria-describedby={hintId}
              aria-busy={sending || undefined}
              value={query}
              onChange={(e) => onChange(e.target.value)}
              onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setOpen(true); }}
              onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
              onKeyDown={onKeyDown}
              placeholder={holder}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={300}
            />
            {showMenu ? (
              <div className="pp-menu">
                <ul id={listId} role="listbox" aria-label={PEOPLE_PICKER_TEXT.suggestions} hidden={!options.length && !sorted.waiting.length && !sorted.inside.length}>
                  {members.length ? <li role="presentation" className="pp-sep pp-sep-top">{PEOPLE_PICKER_TEXT.currentMembers}</li> : null}
                  {options.map((o, i) => (
                    <li
                      key={o.person.login}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      className={i === active ? "pp-opt is-active" : "pp-opt"}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(o.person)}
                    >
                      <span className="pp-ava" aria-hidden="true">{o.email ? <Icon name="mail" /> : initials(o.person)}</span>
                      <span className="pp-who">
                        <b>{mailBreak(o.email ? PEOPLE_PICKER_TEXT.inviteByEmail(o.person.login) : o.person.display_name || o.person.login)}</b>
                        <small>{o.email ? PEOPLE_PICKER_TEXT.emailSearchFailed
                          : mailBreak([personSub(o.person), o.person.login, ...(o.invite ? [PEOPLE_PICKER_TEXT.invitePlain] : [])].filter(Boolean).join(" · "))}</small>
                      </span>
                      {mode === "act" ? <span className="btn sm pp-call" aria-hidden="true"><Icon name="plus" />{o.invite ? PEOPLE_PICKER_TEXT.invite : PEOPLE_PICKER_TEXT.inviteShort}</span> : null}
                    </li>
                  ))}
                  {sorted.inside.map((p) => (
                    <li key={p.login} role="option" aria-disabled="true" aria-selected={false} className="pp-opt is-off" onMouseDown={(e) => e.preventDefault()}>
                      <span className="pp-ava" aria-hidden="true">{initials(p)}</span>
                      <span className="pp-who"><b>{p.display_name || p.login}</b><small>{[personSub(p), PEOPLE_PICKER_TEXT.alreadyMember].filter(Boolean).join(" · ")}</small></span>
                    </li>
                  ))}
                  {sorted.waiting.length ? <li role="presentation" className="pp-sep">{PEOPLE_PICKER_TEXT.notSignedIn}</li> : null}
                  {sorted.waiting.map((p) => (
                    <li key={p.login} role="option" aria-disabled="true" aria-selected={false} className="pp-opt is-off" onMouseDown={(e) => e.preventDefault()}>
                      <span className="pp-ava" aria-hidden="true">{initials(p)}</span>
                      <span className="pp-who">
                        <b>{p.display_name || p.login}</b>
                        <small>{mailBreak([personSub(p), p.login].filter(Boolean).join(" · "))} — {PEOPLE_PICKER_TEXT.waitingPlain}</small>
                      </span>
                    </li>
                  ))}
                </ul>
                {status ? <p className="pp-status" role="status">{status}</p> : null}
                {phase.kind === "done" && phase.q === q && phase.truncated ? <p className="pp-status">{PEOPLE_PICKER_TEXT.firstTen}</p> : null}
              </div>
            ) : null}
          </div>
          {mode === "act" && act?.roles ? (
            <label className="pp-role">
              <span className="vis-hidden">{PEOPLE_PICKER_TEXT.role}</span>
              <select value={role} onChange={(e) => setRole(e.target.value === "reader" ? "reader" : "member")}>
                <option value="member">{PICK_ROLE_TITLES.member}</option>
                <option value="reader">{PICK_ROLE_TITLES.reader}</option>
              </select>
            </label>
          ) : null}
        </div>
      )}

      {sending ? <p className="pp-status" role="status">{PEOPLE_PICKER_TEXT.inviting}</p> : note ? <p className={note.ok ? "pp-status ok-text" : "pp-warn"} role="status">{note.text}</p> : null}
      {leftover ? <p className="pp-warn" role="status">{leftover}</p> : null}
      <p className="pp-hint" id={hintId}>{hint ?? defaultHint}</p>
      {mounted && mode === "collect" ? <input type="hidden" name={name} value={submitted.join("\n")} /> : null}
      {mounted && single ? <><input type="hidden" name={name} value={chosenOne?.login ?? ""} /><input type="hidden" name={`${name}_name`} value={chosenOne?.display_name || chosenOne?.login || ""} /></> : null}
    </div>
  );
}
