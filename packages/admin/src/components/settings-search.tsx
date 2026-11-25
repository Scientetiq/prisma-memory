"use client";
import { SETTINGS_SEARCH_TEXT } from "../messages/components";

import { useId, useMemo, useState } from "react";
import { searchSettings, type SettingIndexEntry } from "@/lib/setting-labels";

export function SettingsSearch({ index, initial = "" }: { index: SettingIndexEntry[]; initial?: string }) {
  const [q, setQ] = useState(initial);
  const found = useMemo(() => searchSettings(index, q), [index, q]);
  const id = useId();
  return (
    <form className="settings-search" role="search" action="/admin/settings" method="get" onSubmit={(e) => { if (found.length) { e.preventDefault(); window.location.href = found[0]!.href; } }}>
      <label className="field-label" htmlFor={id}>{SETTINGS_SEARCH_TEXT.label}</label>
      <input id={id} type="search" name="q" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-hint`} aria-controls={`${id}-list`} />
      <span className="field-hint" id={`${id}-hint`}>{SETTINGS_SEARCH_TEXT.hint}</span>
      {q.trim() ? (
        found.length ? (
          <ul className="settings-found" id={`${id}-list`}>
            {found.map((e) => (
              <li key={e.path}>
                <a href={e.href}>{e.label}</a> <span className="muted small">{e.section} · <code className="code">{e.path}</code></span>
              </li>
            ))}
          </ul>
        ) : <p className="muted small" id={`${id}-list`} role="status">{SETTINGS_SEARCH_TEXT.empty}</p>
      ) : null}
    </form>
  );
}
