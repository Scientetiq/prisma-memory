"use client";
import { HEALTH_DEGRADED_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface DegradedCheck { name: string; title: string; detail: string | null }

export const CHECK_PAGES: Readonly<Record<string, string>> = {
  settings: "/admin/settings", embedder: "/admin/settings", platform: "/admin/settings", storage: "/admin/settings",
  origin_allowlist: "/admin/settings", t1_gate: "/admin/settings", llm: "/admin/settings", test_hooks: "/admin/settings",
  ldap: "/admin/ldap", group_sync: "/admin/ldap", oidc: "/admin/sso", smtp: "/admin/smtp", open_check: "/admin/open-check",
  oauth: "/admin/settings", models: "/admin/settings",
  class_consistency: "/admin/unprocessed", converter: "/admin/unprocessed",
};

export const fullHere = (path: string, checks: ReadonlyArray<{ name: string }>): boolean =>
  path === "/admin" || checks.some((c) => { const p = CHECK_PAGES[c.name]; return Boolean(p) && (path === p || path.startsWith(`${p}/`)); });

const SEEN_KEY = "memory.health.seen";

export function newSince(prev: readonly string[] | null, now: readonly string[]): Set<string> {
  return prev ? new Set(now.filter((c) => !prev.includes(c))) : new Set();
}

export function HealthDegraded({ checks, meta, explain = HEALTH_DEGRADED_TEXT.genericExplain }: { checks: DegradedCheck[]; meta: string; explain?: string }) {
  const path = usePathname() ?? "";
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const codes = checks.map((c) => c.name).sort().join(",");
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SEEN_KEY);
      const prev = raw === null ? null : raw.split(",").filter(Boolean);
      setFresh(newSince(prev, codes.split(",").filter(Boolean)));
      window.localStorage.setItem(SEEN_KEY, codes);
    } catch { }
  }, [codes]);

  const full = fullHere(path, checks);
  const list = (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.name} title={c.name}>
          <strong>{c.title}</strong>{c.detail ? <> — {c.detail}</> : null}
          {fresh.has(c.name) ? <> <span className="chip amber">{HEALTH_DEGRADED_TEXT.fresh}</span></> : null}
        </li>
      ))}
    </ul>
  );
  const head = (
    <span>{rich(HEALTH_DEGRADED_TEXT.statusLine, { mark1: (children) => <strong>{children}</strong> }, { value1: <span className="dot" aria-hidden="true" />, value2: checks.length ? ` (${checks.length})` : "", value3: fresh.size ? <>{rich(HEALTH_DEGRADED_TEXT.freshCount, null, { value1: fresh.size })}</> : null })}</span>
  );

  if (full) {
    return (
      <div className="health warn" role="status">
        {head}
        {meta ? <span className="meta">· {meta}</span> : null}
        <p className="explain">{explain}</p>
        {checks.length ? list : null}
      </div>
    );
  }
  return (
    <details className="health warn compact" role="status">
      <summary>{head}
        {checks.length ? <>{rich(HEALTH_DEGRADED_TEXT.failedChecks, null, { value1: checks.map((c, i) => (
          <span key={c.name} title={c.name}>{i ? ", " : ""}{c.title}{fresh.has(c.name) ? <> <span className="chip amber">{HEALTH_DEGRADED_TEXT.fresh}</span></> : null}</span>
        )) })}</> : null}
        {" "}<span className="more">— <span className="more-word">{HEALTH_DEGRADED_TEXT.details}</span></span></summary>
      <p className="explain">{explain} <Link href="/admin" prefetch={false}>{HEALTH_DEGRADED_TEXT.overview}</Link></p>
      {meta ? <p className="meta">{meta}</p> : null}
    </details>
  );
}
