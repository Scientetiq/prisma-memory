import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getHealth } from "@/lib/gateway";
import { readSession } from "@/lib/session";
import { readAdminView } from "@/lib/view-as";
import { HealthBanner, type BannerMode } from "./health-banner";
import { PageHead } from "./ui";
import { AuditorBar } from "./view-as";

export async function PageFrame({ title, lead, actions, allowAuditor, banner = "compact", children }: { title: string; lead?: ReactNode; actions?: ReactNode; allowAuditor?: boolean; banner?: BannerMode; children: ReactNode }) {
  const [session, view] = await Promise.all([readSession(), readAdminView()]);
  if (view === "auditor" && !allowAuditor) redirect("/admin/audit");
  const health = await getHealth(session?.token);
  return (
    <div className="panel-page">
      <HealthBanner health={health} mode={banner} />
      {view === "auditor" ? <AuditorBar /> : null}
      <PageHead title={title} lead={lead} actions={actions} />
      {children}
    </div>
  );
}
