import { UI_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import type { ReactNode } from "react";
import { HomeLink } from "@/components/error-actions";
import { Icon, type IconName } from "@/components/icons";
import { RetryLater } from "@/components/retry-later";
import type { Result } from "@/lib/api";
import { technicalCode } from "@/lib/mcp-parse";
import { retryable, unavailableText } from "@/lib/retry";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "muted" | "brand" | "violet";
const TONE_CLASS: Record<Tone, string> = { neutral: "chip", ok: "chip green", warn: "chip amber", danger: "chip red", info: "chip blue", muted: "chip muted", brand: "chip brand", violet: "chip violet" };

export function Badge({ tone = "neutral", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return <span className={TONE_CLASS[tone]} title={title}>{children}</span>;
}

export function Code({ children, title }: { children: ReactNode; title?: string }) {
  return <code className="code" title={title}>{children}</code>;
}

export function Chips({ items, empty = "—" }: { items: readonly string[] | null | undefined; empty?: string }) {
  if (!items?.length) return <span className="muted">{empty}</span>;
  return <span className="tags">{items.map((x) => <span className="tag" key={x}>{x}</span>)}</span>;
}

export type NoticeTone = "ok" | "danger" | "warn" | "info" | "brand";
export function Notice({ tone, role, children }: { tone: NoticeTone; role?: "alert" | "status"; children: ReactNode }) {
  return <div className={`notice ${tone}`} role={role ?? (tone === "danger" ? "alert" : "status")}>{children}</div>;
}

export function ItDetails({ code, status, message }: { code: string; status?: number; message?: string }) {
  return (
    <details className="it-details">
      <summary>{UI_TEXT.details}</summary>
      <code className="code">{code}{status ? ` · HTTP ${status}` : ""}</code>{message ? <span className="muted small"> {message}</span> : null}
    </details>
  );
}

const PLAIN_CODES = new Set(["rate_limited", "gateway_unreachable", "fail_closed"]);

export function loadErrorText(code: string, message: string, status?: number): string {
  if (PLAIN_CODES.has(code)) return unavailableText(code);
  if (code === "response_lost") return UI_TEXT.responseLost;
  if (code.startsWith("ldap_") && status !== undefined && status >= 500) return UI_TEXT.directoryUnavailable;
  if (technicalCode(code) || (status !== undefined && status >= 500) || !message) return UI_TEXT.failed;
  return message;
}

export function LoadError({ result, what, retry = true, home }: { result: Extract<Result<unknown>, { ok: false }> | { code: string; message: string; status?: number; retryAfter?: number }; what: string; retry?: boolean; home?: string | false }) {
  const status = "status" in result ? result.status : undefined;
  const retryAfter = "retryAfter" in result && typeof result.retryAfter === "number" ? result.retryAfter : null;
  const limited = result.code === "rate_limited";
  const text = loadErrorText(result.code, result.message, status);
  return (
    <div className={`notice ${limited ? "info" : "danger"} load-error`} role={limited ? "status" : "alert"} data-error-code={result.code}>
      <strong>{rich(UI_TEXT.loadFailed, null, { value1: what })}</strong>{" "}
      {limited && retry ? null : <>{text} </>}
      {retry && retryable(result.code, status) ? <RetryLater seconds={retryAfter} limited={limited} /> : null}
      {home === false ? null : <> <HomeLink home={home} /></>}
      <ItDetails code={result.code} status={status} message={result.message && text !== result.message ? result.message : undefined} />
    </div>
  );
}

export function Empty({ children, icon, action }: { children: ReactNode; icon?: IconName; action?: ReactNode }) {
  if (!icon && !action) return <div className="empty">{children}</div>;
  return (
    <div className="empty empty-rich">
      {icon ? <span className="ichip tone-gray" aria-hidden="true"><Icon name={icon} /></span> : null}
      <div className="empty-body">
        <p>{children}</p>
        {action ? <div className="empty-action">{action}</div> : null}
      </div>
    </div>
  );
}

export function Section({ title, hint, children, id, actions, fold, icon }: { title: string; hint?: ReactNode; children: ReactNode; id?: string; actions?: ReactNode;
  fold?: { open: boolean; state?: ReactNode }; icon?: IconName }) {
  const hid = id ? `${id}-title` : undefined;
  const head = <h2 className="sec-title" id={hid}>{icon ? <Icon name={icon} /> : null}{title}</h2>;
  if (fold) {
    return (
      <section className="sec" id={id} aria-labelledby={hid}>
        <details className="sec-fold" open={fold.open || undefined}>
          <summary>{head}{fold.state ? <span className="sec-state">{fold.state}</span> : null}</summary>
          {actions ? <div className="sec-head">{actions}</div> : null}
          {hint ? <p className="hint">{hint}</p> : null}
          {children}
        </details>
      </section>
    );
  }
  return (
    <section className="sec" id={id} aria-labelledby={hid}>
      <div className="sec-head">
        {head}
        {actions}
      </div>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export { TableWrap } from "./table-wrap";

export function Field({ label, hint, children, wide, className }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <label className={["field", wide ? "field-wide" : "", className ?? ""].filter(Boolean).join(" ")}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function PageHead({ title, lead, actions }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lead ? <p className="sub">{lead}</p> : null}
      </div>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </header>
  );
}
