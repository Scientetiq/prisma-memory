import { rich } from "../../../../i18n/rich";
import { TEXT } from "../../../../messages/panel-sso";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { CopyBlock } from "@/components/copy-block";
import { PageFrame } from "@/components/page-frame";
import { SectionSettingsForm, type SectionSettingView } from "@/components/section-settings-form";
import { LoadError, Notice, Section } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { LoginStatusCard } from "@/components/login-status-card";
import { OIDC_STEP_TITLES, oidcRedirectFor } from "@/lib/oidc-form";
import type { LoginStatus, SettingsResponse } from "@/lib/types";
import { TEXT as WORKPLACE_LOGIN_TEXT } from "@/lib/workplace-login";
import { checkOidcAction, saveOidcAction } from "./actions";

export function generateMetadata(): Metadata { return { title: TEXT.singleSignOnKeycloak }; }

export default async function SsoPage() {
  await guardAuditorPage();
  const [res, status] = await Promise.all([
    tryGw<SettingsResponse>("/api/v1/admin/settings"),
    tryGw<LoginStatus>("/api/v1/admin/login-status"),
  ]);
  const items: SectionSettingView[] = res.ok
    ? res.data.items.filter((i) => i.category === "oidc").map((i) => ({ key: i.key, category: i.category, value: i.secret ? null : i.value, secret: i.secret, isSet: i.isSet, description: i.description }))
    : [];
  const enabled = items.find((i) => i.key === "enabled")?.value === true;
  const saved = (key: string): string => { const v = items.find((i) => i.key === key)?.value; return typeof v === "string" ? v.trim() : ""; };
  const workplace = res.ok ? res.data.items.find((i) => i.category === "access" && i.key === "workplace_url")?.value : null;
  const redirect = saved("redirect_uri") || oidcRedirectFor(workplace) || "";
  const suggested = oidcRedirectFor(workplace);

  return (
    <PageFrame title={TEXT.singleSignOnKeycloak2} lead={TEXT.workspaceSignInThroughYourCompanyS}>
      {!res.ok ? <LoadError result={res} what={TEXT.singleSignOnSettings} /> : !items.length ? (
        <Notice tone="warn">{rich(TEXT.theGatewayDoesNotRecognizeTheOidc, { code1: (children) => <code className="code">{children}</code> }, null)}</Notice>
      ) : (
        <>
          {enabled
            ? <Notice tone="ok" role="status">{rich(TEXT.keycloakSignInIsOnTheWorkspace, null, { value1: WORKPLACE_LOGIN_TEXT.ssoButtonLabel })}</Notice>
            : <Notice tone="info" role="status">{TEXT.keycloakSignInIsOffCreateA}</Notice>}

          <Section title={TEXT.stepKeycloakClient} id="client" hint={TEXT.createTheseInYourCompanyRealmSign}>
            <details className="how-details" open={!enabled && !saved("client_id")}>
              <summary>{TEXT.clientOptionsToEnable}</summary>
              <ul className="setup-list">
                <li>{rich(TEXT.openidConnectClientClientAuthenticationOnConfidential, { strong1: (children) => <strong>{children}</strong> }, null)}</li>
                <li>{rich(TEXT.advancedProofKeyForCodeExchangeCode, { code1: (children) => <code className="code">{children}</code> }, null)}</li>
                <li>{TEXT.validRedirectURIsTheExactReturnURL}</li>
                <li>{rich(TEXT.idTokenMappersLDAPIDUserAttribute, { code1: (children) => <code className="code">{children}</code>, code2: (children) => <code className="code">{children}</code> }, null)}</li>
                <li>{TEXT.credentialsClientSecretCopyItIntoClient}</li>
              </ul>
            </details>
            {saved("client_id") ? <><p className="hint">{TEXT.savedClientIDUseTheSameClient}</p><CopyBlock text={saved("client_id")} label={TEXT.clientID} /></> : null}
            {redirect ? (
              <><p className="hint">{saved("redirect_uri") ? TEXT.savedReturnURLEnterTheSameValue : TEXT.returnURLForThisWorkspaceEnterThe}</p><CopyBlock text={redirect} label={TEXT.returnURL} /></>
            ) : <p className="hint">{rich(TEXT.theReturnURLIsTheWorkspaceURL, { code1: (children) => <code className="code">{children}</code> }, null)}</p>}
          </Section>

          <Section title={TEXT.stepKeycloakSettings} id="settings" hint={TEXT.changingWhoCanSignInOrHow}>
            <SectionSettingsForm section="oidc" items={items} action={saveOidcAction} suggest={!saved("redirect_uri") && suggested ? { redirect_uri: suggested } : undefined} />
          </Section>

          <div data-inpage="check">
            <Section title={TEXT.stepCheckProvider} id="check" hint={TEXT.checksIssuerMetadataNameConnectionAndCertificate}>
              <LoginStatusCard status={status.ok ? { ok: true, data: status.data.oidc } : status} titles={OIDC_STEP_TITLES} what={TEXT.singleSignOn}>
                <ActionForm action={checkOidcAction} submitLabel={TEXT.checkProvider} pendingLabel={TEXT.checking} quiet>
                  <span />
                </ActionForm>
              </LoginStatusCard>
            </Section>
          </div>
          <p className="hint">{TEXT.stepEnableSignInTurnOnKeycloak}</p>
        </>
      )}
    </PageFrame>
  );
}
