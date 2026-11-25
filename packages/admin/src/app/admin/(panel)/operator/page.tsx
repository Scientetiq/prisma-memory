import { PAGE_TEXT } from "../../../../messages/panel-operator";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { PersonSuggest } from "@/components/person-suggest";
import { Badge, Code, Empty, LoadError, Notice, Section } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import type { AdminUserRow } from "@/lib/types";
import { linkOperatorAction, unlinkOperatorAction } from "./actions";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.administratorIdentity }; }


export default async function OperatorPage() {
  await guardAuditorPage();
  const res = await tryGw<{ items: AdminUserRow[]; current: string | null }>("/api/v1/admin/admin-users");
  const items = res.ok ? res.data.items.filter((u) => !u.disabled) : [];
  return (
    <PageFrame title={PAGE_TEXT.administratorIdentity2} lead={PAGE_TEXT.operatorLead}>
      <details className="hint-details"><summary>{PAGE_TEXT.whatIsLevel5}</summary><p>{PAGE_TEXT.extendedHelp}</p></details>
      {!res.ok ? <LoadError result={res} what={PAGE_TEXT.administrators} /> : !items.length ? <Empty>{PAGE_TEXT.noActiveLocalAdministrators}</Empty> : items.map((u) => (
        <Section key={u.login} title={u.login} hint={u.last_login_at ? <>{rich(PAGE_TEXT.lastPanelSignInValue1, null, { value1: <LocalTime iso={u.last_login_at} /> })}</> : PAGE_TEXT.noPanelSignInsYet}>
          {!u.person ? (
            <Notice tone="warn" role="status">{rich(PAGE_TEXT.unlinkedNotice, { tag1: (children) => <Code>{children}</Code>, tag4: (children) => <Link href="/admin/ldap" prefetch={false}>{children}</Link>, tag5: (children) => <Link href="/admin/sso" prefetch={false}>{children}</Link>, tag6: (children) => <Link href="/admin/people?tab=import" prefetch={false}>{children}</Link> }, { value2: u.login })}</Notice>
          ) : (
            <dl className="kv">
              <dt>{PAGE_TEXT.person}</dt><dd>{u.person.display_name ?? "—"} <Code>{u.person.login}</Code></dd>
              <dt>{PAGE_TEXT.department}</dt><dd>{u.person.department ?? "—"}</dd>
              <dt>{PAGE_TEXT.status}</dt><dd>
                {u.person.active ? <Badge tone="ok">{PAGE_TEXT.active}</Badge> : <Badge tone="danger">{PAGE_TEXT.inactive}</Badge>}{" "}
                {u.person.directory_linked ? <Badge tone="info">{PAGE_TEXT.fromTheCompanyDirectory}</Badge> : <Badge tone="muted">{PAGE_TEXT.notLinkedToTheDirectory}</Badge>}{" "}
                {u.ready ? <Badge tone="ok" title={PAGE_TEXT.extendedHelp}>{PAGE_TEXT.level5CanBeGranted}</Badge> : <Badge tone="warn" title={PAGE_TEXT.extendedHelp}>{PAGE_TEXT.level5Unavailable}</Badge>}
              </dd>
            </dl>
          )}
          {u.person && !u.person.active ? <Notice tone="warn">{PAGE_TEXT.thePersonOperatingThisAdministratorAccountIsInactiveDismissed}</Notice> : null}
          <ActionForm action={linkOperatorAction} submitLabel={u.person ? PAGE_TEXT.changePerson : PAGE_TEXT.link} pendingLabel={PAGE_TEXT.saving}>
            <input type="hidden" name="admin_login" value={u.login} />
            <div className="form-grid">
              <label className="field field-wide" htmlFor={`op-${u.login}`}>{rich(PAGE_TEXT.tag1PersonTag1Value2Tag3StartTypingASurname, { tag1: (children) => <span className="field-label">{children}</span>, tag3: (children) => <span className="field-hint" id={`op-${u.login}-hint`}>{children}</span> }, { value2: <PersonSuggest id={`op-${u.login}`} textName="person" pickedFields={{ login: "person" }} defaultText={u.person?.login ?? ""} label={PAGE_TEXT.person2}
                  placeholder={PAGE_TEXT.surnameFirstNameOrEmail} describedBy={`op-${u.login}-hint`} excludeDemo required /> })}</label>
            </div>
          </ActionForm>
          {u.person ? (
            <ActionForm action={unlinkOperatorAction} submitLabel={PAGE_TEXT.unlink} pendingLabel="…" quiet danger confirm={PAGE_TEXT.unlinkConfirm(u.login, u.person.login)}>
              <input type="hidden" name="admin_login" value={u.login} />
            </ActionForm>
          ) : null}
        </Section>
      ))}
    </PageFrame>
  );
}
