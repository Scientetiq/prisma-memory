import { FULL, AUDITOR, TEXT } from "../../../messages/panel-home";
import type { ReactNode } from "react";
import { Shell, type NavSection } from "@/components/shell";
import { ADMIN_PLANE_PAGES } from "@/lib/admin-tabs";
import { adminPlaneSeparate } from "@/lib/gateway-transport";
import { NAV_ICONS as I } from "@/lib/nav-icons";
import { requireSession } from "@/lib/session";
import { readAdminView } from "@/lib/view-as";
import { logoutAction } from "../login/actions";
import { ModeBanner } from "./security-mode/mode-banner";
import { models } from "@/messages/m-models";
import { SignOutEverywhere } from "./admins/sessions";





const adminPlane = (auditor: boolean): NavSection[] => adminPlaneSeparate()
  ? [{ label: TEXT.adminPlane, items: ADMIN_PLANE_PAGES.filter((p) => !auditor || p.auditor).map((p) => ({ href: p.href, title: p.title, icon: I.settings })) }]
  : [];

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const [session, view] = await Promise.all([requireSession(), readAdminView()]);
  const auditor = view === "auditor" || session.role === "security_auditor";
  return (
    <Shell
      sub={auditor ? TEXT.audit : TEXT.adminPanel}
      home={auditor ? "/admin/audit" : "/admin"}
      sections={[...(auditor ? AUDITOR : FULL), ...(auditor ? [] : [{ items: [{ href: "/admin/models", title: models.title, icon: I.settings }] }]), ...adminPlane(auditor)]}
      user={{ name: session.login, sub: session.role === "security_auditor" ? TEXT.securityAuditor : auditor ? TEXT.auditorView : TEXT.localAdministrator }}
      logout={logoutAction}
      logoutTitle={TEXT.signOutOfThePanel}
      accountActions={<SignOutEverywhere />}
    >
      <ModeBanner />
      {children}
    </Shell>
  );
}
