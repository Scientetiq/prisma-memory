import { rolesSpecialRoles } from "@/messages/panel-roles";
import { rich } from "@/i18n/rich";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { Badge, Code, Empty, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import type { Result } from "@/lib/api";
import { BASIS_TITLES } from "@/lib/labels";
import { settingHref } from "@/lib/setting-labels";
import { curatorsHint, digestLine, lastRunLine, noCuratorsText, queueLine } from "@/lib/org-review";
import type { Grant, OrgReviewAdmin, Page, Space } from "@/lib/types";
import { assignSpecialRoleAction, revokeGrantAction, sendCuratorDigestAction } from "./actions";

function Holders({ items, role }: { items: Grant[]; role: string }) {
  return (
    <TableWrap cards>
      <table className="board">
        <thead><tr><th>{rolesSpecialRoles.person}</th><th><span className="vis-hidden">{rolesSpecialRoles.action}</span></th><th>{rolesSpecialRoles.basis}</th><th>{rolesSpecialRoles.validUntil}</th></tr></thead>
        <tbody>
          {items.map((g) => (
            <tr key={g.id}>
              <td data-label={rolesSpecialRoles.person}>
                <Link href={`/admin/people/${encodeURIComponent(g.login)}`} prefetch={false} className="cell-main">{g.display_name || g.login}</Link>
                <div className="cell-sub"><Code>{g.login}</Code></div>
                {g.person_active === false ? <Badge tone="warn">{rolesSpecialRoles.deactivatedRoleIsInactive}</Badge> : null}
              </td>
              <td className="acts" data-label="">
                <ActionForm action={revokeGrantAction} submitLabel={rolesSpecialRoles.revoke} pendingLabel="…" compact danger confirm={rolesSpecialRoles.revokeRoleFrom(role, g.login)}>
                  <input type="hidden" name="id" value={g.id} />
                </ActionForm>
              </td>
              <td data-label={rolesSpecialRoles.basis}>{BASIS_TITLES[g.basis_source] ?? g.basis_source}{g.basis_ref ? <div className="cell-sub">{g.basis_ref}</div> : null}</td>
              <td data-label={rolesSpecialRoles.validUntil}>{g.valid_to ? <>{rich(rolesSpecialRoles.until, {  }, { value0: <LocalTime iso={g.valid_to} relative={false} /> })}</> : <span className="muted">{rolesSpecialRoles.noExpiry}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function AssignForm({ role, title, submitLabel, basisRequired }: { role: string; title: string; submitLabel: string; basisRequired: boolean }) {
  return (
    <>
    <h3 className="form-head">{title}</h3>
    <ActionForm action={assignSpecialRoleAction} submitLabel={submitLabel} pendingLabel={rolesSpecialRoles.assigning} resetOnSuccess>
      <input type="hidden" name="role_code" value={role} />
      <div className="form-grid">
        <Field label={rolesSpecialRoles.personSLoginWorkEmail} hint={rolesSpecialRoles.anActiveEmployeeFromTheOrgTable}>
          <input type="email" name="login" required maxLength={254} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={rolesSpecialRoles.basis}>
          <select name="basis_source" defaultValue="manual">
            <option value="manual">{BASIS_TITLES.manual}</option>
            <option value="request">{BASIS_TITLES.request}</option>
          </select>
        </Field>
        <Field label={basisRequired ? rolesSpecialRoles.requestOrDecisionReference : rolesSpecialRoles.requestOrDecisionReferenceOptional} hint={basisRequired ? rolesSpecialRoles.aBroadGrantRequiresAReference : undefined}>
          <input type="text" name="basis_ref" required={basisRequired} minLength={basisRequired ? 3 : undefined} placeholder={rolesSpecialRoles.forExampleSD} />
        </Field>
        <Field label={rolesSpecialRoles.validUntilInclusive} hint={rolesSpecialRoles.blankMeansNoExpiry}>
          <input type="date" name="valid_to" />
        </Field>
      </div>
    </ActionForm>
    </>
  );
}

function ReviewState({ review }: { review: Result<OrgReviewAdmin> }) {
  if (!review.ok) return <LoadError result={review} what={rolesSpecialRoles.recordReview} />;
  const r = review.data;
  if (!r.enabled) return <Notice tone="info">{rich(rolesSpecialRoles.curatorReviewIsDisabledInSettingsCompany, { a0: (children) => <a href={settingHref("access", "org_review_enabled")}>{children}</a> })}</Notice>;
  const last = lastRunLine(r.last_run);
  return (
    <>
      <p className="hint">{queueLine(r)}</p>
      {!r.mail_enabled
        ? <p className="hint">{rich(rolesSpecialRoles.emailIsDisabledCuratorsReceiveNoEmails, { link0: (children) => <Link href="/admin/smtp" prefetch={false}>{children}</Link> })}</p>
        : <p className="hint">{digestLine(r)}</p>}
      {last ? <p className="hint">{last}</p> : null}
      {!r.mail_enabled ? null : !r.curators.length ? null : !r.waiting ? <p className="hint">{rolesSpecialRoles.nothingToReviewNoEmailNeeded}</p> : (
        <ActionForm action={sendCuratorDigestAction} submitLabel={rolesSpecialRoles.sendEmailToCuratorsNow} pendingLabel={rolesSpecialRoles.queuing} quiet>
          <span />
        </ActionForm>
      )}
    </>
  );
}

export function SpecialRoles({ auditors, curators, org, review }: { auditors: Result<{ items: Grant[] }>; curators: Result<{ items: Grant[] }>; org: Result<Page<Space>>; review?: Result<OrgReviewAdmin> }) {
  const aud = auditors.ok ? auditors.data.items.filter((g) => g.effective) : [];
  const cur = curators.ok ? curators.data.items.filter((g) => g.effective) : [];
  const orgSpace = org.ok ? org.data.items[0] ?? null : null;
  const days = review?.ok ? review.data.settings.days : null;
  return (
    <>
      <Section title={rolesSpecialRoles.securityAuditor} id="auditor" icon="shield-check" hint={rolesSpecialRoles.anIndependentReviewerWhoReadsTheAudit}>
        {!auditors.ok ? <LoadError result={auditors} what={rolesSpecialRoles.securityAuditors} /> : !aud.length
          ? <Notice tone="warn">{rolesSpecialRoles.noSecurityAuditorIsAssignedExtendedAccess}</Notice>
          : <Holders items={aud} role={rolesSpecialRoles.securityAuditorLabel} />}
        <AssignForm role="security_auditor" title={rolesSpecialRoles.assignSecurityAuditor} submitLabel={rolesSpecialRoles.assignSecurityAuditor} basisRequired />
      </Section>

      <Section title={rolesSpecialRoles.companyKnowledgeCurators} id="curators" icon="badge-check" hint={<>{rich(rolesSpecialRoles.aCuratorOwnsCompanyKnowledgeThroughA, { code0: (children) => <Code>{children}</Code> }, { value0: curatorsHint(days), value1: orgSpace?.slug ?? "org" })}</>}>
        {!org.ok ? <LoadError result={org} what={rolesSpecialRoles.companyKnowledge} /> : !orgSpace ? <Empty>{rolesSpecialRoles.companyKnowledgeDoesNotExistYetIt}</Empty> : (
          <>
            {!curators.ok ? <LoadError result={curators} what={rolesSpecialRoles.curators} /> : !cur.length
              ? <Notice tone="warn">{noCuratorsText(days)}</Notice>
              : <Holders items={cur} role={rolesSpecialRoles.curator} />}
            {cur.length > 3 ? <Notice tone="info">{rolesSpecialRoles.moreThanThreeCuratorsUsuallyThisIs}</Notice> : null}
            <p className="hint">{rich(rolesSpecialRoles.companyKnowledgeOwnerSpaces, { link0: (children) => <Link href="/admin/spaces" prefetch={false}>{children}</Link> }, { value0: orgSpace.owner ? <Code>{orgSpace.owner}</Code> : rolesSpecialRoles.unassigned })}</p>
            {review ? <ReviewState review={review} /> : null}
            <AssignForm role="org_curator" title={rolesSpecialRoles.addCurator} submitLabel={rolesSpecialRoles.addCurator} basisRequired={false} />
          </>
        )}
      </Section>
    </>
  );
}
