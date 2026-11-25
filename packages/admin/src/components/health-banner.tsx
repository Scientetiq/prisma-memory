import { HEALTH_BANNER_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import Link from "next/link";
import { bannerExplanation, versionText } from "@/lib/checks";
import type { HealthView } from "@/lib/gateway";
import { CHECK_TITLES } from "@/lib/labels";
import { HealthDegraded } from "./health-degraded";

import { STATUS_TITLES } from "../messages/components";

export type BannerMode = "full" | "compact" | "critical";

export function HealthBanner({ health, mode = "full" }: { health: HealthView; mode?: BannerMode }) {
  if (!health.reachable) {
    return (
      <div className="health fail" role="alert">
        <span><span className="dot" aria-hidden="true" /><strong>{HEALTH_BANNER_TEXT.unreachable}</strong> {health.message}</span>
      </div>
    );
  }
  const failed = Object.entries(health.checks ?? {}).filter(([, c]) => !c.ok);
  const meta = [health.instance ? HEALTH_BANNER_TEXT.instance(health.instance) : "", versionText(health.version)].filter(Boolean).join(" · ");

  if (health.status === "ok") {
    return (
      <div className="health ok" role="status">
        <span>{rich(HEALTH_BANNER_TEXT.statusLine, null, { value1: <span className="dot" aria-hidden="true" />, value2: <strong>{STATUS_TITLES.ok}</strong> })}</span>
        {meta ? <span className="meta">· {meta}</span> : null}
      </div>
    );
  }

  if (health.status === "degraded" && mode === "critical") return null;
  if (health.status === "degraded") {
    return <HealthDegraded meta={meta} explain={bannerExplanation(failed.map(([name]) => name))}
      checks={failed.map(([name, c]) => ({ name, title: CHECK_TITLES[name] ?? name, detail: c.detail ?? null }))} />;
  }

  const settingsMissing = health.checks?.settings?.ok === false;
  return (
    <div className={health.status === "fail_closed" ? "health fail" : "health warn"} role="alert">
      <span>{rich(HEALTH_BANNER_TEXT.statusLine, null, { value1: <span className="dot" aria-hidden="true" />, value2: <strong>{STATUS_TITLES[health.status as keyof typeof STATUS_TITLES] ?? health.status}</strong> })}</span>
      {meta ? <span className="meta">· {meta}</span> : null}
      {health.status === "fail_closed" ? (
        <p className="explain">
          {settingsMissing
            ? <>{rich(HEALTH_BANNER_TEXT.missingSettings, { mark1: (children) => <Link href="/admin/settings" prefetch={false}>{children}</Link> })}</>
            : <>{rich(HEALTH_BANNER_TEXT.failClosed, { mark1: (children) => <Link href="/admin/settings" prefetch={false}>{children}</Link> })}</>}
        </p>
      ) : (
        <p className="explain">{bannerExplanation(failed.map(([name]) => name))}</p>
      )}
      {failed.length ? (
        <ul className="checks">
          {failed.map(([name, c]) => (
            <li key={name} title={name}><strong>{CHECK_TITLES[name] ?? name}</strong>{c.detail ? <> — {c.detail}</> : null}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
