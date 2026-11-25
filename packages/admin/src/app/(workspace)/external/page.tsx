import type { Metadata } from "next";
import { headers } from "next/headers";
import { ActionForm } from "@/components/action-form";
import { ConnectionCard } from "@/components/agent-card";
import { LocalTime } from "@/components/local-time";
import { Badge, Empty, LoadError, Notice, PageHead, Section } from "@/components/ui";
import { disabledText, DISABLE_CONFIRM, ENABLE_CONFIRM, EXTERNAL_FACTS, EXTERNAL_ACCESS_MESSAGES, FIRST_CONFIRM_TEXT, FRESH_LOGIN_HREF, REVOKE_ALL_CONFIRM, type ExternalState } from "@/lib/external-access";
import { meGw, type MeResult } from "@/lib/me-api";
import { requireWorkspace } from "@/lib/me";
import type { OAuthConnectionsPage } from "@/lib/oauth-connect";
import { SECTION_TITLES } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import { clientHeaders } from "@/lib/workplace-login";
import { revokeConnectionAction } from "../connect/actions";
import { disableExternalAction, enableExternalAction, revokeAllExternalAction } from "./actions";
import { FACTOR_PATH, WS_EXTERNAL_MESSAGES, type FactorState } from "./factor/texts";
import { ProgramsList } from "./parts";
import { rich } from "@/i18n/rich";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.external }; }

export default async function ExternalPage() {
  const { session } = await requireWorkspace();
  const [res, conns, factor] = session.preview ? [null, null, null] : await Promise.all([
    meGw<ExternalState>(session.key, "/api/v1/me/external", { headers: clientHeaders(await headers()) }),
    meGw<OAuthConnectionsPage>(session.key, "/api/v1/me/connections", { query: { origin: "edge", limit: CONNECTIONS_SHOWN } }),
    meGw<FactorState>(session.key, "/api/v1/me/external/factor"),
  ]);
  return (
    <>
      <PageHead title={SECTION_TITLES.external} lead={EXTERNAL_ACCESS_MESSAGES.externalLead} />
      {session.preview || !res ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice>
        : !res.ok ? <LoadError result={res} what={WS_EXTERNAL_MESSAGES.externalAccessStatus} />
        : <ExternalBody s={res.data} conns={conns} factor={factor?.ok ? factor.data : null} />}
    </>
  );
}

const CONNECTIONS_SHOWN = 20;

function ExternalBody({ s, conns, factor }: { s: ExternalState; conns: MeResult<OAuthConnectionsPage> | null; factor: FactorState | null }) {
  const first = FIRST_CONFIRM_TEXT[s.first_confirm.status];
  return (
    <>
      <Section title={WS_EXTERNAL_MESSAGES.status2} id="state" icon="globe" actions={<Badge tone={s.enabled ? "ok" : "muted"}>{s.enabled ? WS_EXTERNAL_MESSAGES.enabled : WS_EXTERNAL_MESSAGES.disabled}</Badge>}>
        <ul className="plain-list">{EXTERNAL_FACTS.map((f) => <li key={f}>{f}</li>)}</ul>
        {s.enabled ? (
          <>
            <p>{rich(WS_EXTERNAL_MESSAGES.enabledConnectAnAppBelow, null, { value1: s.enabled_at ? <> <LocalTime iso={s.enabled_at} /></> : null })}</p>
            {!s.login_enabled ? <Notice tone="info">{WS_EXTERNAL_MESSAGES.externalSignInIsCurrently}</Notice> : null}
            <div className="row-actions">
              <ActionForm action={revokeAllExternalAction} submitLabel={WS_EXTERNAL_MESSAGES.disconnectAllExternalConnections} pendingLabel={WS_EXTERNAL_MESSAGES.disconnecting} quiet confirm={REVOKE_ALL_CONFIRM}>{null}</ActionForm>
              <ActionForm action={disableExternalAction} submitLabel={WS_EXTERNAL_MESSAGES.disableExternalAccess} pendingLabel={WS_EXTERNAL_MESSAGES.disabling} danger confirm={DISABLE_CONFIRM}>{null}</ActionForm>
            </div>
          </>
        ) : (
          <>
            {s.disabled_at ? <p>{rich(WS_EXTERNAL_MESSAGES.disabled2, null, { value1: <LocalTime iso={s.disabled_at} />, value2: disabledText(s.disabled_code) })}</p> : null}
            {first ? <Notice tone={s.first_confirm.status === "requested" ? "warn" : "info"}>{first}</Notice> : null}
            {!s.fresh_ok ? (
              <Notice tone="info">{rich(WS_EXTERNAL_MESSAGES.beforeEnablingAccessSignIn, null, { value1: <a href={FRESH_LOGIN_HREF}>{WS_EXTERNAL_MESSAGES.signInAgain2}</a> })}</Notice>
            ) : null}
            <ActionForm action={enableExternalAction} submitLabel={WS_EXTERNAL_MESSAGES.enableExternalAccess} pendingLabel={WS_EXTERNAL_MESSAGES.checking3} confirm={ENABLE_CONFIRM}>{null}</ActionForm>
          </>
        )}
      </Section>
      <Section title={WS_EXTERNAL_MESSAGES.factorTitle} id="factor" icon="shield" hint={WS_EXTERNAL_MESSAGES.aCodeFromAnApp}>
        {factor?.enrolled && factor.recovery_low ? <Notice tone="warn">{WS_EXTERNAL_MESSAGES.recoveryLowText}</Notice> : null}
        <p>
          {factor ? (factor.enrolled ? WS_EXTERNAL_MESSAGES.secondFactorIsSetUp : WS_EXTERNAL_MESSAGES.secondFactorIsNotSet) : null}
          <a href={FACTOR_PATH}>{factor?.enrolled ? WS_EXTERNAL_MESSAGES.replacePhoneOrGetNew : WS_EXTERNAL_MESSAGES.setUpSecondFactor2}</a>
        </p>
      </Section>
      <Section title={WS_EXTERNAL_MESSAGES.apps} id="programs" icon="plug" hint={WS_EXTERNAL_MESSAGES.howToConnectAnAgent}>
        <ProgramsList programs={s.programs} enabled={s.enabled} />
      </Section>
      <Section title={WS_EXTERNAL_MESSAGES.externalConnections} id="connections" icon="link" hint={WS_EXTERNAL_MESSAGES.appsYouConnectedFromOutside}>
        <EdgeConnections conns={conns} />
      </Section>
    </>
  );
}

function EdgeConnections({ conns }: { conns: MeResult<OAuthConnectionsPage> | null }) {
  if (!conns) return null;
  if (!conns.ok) return <LoadError result={conns} what={WS_EXTERNAL_MESSAGES.externalConnections2} />;
  if (!conns.data.items.length) return <Empty icon="plug">{WS_EXTERNAL_MESSAGES.noExternalConnections}</Empty>;
  return (
    <>
      <ul className="agents ag-cards">
        {conns.data.items.map((c) => <ConnectionCard key={c.id} c={c} disconnect={revokeConnectionAction} />)}
      </ul>
      {conns.data.next_cursor ? <p className="hint">{rich(WS_EXTERNAL_MESSAGES.theLatestAreShownAll, null, { value1: CONNECTIONS_SHOWN })}</p> : null}
    </>
  );
}
