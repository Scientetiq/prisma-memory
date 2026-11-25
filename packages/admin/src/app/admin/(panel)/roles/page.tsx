import { coreRoleDescription, coreRoleName, rolesPage } from "@/messages/panel-roles";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { ActionForm } from "@/components/action-form";
import { AdminTabs } from "@/components/admin-tabs";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { LocalPager } from "@/components/pager";
import { Badge, Chips, Code, Empty, LoadError, Section, TableWrap } from "@/components/ui";
import { pickTab, ROLES_TABS } from "@/lib/admin-tabs";
import { tryGw } from "@/lib/api";
import { stripPlanRefs } from "@/lib/plain";
import { BASIS_TITLES, provenanceTitle, EFFECT_HINTS, EFFECT_ORDER, EFFECT_TITLES, ORIGIN_TITLES, SCOPE_TITLES } from "@/lib/labels";
import { param, slicePage, type SearchParams } from "@/lib/paging";
import type { Grant, OrgReviewAdmin, Page, Role, Space } from "@/lib/types";
import { createGrantAction, revokeGrantAction } from "./actions";
import { GrantForm } from "./grant-form";
import { SpecialRoles } from "./special-roles";

export function generateMetadata(): Metadata { return { title: rolesPage.rolesAndGrants }; }

function isBroad(g: Grant, effect: string | undefined): boolean {
  if (g.revoked_at || !g.effective) return false;
  if (g.wide === true) return true;
  return g.role_code === "memory_admin" || g.role_code === "security_auditor" || effect === "admin" || effect === "audit" || g.scope_kind === "company";
}

function grantStatus(g: Grant) {
  if (g.revoked_at) return <><Badge tone="muted">{rolesPage.revoked}</Badge><div className="cell-sub"><LocalTime iso={g.revoked_at} /></div></>;
  if (g.effective) return <Badge tone="ok">{rolesPage.active}</Badge>;
  if (g.valid_to && Date.parse(g.valid_to) <= Date.now()) return <Badge tone="warn">{rolesPage.expired}</Badge>;
  return <Badge tone="muted">{rolesPage.inactive}</Badge>;
}

