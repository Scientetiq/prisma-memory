import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { AdminTabs } from "@/components/admin-tabs";
import { PageFrame } from "@/components/page-frame";
import { TableWrap } from "@/components/table-wrap";
import { Empty, Notice, Section } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { PEOPLE_TABS } from "@/lib/admin-tabs";
import { tryGw } from "@/lib/api";
import type { Person } from "@/lib/types";
import { LOCAL_ACCOUNTS_PANEL } from "@/messages/panel-local-accounts";
import { peoplePage } from "@/messages/panel-people";
import { addLocalAccountAction, disableLocalAccountAction, resetLocalPasswordAction } from "./actions";

interface LocalAccount {
  person: Pick<Person, "id" | "login" | "display_name" | "active">;
  has_password: boolean;
  password_set_at: string | null;
  disabled_at: string | null;
  created_at: string;
  link: { id: string; kind: string; expires_at: string } | null;
}

interface LocalAccountsList {
  items: LocalAccount[];
  truncated: boolean;
}

function accountState(account: LocalAccount): string {
  if (account.disabled_at !== null) return LOCAL_ACCOUNTS_PANEL.stateDisabled;
  if (!account.person.active) return LOCAL_ACCOUNTS_PANEL.stateInactive;
  if (account.has_password) return LOCAL_ACCOUNTS_PANEL.statePassword;
  if (account.link !== null) return LOCAL_ACCOUNTS_PANEL.stateWaiting;
  return LOCAL_ACCOUNTS_PANEL.stateNoLink;
}

export function generateMetadata(): Metadata {
  return { title: LOCAL_ACCOUNTS_PANEL.title };
}

export default async function LocalAccountsPage() {
  await guardAuditorPage();
  const accounts = await tryGw<LocalAccountsList>("/api/v1/admin/local-accounts");

  return (
    <PageFrame title={LOCAL_ACCOUNTS_PANEL.title} lead={LOCAL_ACCOUNTS_PANEL.lead}>
      <AdminTabs path="/admin/people" tabs={PEOPLE_TABS} active="local" fallback="people" label={peoplePage.peoplePageSections} />
      <Section title={LOCAL_ACCOUNTS_PANEL.addTitle}>
        <ActionForm
          action={addLocalAccountAction}
          submitLabel={LOCAL_ACCOUNTS_PANEL.add}
          pendingLabel={LOCAL_ACCOUNTS_PANEL.adding}
          resetOnSuccess
        >
          <label className="field">
            <span className="field-label">{LOCAL_ACCOUNTS_PANEL.email}</span>
            <input name="login" type="email" required maxLength={200} autoComplete="off" />
          </label>
          <label className="field">
            <span className="field-label">{LOCAL_ACCOUNTS_PANEL.name}</span>
            <input name="display_name" type="text" required maxLength={200} autoComplete="off" />
          </label>
        </ActionForm>
      </Section>

      <Section title={LOCAL_ACCOUNTS_PANEL.listTitle}>
        {!accounts.ok ? (
          <Notice tone="danger" role="alert">
            <strong>{accounts.status === 404 ? LOCAL_ACCOUNTS_PANEL.off : LOCAL_ACCOUNTS_PANEL.listFailed}</strong>
            {accounts.status === 404 ? null : <p className="small">{`${accounts.code}: ${accounts.message.slice(0, 300)}`}</p>}
          </Notice>
        ) : accounts.data.items.length === 0 ? (
          <Empty>{LOCAL_ACCOUNTS_PANEL.empty}</Empty>
        ) : (
          <TableWrap cards>
            <table className="board">
              <thead>
                <tr>
                  <th scope="col">{LOCAL_ACCOUNTS_PANEL.colEmail}</th>
                  <th scope="col">{LOCAL_ACCOUNTS_PANEL.colName}</th>
                  <th scope="col">{LOCAL_ACCOUNTS_PANEL.colState}</th>
                  <th scope="col">{LOCAL_ACCOUNTS_PANEL.colActions}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.data.items.map((account) => (
                  <tr key={account.person.id}>
                    <td data-label={LOCAL_ACCOUNTS_PANEL.colEmail}>{account.person.login}</td>
                    <td data-label={LOCAL_ACCOUNTS_PANEL.colName}>{account.person.display_name}</td>
                    <td data-label={LOCAL_ACCOUNTS_PANEL.colState}>{accountState(account)}</td>
                    <td className="acts">
                      {account.disabled_at === null ? (
                        <>
                          <ActionForm
                            action={resetLocalPasswordAction}
                            submitLabel={LOCAL_ACCOUNTS_PANEL.reset}
                            pendingLabel={LOCAL_ACCOUNTS_PANEL.resetting}
                            quiet
                          >
                            <input type="hidden" name="person_id" value={account.person.id} />
                          </ActionForm>
                          <ActionForm
                            action={disableLocalAccountAction}
                            submitLabel={LOCAL_ACCOUNTS_PANEL.disable}
                            pendingLabel={LOCAL_ACCOUNTS_PANEL.disabling}
                            danger
                          >
                            <input type="hidden" name="person_id" value={account.person.id} />
                            <label className="check">
                              <input type="checkbox" name="confirm" value="yes" required />
                              {LOCAL_ACCOUNTS_PANEL.disableConfirm}
                            </label>
                          </ActionForm>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {accounts.ok && accounts.data.truncated ? <p className="hint">{LOCAL_ACCOUNTS_PANEL.truncated}</p> : null}
      </Section>
    </PageFrame>
  );
}
