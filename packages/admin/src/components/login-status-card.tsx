import { LOGIN_STATUS_CARD_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Result } from "@/lib/api";
import { formatCount } from "@/lib/plain";
import type { LoginSourceStatus } from "@/lib/types";
import { LocalTime } from "./local-time";

export function failedStepsText(c: NonNullable<LoginSourceStatus["last_check"]>, titles: Record<string, string>): string {
  const steps = c.failed_steps.length ? c.failed_steps : c.failed;
  return [...new Set(steps.map((s) => titles[s] ?? s))].join(", ");
}

export function LoginStatusCard({ status, titles, what, children }: { status: Result<LoginSourceStatus>; titles: Record<string, string>; what: string; children?: ReactNode }) {
  return (
    <div className="status-card">
      {!status.ok ? <p className="muted">{rich(LOGIN_STATUS_CARD_TEXT.unavailable, null, { value1: what, value2: status.message })}</p> : (
        <dl className="status-facts">
          <div>
            <dt>{LOGIN_STATUS_CARD_TEXT.lastCheck}</dt>
            <dd>
              {!status.data.last_check ? <span className="muted">{LOGIN_STATUS_CARD_TEXT.notInNinetyDays}</span> : (
                <>
                  <LocalTime iso={status.data.last_check.at} />{" — "}
                  {status.data.last_check.ok ? <span className="ok-text">{LOGIN_STATUS_CARD_TEXT.passed}</span>
                    : <span className="danger-text">{rich(LOGIN_STATUS_CARD_TEXT.failed, null, { value1: failedStepsText(status.data.last_check, titles) ? `: ${failedStepsText(status.data.last_check, titles)}` : "" })}</span>}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{LOGIN_STATUS_CARD_TEXT.lastSignIn}</dt>
            <dd>{status.data.last_login_at ? <LocalTime iso={status.data.last_login_at} /> : <span className="muted">{LOGIN_STATUS_CARD_TEXT.notInNinetyDays}</span>}</dd>
          </div>
          <div>
            <dt>{LOGIN_STATUS_CARD_TEXT.lastDay}</dt>
            <dd>{rich(LOGIN_STATUS_CARD_TEXT.counts, { mark1: (children) => <Link href="/admin/audit?event_type=login#events" prefetch={false}>{children}</Link> }, { value1: formatCount(status.data.logins_24h), value2: status.data.refusals_24h ? <span className="danger-text">{formatCount(status.data.refusals_24h)}</span> : 0 })}</dd>
          </div>
        </dl>
      )}
      {children ? <div className="status-actions">{children}</div> : null}
    </div>
  );
}
