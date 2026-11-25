import { rich } from "../../../../i18n/rich";
import { ROLE_TITLES, METHOD_TITLES, TEXT } from "../../../../messages/panel-admins";
import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, Empty, LoadError, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { AdminSessions } from "./sessions";

export function generateMetadata(): Metadata { return { title: TEXT.administrators }; }

export interface AdminRow {
  person_id: string; login: string; display_name: string | null; role: "memory_admin" | "security_auditor"; granted_at: string | null;
  keys: number; keys_bound: number; last_login_at: string | null; last_login_method: string | null;
}
interface AdminsView { items: AdminRow[]; local_admins: Array<{ login: string; last_login_at: string | null }> }




export default async function AdminsPage({ searchParams }: { searchParams?: Promise<{ sessions?: string | string[] }> } = {}) {
  await guardAuditorPage(true);
  const rawFilter = (await searchParams)?.sessions;
  const filter = typeof rawFilter === "string" ? rawFilter : "";
  const res = await tryGw<AdminsView>("/api/v1/admin/admins");
  return (
    <PageFrame title={TEXT.administrators2} allowAuditor
      lead={TEXT.currentMemoryAdministratorsAndSecurityAuditorsTheir}>
      {!res.ok ? <LoadError result={res} what={TEXT.listOfAdministrators} /> : (
        <>
          <AdminSessions owners={res.data.items} localLogins={res.data.local_admins.map((a) => a.login)} filter={filter} />
          <Section title={TEXT.byRoleAssignment} hint={<>{rich(TEXT.assignOrRemoveARoleInRoles, { link1: (children) => <Link prefetch={false} href="/admin/roles">{children}</Link>, link2: (children) => <Link prefetch={false} href="/admin/webauthn">{children}</Link> }, null)}</>}>
            {!res.data.items.length ? <Empty icon="circle-check">{TEXT.noRoleAssignmentsThePanelIsAccessed}</Empty> : (
              <TableWrap cards>
                <table className="board">
                  <thead><tr><th>{TEXT.person2}</th><th>{TEXT.role2}</th><th>{TEXT.keys2}</th><th>{TEXT.lastSignIn4}</th></tr></thead>
                  <tbody>
                    {res.data.items.map((a) => (
                      <tr key={`${a.person_id}-${a.role}`}>
                        <td data-label={TEXT.person}><span className="cell-main">{a.display_name || a.login}</span>{a.display_name ? <div className="cell-sub">{a.login}</div> : null}</td>
                        <td data-label={TEXT.role}>{ROLE_TITLES[a.role] ?? a.role}{a.granted_at ? <div className="cell-sub">{rich(TEXT.since, null, { date: <LocalTime iso={a.granted_at} relative={false} /> })}</div> : null}</td>
                        <td data-label={TEXT.keys}>
                          {a.keys ? <>{a.keys}{a.keys_bound < a.keys ? <div className="cell-sub">{rich(TEXT.boundToADevice, null, { value1: a.keys_bound })}</div> : null}</> : <Badge tone="warn">{TEXT.noKeys}</Badge>}
                        </td>
                        <td data-label={TEXT.lastSignIn3}>{a.last_login_at ? <><LocalTime iso={a.last_login_at} /><div className="cell-sub">{METHOD_TITLES[a.last_login_method ?? ""] ?? a.last_login_method ?? ""}</div></> : TEXT.neverSignedIn2}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Section>
          <Section title={TEXT.localAccounts} hint={TEXT.adminLocalSignsInWithAPassword}>
            {!res.data.local_admins.length ? <Empty icon="circle-check">{TEXT.noLocalAccounts}</Empty> : (
              <TableWrap cards>
                <table className="board">
                  <thead><tr><th>{TEXT.login2}</th><th>{TEXT.lastSignIn2}</th></tr></thead>
                  <tbody>
                    {res.data.local_admins.map((l) => (
                      <tr key={l.login}><td data-label={TEXT.login}>{l.login}</td><td data-label={TEXT.lastSignIn}>{l.last_login_at ? <LocalTime iso={l.last_login_at} /> : TEXT.neverSignedIn}</td></tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Section>
        </>
      )}
    </PageFrame>
  );
}
