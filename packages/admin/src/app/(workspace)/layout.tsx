import { layoutText as M } from "@/messages/ws-layout";
import { rich } from "@/i18n/rich";
import { derived } from "@/i18n/runtime";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RetryLater } from "@/components/retry-later";
import { Shell, type NavSection } from "@/components/shell";
import { LocalTime } from "@/components/local-time";
import { ItDetails, Notice } from "@/components/ui";
import { getMe } from "@/lib/me";
import { externalSummary, navSummary } from "@/lib/nav";
import { externalMenuShown } from "@/lib/external-access";
import { ExternalNotices, loadExternalNotices } from "@/components/external-notices";
import { profileOn } from "@/lib/my-profile";
import { profileMemo, shellUser } from "@/lib/nav-cache";
import { isOrgCurator } from "@/lib/org-review-api";
import { toolErrorMessage } from "@/lib/mcp";
import { NAV_ICONS as I } from "@/lib/nav-icons";
import { MEETINGS_PLAIN, SECTION_GROUPS, SECTION_HINTS, SECTION_TITLES as T } from "@/lib/plain";
import { previewBarText } from "@/lib/preview";
import { unavailableText } from "@/lib/retry";
import { myTeams, teamMenuTitle } from "@/lib/spaces";
import { loginUrl, requireUserSession } from "@/lib/user-session";
import { exitPreviewAction, logoutAction } from "./actions";

const ROLE_TITLES = derived(() => ({ head: M.manager, employee: M.employee } as const));

