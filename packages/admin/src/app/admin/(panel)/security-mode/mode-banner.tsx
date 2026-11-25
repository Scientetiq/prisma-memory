import { MODE_BANNER_TEXT } from "../../../../messages/panel-security-mode";
import { rich } from "../../../../i18n/rich";
import Link from "next/link";
import { tryGw } from "@/lib/api";
import { adminPlaneSeparate } from "@/lib/gateway-transport";
import { modeBannerText, type ModeState } from "./view";

export async function ModeBanner() {
  if (!adminPlaneSeparate()) return null;
  const res = await tryGw<ModeState>("/api/v1/admin/security-mode", { timeoutMs: 5_000 });
  if (!res.ok) return null;
  const b = modeBannerText(res.data);
  return (
    <div className={`health ${b.tone === "warn" ? "warn" : "ok"}`} role="status" data-security-mode={res.data.mode}>{rich(MODE_BANNER_TEXT.tag1Value2Value3Tag1Tag4Tag5DetailsTag5Tag4, { tag1: (children) => <span>{children}</span>, tag5: (children) => <Link prefetch={false} href="/admin/security-mode">{children}</Link>, tag4: (children) => <span className="meta">{children}</span> }, { value2: <span className="dot" aria-hidden="true" />, value3: b.text })}</div>
  );
}
