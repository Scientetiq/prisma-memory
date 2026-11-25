"use client";
import { participantPickerText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent } from "react";
import type { ActionState } from "@/lib/action-state";
import { ConfirmDialog, type ConfirmSpec } from "@/components/confirm-dialog";
import { Icon } from "@/components/icons";
import { initials, moreChars, normQuery, personSub, PICKER_DEBOUNCE_MS, PICKER_QUERY_MIN, type FoundPerson } from "@/components/people-picker";
import { toastFrom, useToasts } from "@/components/toasts";
import { addParticipantConfirm, MEETING_PEOPLE_PLAIN as T } from "@/lib/plain";

const DEBOUNCE_MS = PICKER_DEBOUNCE_MS;
const CACHE_MAX = 60;
type Found = { items: FoundPerson[]; truncated: boolean };
type Phase = { kind: "idle" } | { kind: "short"; left: number } | { kind: "loading" } | ({ kind: "done"; q: string } & Found) | { kind: "error"; message: string };
type Act = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export function splitFound(items: readonly FoundPerson[], inMeeting: ReadonlySet<string>): { pick: FoundPerson[]; inside: FoundPerson[] } {
  const inside = items.filter((p) => inMeeting.has(p.login.toLowerCase()));
  return { pick: items.filter((p) => !inMeeting.has(p.login.toLowerCase())), inside };
}

export const optionSub = (p: FoundPerson): string =>
  M.optionCaption(personSub(p), p.login, p.in_memory);

export function ParticipantPicker({ id, inMeeting, action, notify = false }: { id: string; inMeeting: string[]; action: Act; notify?: boolean }) {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [asking, setAsking] = useState<{ spec: ConfirmSpec; person: FoundPerson } | null>(null);
  const [result, setResult] = useState<ActionState>(null);
  const [sending, startSend] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answers = useRef(new Map<string, Found>());
  const toast = useToasts();
  const uid = useId();
  const listId = `${uid}-list`, hintId = `${uid}-hint`;
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const q = normQuery(query);
  const inside = new Set(inMeeting.map((l) => l.toLowerCase()));

  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);

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
        if (!data) { setPhase({ kind: "error", message: res.status === 401 || res.redirected ? M.yourSessionEndedRefreshThePage : M.searchDidNotRespondTryAgain }); return; }
        if (!res.ok || !data.ok) {
          setPhase({ kind: "error", message: res.status === 429
            ? M.retryAfter(data.retryAfter ? Math.ceil(data.retryAfter) : null)
            : data.message || M.searchDidNotRespondTryAgain });
          return;
        }
        const found: Found = { items: (data.items ?? []).map((h) => ({ ...h, in_memory: h.in_memory !== false })), truncated: Boolean(data.truncated) };
        answers.current.set(key, found);
        while (answers.current.size > CACHE_MAX) answers.current.delete(answers.current.keys().next().value!);
        setPhase({ kind: "done", q, ...found });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPhase({ kind: "error", message: M.searchDidNotRespondCheckYour });
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [q]);

  const found = phase.kind === "done" && phase.q === q ? splitFound(phase.items, inside) : { pick: [], inside: [] };
  const options = found.pick;
  const showMenu = open && q.length > 0 && !asking;
  useEffect(() => { setActive(options.length ? 0 : -1); }, [phase]);   // eslint-disable-line react-hooks/exhaustive-deps

  function choose(p: FoundPerson) {
    if (sending) return;
    setOpen(false);
    setAsking({ spec: addParticipantConfirm(p.display_name || p.login, { waiting: !p.in_memory, notify }), person: p });
  }
  function confirmAdd() {
    const p = asking?.person;
    setAsking(null);
    if (!p) return;
    const data = new FormData();
    data.set("id", id); data.set("op", "add"); data.set("who", p.login); data.set("name", p.display_name || p.login);
    startSend(async () => {
      const res = await action(null, data);
      if (!res) return;
      if (toast) { toast(toastFrom(res, action)); setResult(null); } else setResult(res);
      if (res.ok) setQuery("");
      inputRef.current?.focus();
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = options.length;
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); if (n) setActive((i) => (showMenu ? (i + 1) % n : 0)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setOpen(true); if (n) setActive((i) => (showMenu ? (i <= 0 ? n - 1 : i - 1) : n - 1)); return; }
    if (e.key === "Escape") { if (showMenu) { e.preventDefault(); setOpen(false); } return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const o = options[active] ?? (n === 1 ? options[0] : undefined);
      if (showMenu && o) choose(o);
    }
  }

  const status = phase.kind === "short" ? moreChars(phase.left)
    : phase.kind === "loading" ? M.searchingPeopleWhoHaveAccessTo
    : phase.kind === "error" ? phase.message
    : phase.kind === "done" && phase.q === q && !options.length && !found.inside.length
      ? M.noMatchesAmongPeopleWithAccess
      : null;

  return (
    <div className="pp mp-picker">
      <label className="field-label" htmlFor={`${uid}-input`}>{T.addLabel}</label>
      <div className="pp-field">
        <Icon name="search" className="ic pp-ic" />
        <input
          ref={inputRef}
          id={`${uid}-input`}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showMenu}
          aria-controls={listId}
          aria-activedescendant={showMenu && active >= 0 && options[active] ? optionId(active) : undefined}
          aria-describedby={hintId}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setResult(null); }}
          onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setOpen(true); }}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
          onKeyDown={onKeyDown}
          placeholder={T.addPlaceholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={100}
          disabled={sending}
        />
        {showMenu ? (
          <div className="pp-menu">
            <ul id={listId} role="listbox" aria-label={M.matchingColleagues} hidden={!options.length && !found.inside.length}>
              {options.map((p, i) => (
                <li key={p.login} id={optionId(i)} role="option" aria-selected={i === active} className={i === active ? "pp-opt is-active" : "pp-opt"}
                  onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(p)}>
                  <span className="pp-ava" aria-hidden="true">{initials(p)}</span>
                  <span className="pp-who"><b>{p.display_name || p.login}</b><small>{optionSub(p)}</small></span>
                </li>
              ))}
              {found.inside.map((p) => (
                <li key={p.login} role="option" aria-disabled="true" aria-selected={false} className="pp-opt is-off" onMouseDown={(e) => e.preventDefault()}>
                  <span className="pp-ava" aria-hidden="true">{initials(p)}</span>
                  <span className="pp-who"><b>{p.display_name || p.login}</b><small>{M.insideCaption(personSub(p))}</small></span>
                </li>
              ))}
            </ul>
            {status ? <p className="pp-status" role="status">{status}</p> : null}
            {phase.kind === "done" && phase.q === q && phase.truncated ? <p className="pp-status">{rich(M.showingTheFirst10NarrowYour, null)}</p> : null}
          </div>
        ) : null}
      </div>
      {sending ? <p className="pp-status" role="status">{rich(M.adding, null)}</p> : null}
      {result ? <p className={result.ok ? "pp-status" : "pp-warn"} role="status">{result.message}</p> : null}
      <p className="pp-hint" id={hintId}>{T.addHint}</p>
      <ConfirmDialog spec={asking?.spec ?? null} onCancel={() => { setAsking(null); inputRef.current?.focus(); }} onConfirm={confirmAdd} />
    </div>
  );
}
