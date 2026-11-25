import { PAGE_TEXT, TRANSPORT_TITLES, ROLE_TITLES } from "../../../../messages/panel-webauthn";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, Empty, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { readSession } from "@/lib/session";
import { deleteOwnKeyAction } from "./actions";
import { RegisterKey, StepupButton } from "./register-client";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.webauthnKeys }; }

interface KeyItem { id: string; label: string | null; created_at: string; last_used_at: string | null; disabled_at?: string | null; transports: string[]; backup_eligible: boolean }
const SSO_METHODS = new Set(["sso", "sso_webauthn", "sso_breakglass"]);
interface CoverageItem { person_id: string; login: string; role: "memory_admin" | "security_auditor"; active_keys: number }
interface Coverage { min_keys: number; items: CoverageItem[] }


function MyKeys({ keys }: { keys: KeyItem[] }) {
  if (!keys.some((k) => !k.disabled_at)) return (
    <>
      <Empty icon="key">{PAGE_TEXT.noActiveKeysAddYourFirstKeyBelowIt}</Empty>
      {keys.length ? <KeyTable keys={keys} /> : null}
    </>
  );
  return <KeyTable keys={keys} />;
}

function KeyTable({ keys }: { keys: KeyItem[] }) {
  return (
    <TableWrap cards>
      <table className="board">
        <thead><tr><th>{PAGE_TEXT.label}</th><th>{PAGE_TEXT.connection}</th><th>{PAGE_TEXT.added}</th><th>{PAGE_TEXT.lastSignIn}</th><th /></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td data-label={PAGE_TEXT.label2}>{k.label || PAGE_TEXT.unlabelled}{k.backup_eligible ? <> <Badge tone="muted" title={PAGE_TEXT.thisKeyCanBeCopiedBetweenDevicesPasswordManager}>{PAGE_TEXT.canBeCopied}</Badge></> : null}
                {k.disabled_at ? <> <Badge tone="danger" title={PAGE_TEXT.thisKeyCanNoLongerSignInItWas}>{PAGE_TEXT.disabled}</Badge></> : null}</td>
              <td data-label={PAGE_TEXT.connection2}>{k.transports.length ? k.transports.map((t) => TRANSPORT_TITLES[t] ?? t).join(", ") : "—"}</td>
              <td data-label={PAGE_TEXT.added2}><LocalTime iso={k.created_at} short /></td>
              <td data-label={PAGE_TEXT.lastSignIn2}>{k.last_used_at ? <LocalTime iso={k.last_used_at} short /> : PAGE_TEXT.noSignInsYet}</td>
              <td className="acts">
                {k.disabled_at ? <span className="muted">{rich(PAGE_TEXT.sinceValue1, null, { value1: <LocalTime iso={k.disabled_at} short relative={false} /> })}</span> : (
                  <ActionForm action={deleteOwnKeyAction} submitLabel={PAGE_TEXT.delete} pendingLabel="…" compact danger quiet icon="trash"
                    confirm={PAGE_TEXT.deleteKeyValue1ItCanNoLongerSignIn(k.label || PAGE_TEXT.unlabelled2)}>
                    <input type="hidden" name="id" value={k.id} />
                  </ActionForm>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function CoverageTable({ data }: { data: Coverage }) {
  if (!data.items.length) return <Empty>{PAGE_TEXT.nobodyHasAnAdministratorOrSecurityAuditorRole}</Empty>;
  return (
    <TableWrap cards>
      <table className="board">
        <thead><tr><th>{PAGE_TEXT.who}</th><th>{PAGE_TEXT.role}</th><th className="num">{PAGE_TEXT.keys}</th><th>{PAGE_TEXT.enoughKeys}</th></tr></thead>
        <tbody>
          {data.items.map((x) => (
            <tr key={x.person_id}>
              <td data-label={PAGE_TEXT.who2}>{x.login}</td>
              <td data-label={PAGE_TEXT.role2}>{ROLE_TITLES[x.role]}</td>
              <td className="num" data-label={PAGE_TEXT.keys2}>{x.active_keys}</td>
              <td data-label={PAGE_TEXT.enoughKeys2}>{x.active_keys >= data.min_keys
                ? <Badge tone="ok">{PAGE_TEXT.enough}</Badge>
                : x.active_keys > 0 ? <Badge tone="warn">{rich(PAGE_TEXT.fewerThanValue1, null, { value1: data.min_keys })}</Badge> : <Badge tone="danger">{PAGE_TEXT.noKeys}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export default async function WebauthnPage() {
  await guardAuditorPage(true);
  const session = await readSession();
  const asSession = session?.token.startsWith("mem_as_") === true;
  const info = asSession ? await tryGw<{ auth_method?: string }>("/api/v1/admin-auth/session") : null;
  const sso = !!info?.ok && SSO_METHODS.has(String(info.data.auth_method ?? ""));
  const [mine, coverage] = await Promise.all([
    sso ? tryGw<{ items: KeyItem[] }>("/api/v1/admin-auth/webauthn/credentials") : Promise.resolve(null),
    tryGw<Coverage>("/api/v1/admin/webauthn/coverage"),
  ]);
  const active = mine?.ok ? mine.data.items.filter((k) => !k.disabled_at).length : 0;

  return (
    <PageFrame title={PAGE_TEXT.webauthnKeys2} allowAuditor lead={PAGE_TEXT.lead}>
      <Section title={PAGE_TEXT.myKeys} icon="key">
        {info && !info.ok ? <LoadError result={info} what={PAGE_TEXT.yourSessionDetails} /> : !sso || !mine ? (
          <Notice tone="info" role="status">
            <p>{PAGE_TEXT.securityKeysBelongToCompanySignInYouSigned}</p>
          </Notice>
        ) : !mine.ok ? <LoadError result={mine} what={PAGE_TEXT.yourKeys} /> : (
          <>
            {session?.breakglass ? <Notice tone="warn" role="status"><p>{PAGE_TEXT.emergencyAccessIsOpenANewKeyCanBe}</p></Notice> : null}
            <MyKeys keys={mine.data.items} />
            {active ? <StepupButton /> : null}
            <RegisterKey />
          </>
        )}
      </Section>
      <Section title={PAGE_TEXT.everyoneSKeys} icon="users" hint={PAGE_TEXT.activeKeysHeldByEachAdministratorAndSecurityAuditor}>
        {!coverage.ok ? <LoadError result={coverage} what={PAGE_TEXT.everyoneSKeys2} /> : <CoverageTable data={coverage.data} />}
      </Section>
    </PageFrame>
  );
}
