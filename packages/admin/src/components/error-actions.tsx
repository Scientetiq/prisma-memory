"use client";
import { ERROR_ACTIONS_TEXT } from "../messages/components";

import * as nav from "next/navigation";
import { useTransition } from "react";

export const homeOf = (pathname: string | null | undefined): string => (pathname === "/admin" || pathname?.startsWith("/admin/") ? "/admin" : "/");

function usePath(): string | null {
  try { return nav.usePathname(); } catch { return null; }
}

export function HomeLink({ home, className = "btn sm" }: { home?: string; className?: string }) {
  const path = usePath();
  const to = home ?? homeOf(path);
  if (path === to) return null;
  return <a className={className} href={to}>{ERROR_ACTIONS_TEXT.home}</a>;
}

export function SectionError({ digest, reset, home, itNote }: { digest?: string; reset: () => void; home: string; itNote?: string }) {
  const router = nav.useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="notice danger load-error" role="alert" data-error-code="section_error">
      <strong>{ERROR_ACTIONS_TEXT.failed}</strong> {ERROR_ACTIONS_TEXT.retryHint}<div className="missing-actions">
        <button type="button" className="btn" disabled={pending} onClick={() => start(() => { router.refresh(); reset(); })}>{pending ? ERROR_ACTIONS_TEXT.retrying : ERROR_ACTIONS_TEXT.retry}</button>
        <a className="btn" href={home}>{ERROR_ACTIONS_TEXT.home}</a>
      </div>
      {digest || itNote ? (
        <details className="it-details">
          <summary>{ERROR_ACTIONS_TEXT.details}</summary>
          {digest ? <code className="code">{digest}</code> : null}{itNote ? <span className="muted small"> {itNote}</span> : null}
        </details>
      ) : null}
    </div>
  );
}