export default async function RolesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const tab = pickTab(param(sp, "tab"), ROLES_TABS, "grants");
  const login = param(sp, "login").toLowerCase(), gPage = param(sp, "g");
  const params = { tab: tab === "grants" ? "" : tab, login, g: gPage };
  const grantsTab = tab === "grants", special = tab === "special";

  const [roles, grants, allGrants, auditors, curators, org, review] = await Promise.all([
    tryGw<{ items: Role[] }>("/api/v1/admin/roles"),
    grantsTab ? tryGw<{ items: Grant[] }>("/api/v1/admin/grants", { query: { login } }) : null,
    grantsTab && login ? tryGw<{ items: Grant[] }>("/api/v1/admin/grants") : null,
    special ? tryGw<{ items: Grant[] }>("/api/v1/admin/grants", { query: { role: "security_auditor", limit: 100 } }) : null,
    special ? tryGw<{ items: Grant[] }>("/api/v1/admin/grants", { query: { role: "org_curator", limit: 100 } }) : null,
    special ? tryGw<Page<Space>>("/api/v1/admin/spaces", { query: { kind: "org", limit: 1 } }) : null,
    special ? tryGw<OrgReviewAdmin>("/api/v1/admin/org-review") : null,
  ]);
  const roleList = roles.ok ? roles.data.items : [];
  const effectOf = new Map(roleList.map((r) => [r.code, r.memory_effect]));
  const broadSource = allGrants ?? grants;
  const broad = broadSource?.ok ? broadSource.data.items.filter((g) => isBroad(g, effectOf.get(g.role_code))) : [];
  const assignable = roleList.filter((r) => r.active && !r.derived).map((r) => ({ code: r.code, name: coreRoleName(r.code, r.name), memory_effect: r.memory_effect }));
  const grantsPage = grants?.ok ? slicePage(grants.data.items, gPage) : null;

  return (
    <PageFrame title={rolesPage.rolesAndGrants} lead={rolesPage.theRoleCatalogIsSharedByHub}>
      <AdminTabs path="/admin/roles" tabs={ROLES_TABS} active={tab} fallback="grants" label={rolesPage.rolesPageSections} />

      {auditors && curators && org ? <SpecialRoles auditors={auditors} curators={curators} org={org} review={review ?? undefined} /> : null}

      {tab === "catalog" ? (
      <Section title={rolesPage.roleCatalog} id="catalog" icon="list" hint={rolesPage.groupedByMemoryEffectRolesThatChange}>
        {!roles.ok ? <LoadError result={roles} what={rolesPage.roleCatalogLabel} /> : !roleList.length ? <Empty>{rolesPage.theRoleCatalogIsEmpty}</Empty> : (
          <TableWrap>
            <table className="board">
              <thead>
                <tr><th>{rolesPage.code}</th><th>{rolesPage.name}</th><th>{rolesPage.description}</th><th>{rolesPage.origin}</th><th>{rolesPage.howItIsGranted}</th><th>{rolesPage.status}</th></tr>
              </thead>
              <tbody>
                {EFFECT_ORDER.map((effect) => {
                  const group = roleList.filter((r) => r.memory_effect === effect);
                  if (!group.length) return null;
                  const none = effect === "none";
                  return (
                    <Fragment key={effect}>
                      <tr className={none ? "group-row group-none" : "group-row"}>
                        <th colSpan={6} scope="colgroup">{rich(rolesPage.roles, {  }, { value0: none ? rolesPage.doNotAffectAccessToMemory : EFFECT_TITLES[effect], value1: group.length })}<p className="hint">{EFFECT_HINTS[effect]}</p>
                        </th>
                      </tr>
                      {group.map((r) => (
                        <tr key={r.code} className={`${none ? "role-none" : "role-effect"}${r.active ? "" : " off"}`}>
                          <td><Code>{r.code}</Code></td>
                          <td className={none ? undefined : "cell-main"}>{coreRoleName(r.code, r.name)}</td>
                          <td>{coreRoleDescription(r.code, r.description) ? stripPlanRefs(coreRoleDescription(r.code, r.description)!) : <span className="muted">—</span>}</td>
                          <td>{ORIGIN_TITLES[r.origin] ?? r.origin}</td>
                          <td>{r.derived ? <Badge tone="info" title={rolesPage.derivedFromTheOrgTableCannotBe}>{rolesPage.fromOrgTable}</Badge> : <Badge tone="neutral">{rolesPage.byGrant}</Badge>}</td>
                          <td>
                            <span className="badges">
                              {none ? <Badge tone="muted">{rolesPage.noEffectInMemory}</Badge> : <Badge tone="ok">{rolesPage.changesAccess}</Badge>}
                              {r.active ? null : <Badge tone="muted">{rolesPage.inactiveLabel}</Badge>}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      ) : null}

      {grants && broadSource ? <>
      <Section title={rolesPage.broadGrants} id="broad" icon="alert" hint={rolesPage.activeGrantsWithAdministratorOrAuditorEffects}>
        {!broadSource.ok ? <LoadError result={broadSource} what={rolesPage.broadGrantsLabel} /> : !broad.length ? <Empty>{rolesPage.noBroadGrantsOnlyTheLocalPanel}</Empty> : (
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{rolesPage.recipient}</th><th>{rolesPage.role}</th><th><span className="vis-hidden">{rolesPage.action}</span></th><th>{rolesPage.scope}</th><th>{rolesPage.basis}</th><th>{rolesPage.approvedBy}</th><th>{rolesPage.validUntil}</th></tr></thead>
              <tbody>
                {broad.map((g) => (
                  <tr key={g.id}>
                    <td data-label={rolesPage.recipient}><Link href={`/admin/people/${encodeURIComponent(g.login)}`} prefetch={false}><Code>{g.login}</Code></Link></td>
                    <td data-label={rolesPage.role}><Code>{g.role_code}</Code><div className="cell-sub">{EFFECT_TITLES[effectOf.get(g.role_code) ?? "none"] ?? ""}</div></td>
                    <td className="acts" data-label="">
                      <ActionForm action={revokeGrantAction} submitLabel={rolesPage.revoke} pendingLabel="…" compact danger confirm={rolesPage.revokeBroadGrantFrom(g.role_code, g.login)}>
                        <input type="hidden" name="id" value={g.id} />
                      </ActionForm>
                    </td>
                    <td data-label={rolesPage.scope}>{g.scope_kind === "company" ? <Badge tone="warn">{rolesPage.companyWide}</Badge> : <>{SCOPE_TITLES[g.scope_kind] ?? g.scope_kind}{g.scope_ref ? <> · <Code>{g.scope_ref}</Code></> : null}</>}</td>
                    <td data-label={rolesPage.basis}>{BASIS_TITLES[g.basis_source] ?? g.basis_source}{g.basis_ref ? <div className="cell-sub">{g.basis_ref}</div> : null}</td>
                    <td data-label={rolesPage.approvedBy}>{provenanceTitle(g.approved_by) ?? <span className="muted">—</span>}</td>
                    <td data-label={rolesPage.validUntil}>{g.valid_to ? <>{rich(rolesPage.until, {  }, { value0: <LocalTime iso={g.valid_to} relative={false} /> })}</> : <span className="muted">{rolesPage.noExpiry}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      <Section title={rolesPage.grants} id="grants" icon="shield" hint={rolesPage.recipientRoleActionsScopeWithABasis}>
        <form method="get" action="/admin/roles" className="filter-form">
          <label className="field">
            <span className="field-label">{rolesPage.recipientSLogin}</span>
            <input type="search" name="login" defaultValue={login} placeholder={rolesPage.exactLogin} />
          </label>
          <button type="submit" className="btn">{rolesPage.show}</button>
          {login ? <Link href="/admin/roles#grants" prefetch={false} className="quiet">{rolesPage.reset}</Link> : null}
        </form>

        {!grants.ok ? <LoadError result={grants} what={rolesPage.grantsLabel} /> : !grantsPage?.total ? <Empty>{login ? rolesPage.thisPersonHasNoGrants : rolesPage.noGrantsYet}</Empty> : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead>
                  <tr><th>{rolesPage.recipient}</th><th>{rolesPage.role}</th><th>{rolesPage.status}</th><th><span className="vis-hidden">{rolesPage.action}</span></th><th>{rolesPage.actions}</th><th>{rolesPage.scope}</th><th>{rolesPage.basis}</th><th>{rolesPage.approvedBy}</th><th>{rolesPage.validUntil}</th></tr>
                </thead>
                <tbody>
                  {grantsPage.items.map((g) => {
                    const effect = effectOf.get(g.role_code);
                    return (
                      <tr key={g.id} className={g.effective ? undefined : "off"}>
                        <td data-label={rolesPage.recipient}><Link href={`/admin/people/${encodeURIComponent(g.login)}`} prefetch={false}><Code>{g.login}</Code></Link></td>
                        <td data-label={rolesPage.role}>
                          <Code>{g.role_code}</Code>
                          <div className="cell-sub">{effect === "none" ? rolesPage.noEffectInMemory : effect ? EFFECT_TITLES[effect] : ""}</div>
                        </td>
                        <td data-label={rolesPage.status}>{grantStatus(g)}</td>
                        <td className="acts" data-label="">
                          {g.revoked_at ? null : (
                            <ActionForm action={revokeGrantAction} submitLabel={rolesPage.revoke} pendingLabel="…" compact danger confirm={rolesPage.revokeGrantFrom(g.role_code, g.login)}>
                              <input type="hidden" name="id" value={g.id} />
                            </ActionForm>
                          )}
                        </td>
                        <td data-label={rolesPage.actions}><Chips items={g.actions} /></td>
                        <td data-label={rolesPage.scope}>{SCOPE_TITLES[g.scope_kind] ?? g.scope_kind}{g.scope_ref ? <> · <Code>{g.scope_ref}</Code></> : null}</td>
                        <td data-label={rolesPage.basis}>{BASIS_TITLES[g.basis_source] ?? g.basis_source}{g.basis_ref ? <div className="cell-sub">{g.basis_ref}</div> : null}</td>
                        <td data-label={rolesPage.approvedBy}>{provenanceTitle(g.approved_by) ?? <span className="muted">—</span>}</td>
                        <td data-label={rolesPage.validUntil}>
                          <div>{rich(rolesPage.from, {  }, { value0: <LocalTime iso={g.valid_from} relative={false} /> })}</div>
                          <div>{g.valid_to ? <>{rich(rolesPage.until, {  }, { value0: <LocalTime iso={g.valid_to} relative={false} /> })}</> : <span className="muted">{rolesPage.noExpiry}</span>}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <LocalPager path="/admin/roles" params={params} pageName="g" page={grantsPage} anchor="grants" />
            {grants.data.items.length >= 500 ? <p className="hint">{rolesPage.theLatestGrantsAreShownFilterBy}</p> : null}
          </>
        )}
      </Section>

      <Section title={rolesPage.newGrant} id="new-grant" hint={rolesPage.aGrantRequiresABasisEnterIts}>
        {roles.ok ? <GrantForm roles={assignable} action={createGrantAction} /> : <Empty>{rolesPage.theRoleCatalogCouldNotBeLoaded}</Empty>}
      </Section>
      </> : null}
    </PageFrame>
  );
}