export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const session = await requireUserSession();
  const me = await getMe(session.key);
  if (!me.ok && me.code === "unauthorized") redirect(session.preview ? "/admin/preview?expired=1" : await loginUrl({ expired: true }));

  const previewBar = session.preview ? (
    <div className="preview-bar" role="status">
      <span className="who">{previewBarText(session.preview.persona, ROLE_TITLES[session.preview.role])}</span>
      <form action={exitPreviewAction}><button type="submit" className="btn sm">{rich(M.leavePreview, null)}</button></form>
    </div>
  ) : null;

  const teamTitle = teamMenuTitle(me.ok ? myTeams(me.data.spaces).length : 0);
  const nav = me.ok && !session.preview ? (await navSummary(session.key)).data : null;
  const ext = me.ok && !session.preview ? (await externalSummary(session.key)).data : null;
  const extNotices = ext ? await loadExternalNotices(session.key, ext.unseen_notices) : [];
  const fresh = nav?.meetings.new ?? 0, asked = nav?.meetings.asked ?? 0;
  const plans = nav?.plans_pending ?? 0;
  const toConfirm = nav?.corrections_to_confirm ?? 0;
  const curator = me.ok && !session.preview && isOrgCurator(me.data);
  const waiting = curator ? nav?.org_review_waiting ?? null : null;
  const custody = nav?.custody ?? 0;
  const sections: NavSection[] = [
    { items: [
      { href: "/", title: T.overview, icon: I.overview, exact: true },
      { href: "/materials", title: T.materials, icon: I.materials },
      { href: "/search", title: T.search, icon: I.search },
      { href: "/browse", title: T.browse, icon: I.spaces, also: ["/projects"] },
      { href: "/meetings", title: T.meetings, icon: I.meetings, count: fresh || null, countLabel: MEETINGS_PLAIN.navNew(fresh),
        alert: asked ? { n: asked, label: MEETINGS_PLAIN.navAsked(asked) } : null },
      { href: "/colleagues", title: T.colleagues, icon: I.people },
    ] },
    ...(teamTitle || curator || custody > 0 ? [{ label: SECTION_GROUPS.owner, items: [
      ...(teamTitle ? [{ href: "/team", title: teamTitle, icon: I.team }] : []),
      ...(curator ? [{ href: "/review", title: T.review, icon: I.review, count: waiting || null }] : []),
      ...(custody > 0 ? [{ href: "/custody", title: T.custody, icon: I.custody, count: custody, hint: SECTION_HINTS.custody }] : []),
    ] }] : []),
    { label: SECTION_GROUPS.personal, items: [
      ...(profileOn(nav) ? [{ href: "/me/profile", title: T.profile, icon: I.profile, hint: SECTION_HINTS.profile }] : []),
      { href: "/activity", title: T.activity, icon: I.activity },
      ...(session.preview ? [] : [{ href: "/connect", title: T.connect, icon: I.connect, hint: SECTION_HINTS.connect }]),
      // "What my agent sees": the person's own numbers and choices — not in a preview session
      ...(session.preview ? [] : [{ href: "/agent-view", title: T.agentView, icon: I.agentView, hint: SECTION_HINTS.agentView }]),
      ...(session.preview ? [] : [{ href: "/keys", title: T.keys, icon: I.keys, hint: SECTION_HINTS.keys }]),
      ...(session.preview ? [] : [{ href: "/consents", title: T.consents, icon: I.consents, hint: SECTION_HINTS.consents }]),
      ...(externalMenuShown(ext) ? [{ href: "/external", title: T.external, icon: I.external, hint: SECTION_HINTS.external }] : []),
    ] },
    ...(session.preview ? [] : [{ label: SECTION_GROUPS.service, items: [
      { href: "/plans", title: T.plans, icon: I.plans, count: plans || null, hint: SECTION_HINTS.plans },
      { href: "/corrections", title: T.corrections, icon: I.corrections, count: toConfirm || null, hint: SECTION_HINTS.corrections },
      { href: "/trash", title: T.trash, icon: I.trash, hint: SECTION_HINTS.trash },
    ] }]),
  ];
  const user = me.ok ? shellUser(me.data) : profileMemo.last(session.key) ?? { name: M.workspace, sub: "" };
  const expiring = nav?.expiring_keys ?? [];
  const oauthExpiryNotice = nav?.oauth_expiring ? (
    <Notice tone="warn">{rich(M.yourAgentConnectionExpiresSoonCheck, { tag0: (children) => <strong>{children}</strong>, tag1: (children) => <Link href="/connect">{children}</Link> })}</Notice>
  ) : null;
  const oauthOn = nav?.oauth_enabled === true;
  const expiringNotice = expiring.length ? (
    <Notice tone="warn">
      <strong>{expiring.length === 1 ? M.yourAgentKeyExpiresSoon : M.yourAgentKeysExpireSoon(expiring.length)}:</strong>{" "}
      {expiring.map((k, i) => <span key={k.id}>{rich(M.validThrough, { tag0: () => <LocalTime iso={k.expires_at} relative={false} /> }, { value0: i ? ", " : "", value1: k.client_label ?? `${k.key_prefix}…` })}</span>)}.{" "}
      {oauthOn
        ? <>{rich(M.connectionsCannotBeExtendedReconnectYour, { tag0: (children) => <Link href="/connect">{children}</Link>, tag1: (children) => <Link href="/keys">{children}</Link> })}</>
        : <>{rich(M.keysCannotBeExtendedIssueA, { tag0: (children) => <Link href="/keys">{children}</Link> })}</>}
    </Notice>
  ) : null;
  return (
    <Shell sub={session.preview ? M.preview : M.workspace2} home="/" sections={sections} user={user}
      logout={logoutAction} logoutTitle={session.preview ? M.leavePreview : M.signOutOfTheWorkspace} beforeMain={previewBar}>
      {me.ok ? <>{expiringNotice}{oauthExpiryNotice}<ExternalNotices items={extNotices} />{children}</> : me.code === "rate_limited" ? (
        <Notice tone="info"><RetryLater seconds={me.retryAfter ?? null} limited carry="workspace" /></Notice>
      ) : (
        <Notice tone="danger">{rich(M.ifThisContinuesContactTheAdministrator, { tag0: (children) => <strong>{children}</strong>, tag1: () => <RetryLater seconds={me.retryAfter ?? null} carry="workspace" />, tag2: () => <ItDetails code={me.code} status={me.status} message={toolErrorMessage(me)} /> }, { value0: unavailableText(me.code) })}</Notice>
      )}
    </Shell>
  );
}
