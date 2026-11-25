"use client";
import { PERSON_SUGGEST_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { initials, moreChars, normQuery, PICKER_QUERY_MIN } from "./people-picker";

export interface SuggestPerson { id?: string; login: string; display_name: string | null; department?: string | null; title?: string | null }

const DEBOUNCE_MS = 300;
const CACHE_MAX = 60;

type Phase = { kind: "idle" } | { kind: "short"; left: number } | { kind: "loading" } | { kind: "done"; q: string; items: SuggestPerson[] } | { kind: "error"; message: string };

export const suggestSub = (p: SuggestPerson): string => [p.login, p.department, p.title].filter(Boolean).join(" · ");

function Picked({ p, fields }: { p: SuggestPerson; fields: { id?: string; login?: string; name?: string } }) {
  return (
    <>
      {fields.id && p.id ? <input type="hidden" name={fields.id} value={p.id} /> : null}
      {fields.login && p.login ? <input type="hidden" name={fields.login} value={p.login} /> : null}
      {fields.name ? <input type="hidden" name={fields.name} value={p.display_name || p.login} /> : null}
      <span className="cell-sub">{rich(PERSON_SUGGEST_TEXT.selected, null, { value1: p.display_name || p.login || PERSON_SUGGEST_TEXT.linkedPerson, value2: p.login && p.display_name ? ` · ${p.login}` : "" })}</span>
    </>
  );
}

export function PersonSuggest({ textName, pickedFields, defaultText = "", defaultPicked = null, placeholder, label, quick = [], required, id, describedBy, excludeDemo }: {
  textName: string; pickedFields: { id?: string; login?: string; name?: string }; defaultText?: string; defaultPicked?: SuggestPerson | null;
  placeholder?: string; label: string; quick?: readonly SuggestPerson[]; required?: boolean; id?: string; describedBy?: string; excludeDemo?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const [picked, setPicked] = useState<SuggestPerson | null>(defaultPicked);
  const [query, setQuery] = useState(defaultPicked ? defaultPicked.display_name || defaultPicked.login : defaultText);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const answers = useRef(new Map<string, SuggestPerson[]>());
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useId();
  const listId = `${uid}-list`, dlId = `${uid}-dl`;
  const q = normQuery(query);

  useEffect(() => { setMounted(true); return () => { if (blurTimer.current) clearTimeout(blurTimer.current); }; }, []);

  useEffect(() => {
    if (picked) { setPhase({ kind: "idle" }); return; }
    if (!q) { setPhase({ kind: "idle" }); return; }
    if (q.length < PICKER_QUERY_MIN) { setPhase({ kind: "short", left: PICKER_QUERY_MIN - q.length }); return; }
    const cached = answers.current.get(q.toLowerCase());
    if (cached) { setPhase({ kind: "done", q, items: cached }); return; }
    setPhase({ kind: "loading" });
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/admin/api/people?q=${encodeURIComponent(q)}${excludeDemo ? "&nodemo=1" : ""}`, { signal: ctl.signal, headers: { accept: "application/json" } });
        const body = await res.json().catch(() => null) as { ok?: boolean; items?: SuggestPerson[]; message?: string } | null;
        if (!res.ok || !body?.ok) { setPhase({ kind: "error", message: body?.message ?? PERSON_SUGGEST_TEXT.unavailable }); return; }
        const items = body.items ?? [];
        if (answers.current.size >= CACHE_MAX) answers.current.clear();
        answers.current.set(q.toLowerCase(), items);
        setPhase({ kind: "done", q, items });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPhase({ kind: "error", message: PERSON_SUGGEST_TEXT.unavailable });
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, picked, excludeDemo]);

  if (!mounted) {
    return (
      <>
        <input type="search" id={id} name={textName} defaultValue={defaultPicked ? "" : query} placeholder={placeholder} aria-label={label} aria-describedby={describedBy} list={quick.length ? dlId : undefined}
          autoCapitalize="none" spellCheck={false} required={required && !defaultPicked} />
        {quick.length ? <datalist id={dlId}>{quick.map((p) => <option key={p.login} value={p.login}>{p.display_name ?? p.login}</option>)}</datalist> : null}
        {defaultPicked ? <Picked p={defaultPicked} fields={pickedFields} /> : null}
      </>
    );
  }

  const options: SuggestPerson[] = !q && !picked ? [...quick] : phase.kind === "done" && phase.q === q ? phase.items : [];
  const pick = (p: SuggestPerson) => { setPicked(p); setQuery(p.display_name || p.login); setOpen(false); setActive(-1); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && options.length) { e.preventDefault(); setOpen(true); setActive((i) => (i + 1) % options.length); }
    else if (e.key === "ArrowUp" && options.length) { e.preventDefault(); setOpen(true); setActive((i) => (i <= 0 ? options.length - 1 : i - 1)); }
    else if (e.key === "Enter" && open && active >= 0 && options[active]) { e.preventDefault(); pick(options[active]!); }
    else if (e.key === "Escape") { setOpen(false); setActive(-1); }
  };
  const showList = open && (options.length > 0 || phase.kind === "short" || phase.kind === "loading" || phase.kind === "error" || (phase.kind === "done" && !phase.items.length));

  return (
    <span className="pp-field person-suggest">
      <input type="search" id={id} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list" aria-label={label} aria-describedby={describedBy}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        name={picked ? undefined : textName} value={query} placeholder={placeholder} autoCapitalize="none" spellCheck={false} required={required && !picked}
        onChange={(e) => { setQuery(e.target.value); setPicked(null); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)} onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }} onKeyDown={onKey} />
      {picked ? <Picked p={picked} fields={pickedFields} /> : null}
      {showList ? (
        <span className="pp-menu">
          <ul id={listId} role="listbox" aria-label={label}>
            {options.map((p, i) => (
              <li key={p.login} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? "pp-opt is-active" : "pp-opt"}
                onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
                <span className="pp-ava" aria-hidden="true">{initials({ display_name: p.display_name, login: p.login })}</span>
                <span className="pp-who"><b>{p.display_name || p.login}</b><small>{suggestSub(p)}</small></span>
              </li>
            ))}
          </ul>
          {!options.length && phase.kind === "short" ? <span className="pp-status">{moreChars(phase.left)}</span> : null}
          {!options.length && phase.kind === "loading" ? <span className="pp-status">{PERSON_SUGGEST_TEXT.searching}</span> : null}
          {!options.length && phase.kind === "error" ? <span className="pp-status">{phase.message}</span> : null}
          {!options.length && phase.kind === "done" ? <span className="pp-status">{PERSON_SUGGEST_TEXT.notFound}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
