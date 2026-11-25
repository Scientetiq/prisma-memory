import { rich } from "../../../../i18n/rich";
import { TEXT } from "../../../../messages/panel-ldap";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { fieldCategory, LDAP_FIELDS, LDAP_STEP_TITLES } from "@/lib/ldap-form";
import { GROUP_STATUS_TITLES } from "@/lib/labels";
import { LoginStatusCard } from "@/components/login-status-card";
import type { GroupSyncState, LoginStatus, SettingsResponse } from "@/lib/types";
import { checkLdapAction, groupSyncAction, saveLdapAction, testLoginAction } from "./actions";
import { SectionSettingsForm, type SectionSettingView } from "@/components/section-settings-form";

export function generateMetadata(): Metadata { return { title: TEXT.signInAndLDAP }; }

export default async function LdapPage() {
  await guardAuditorPage();
  const [res, sync, status] = await Promise.all([
    tryGw<SettingsResponse>("/api/v1/admin/settings"),
    tryGw<GroupSyncState>("/api/v1/admin/group-sync"),
    tryGw<LoginStatus>("/api/v1/admin/login-status"),
  ]);
  const own = new Set(LDAP_FIELDS.map((f) => `${fieldCategory(f)}.${f.key}`));
  const items: SectionSettingView[] = res.ok
    ? res.data.items.filter((i) => own.has(`${i.category}.${i.key}`)).map((i) => ({ key: i.key, category: i.category, value: i.secret ? null : i.value, secret: i.secret, isSet: i.isSet, description: i.description }))
    : [];
  const enabled = items.find((i) => i.key === "enabled")?.value === true;

  return (
    <PageFrame title={TEXT.signInAndLDAP2} lead={TEXT.workspaceSignInWithACompanyAccount}>
      {!res.ok ? <LoadError result={res} what={TEXT.signInSettings} /> : !items.some((i) => i.category === "ldap") ? (
        <Notice tone="warn">{rich(TEXT.theGatewayDoesNotRecognizeTheLdap, { code1: (children) => <code className="code">{children}</code> }, null)}</Notice>
      ) : (
        <>
          {enabled
            ? <Notice tone="ok" role="status">{TEXT.companyAccountSignInIsOnAccess}</Notice>
            : <Notice tone="info" role="status">{TEXT.companyAccountSignInIsOffNobody}</Notice>}

          <Section title={TEXT.directorySettings} hint={TEXT.changingWhoCanSignInOrHow}>
            <SectionSettingsForm section="ldap" items={items} action={saveLdapAction} />
          </Section>

          <div data-inpage="check">
            <Section title={TEXT.checkConnection2} id="check" hint={TEXT.checksTheServerNameConnectionToEach}>
              <LoginStatusCard status={status.ok ? { ok: true, data: status.data.ldap } : status} titles={LDAP_STEP_TITLES} what={TEXT.directorySignIn}>
                <ActionForm action={checkLdapAction} submitLabel={TEXT.checkConnection} pendingLabel={TEXT.checking2} quiet>
                  <span />
                </ActionForm>
              </LoginStatusCard>
            </Section>

            <Section title={TEXT.testSignIn2} hint={TEXT.followsTheSamePathAsAReal}>
              <ActionForm action={testLoginAction} submitLabel={TEXT.testSignIn} pendingLabel={TEXT.checking} quiet>
                <div className="form-grid">
                  <Field label={TEXT.login} hint={TEXT.forExampleUserExampleComUserAnd}>
                    <input type="text" name="login" autoComplete="off" spellCheck={false} required />
                  </Field>
                  <Field label={TEXT.password}>
                    <input type="password" name="password" autoComplete="new-password" />
                  </Field>
                </div>
              </ActionForm>
            </Section>
          </div>

          <Section title={TEXT.spaceMembershipThroughGroups} id="groups" hint={/* i18n */ TEXT.theOwnerOfAProjectOrTeam}>
            {!sync.ok ? <LoadError result={sync} what={TEXT.groupVerificationStatus} /> : (
              <>
                <p className="hint">{rich(TEXT.groupBindings, null, { value1: sync.data.bindings, value2: !sync.data.last ? TEXT.groupsHaveNotBeenVerifiedYet : sync.data.last.ok
                    ? <>{rich(TEXT.lastVerificationGroupsMembershipsAddedRemoved, null, { value1: <LocalTime iso={sync.data.last.at} />, value2: sync.data.last.groups, value3: sync.data.last.members_added, value4: sync.data.last.members_removed })}</>
                    : <span className="danger-text">{rich(TEXT.lastVerificationFailedTheDirectoryDidNot, null, { value1: <LocalTime iso={sync.data.last.at} />, value2: sync.data.last.error_code ? ` (${sync.data.last.error_code})` : "" })}</span> })}</p>
                {sync.data.problems.length ? (
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{TEXT.space}</th><th>{TEXT.group}</th><th>{TEXT.state}</th><th>{TEXT.since}</th></tr></thead>
                      <tbody>
                        {sync.data.problems.slice(0, 20).map((p, i) => (
                          <tr key={`${p.slug}-${p.group}-${i}`}>
                            <td>
                              <Link href={`/admin/spaces/${encodeURIComponent(p.slug)}#groups`} prefetch={false}>{p.name ?? p.slug}</Link>
                              {p.name && p.name !== p.slug ? <div className="muted small">{p.slug}</div> : null}
                            </td>
                            <td>{p.group}</td>
                            <td><Badge tone="warn">{GROUP_STATUS_TITLES[p.status] ?? p.status}</Badge></td>
                            <td>{p.since ? <LocalTime iso={p.since} /> : <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                ) : null}
                {sync.data.problems.length > 20 ? <p className="hint">{rich(TEXT.showingTheFirstOfSeeTheReport, { link1: (children) => <Link href="/admin/report#group-sync" prefetch={false}>{children}</Link> }, { value1: sync.data.problems.length })}</p> : null}
                <div data-inpage="check">
                  <ActionForm action={groupSyncAction} submitLabel={TEXT.verifyGroupsNow} pendingLabel={TEXT.verifying} quiet>
                    <span />
                  </ActionForm>
                </div>
              </>
            )}
          </Section>

        </>
      )}
    </PageFrame>
  );
}
