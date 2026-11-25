import { rich } from "../../i18n/rich";
import { LOGIN_PAGE_PLAIN, TEXT } from "../../messages/ws-login";
import { LOCAL_SIGNIN } from "../../messages/local-signin";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { LanguageSwitch } from "@/components/language-switch";
import { Notice } from "@/components/ui";
import { param, type SearchParams } from "@/lib/paging";
import { authMethods } from "@/lib/auth-methods";
import { safeNext, SESSION_PLAIN, ssoStartHref } from "@/lib/login-return";
import { inServerAction, readUserSession } from "@/lib/user-session";
import { plainHttpHint, publicHttpsOrigin, TEXT as WORKPLACE_LOGIN_TEXT, ssoErrorCode, ssoErrorText, ssoFallbackHint, whereToAsk } from "@/lib/workplace-login";
import { ldapLoginAction } from "./actions";
import { LdapLoginForm } from "./login-form";
import { localLoginAction } from "./local-actions";
import { LocalLoginForm } from "./local-form";
import { PlainHttpHint } from "./plain-http-hint";

export function generateMetadata(): Metadata { return { title: TEXT.signIn2 }; }


export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const expired = param(sp, "expired") === "1";
  const left = param(sp, "left") === "1";
  const ended = param(sp, "ended") === "1";
  const ssoCode = param(sp, "sso_error");
  const next = safeNext(param(sp, "next"));
  const fresh = param(sp, "fresh") === "1";
  if (!expired && !left && !ended && !fresh && (await readUserSession()) && !(await inServerAction())) redirect(next ?? "/");
  const methods = await authMethods();
  const ldapOn = methods?.ldap.enabled === true, ssoOn = methods?.oidc.enabled === true;
  const localOn = methods?.local?.enabled === true, localOnly = localOn && !ldapOn && !ssoOn;
  const contact = methods?.support_contact ?? null;
  const ssoError = ssoErrorText(ssoCode, { ldapOn, contact }), ssoHint = ssoFallbackHint(ssoCode, ldapOn), ssoCodeShown = ssoErrorCode(ssoCode);
  const ssoStillOpen = ssoOn ? ` ${WORKPLACE_LOGIN_TEXT.ssoLogoutNote}` : "";
  const domains = methods?.ldap.domains ?? [];
  const hint = TEXT.userUserAsYouSignInTo(domains.find((d) => d.includes(".")) ?? TEXT.exampleCom, domains.some((d) => !d.includes(".")) ? TEXT.orUser(domains.find((d) => !d.includes("."))) : "");
  const P = LOGIN_PAGE_PLAIN;
  // with an https public address a plain-HTTP visit cannot sign in (the Secure cookie never comes back) — the browser
  // itself tells whether this page is open over HTTP, so the hint is decided on the client
  const httpsOrigin = publicHttpsOrigin();
  const plainHint = httpsOrigin ? plainHttpHint(httpsOrigin) : null;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <Brand sub={TEXT.workspace} />
        <h1>{TEXT.workspaceSignIn2}</h1>
        <p className="sub">{localOnly ? LOCAL_SIGNIN.lead : P.lead}</p>
        {plainHint ? <PlainHttpHint text={plainHint.text} href={plainHint.href} /> : null}
        {expired && (ldapOn || ssoOn || localOn) ? <Notice tone="warn">{SESSION_PLAIN.expired}{next ? ` ${SESSION_PLAIN.back}` : ""}</Notice> : null}
        {fresh ? <Notice tone="info">{P.fresh}</Notice> : null}
        {ended ? <Notice tone="ok">{rich(TEXT.allYourWorkspaceSessionsHaveEndedHere, null, { value1: ssoStillOpen })}</Notice> : null}
        {left && !ended ? <Notice tone="info">{rich(TEXT.youHaveSignedOutYourAgentsKeys, null, { value1: ssoStillOpen })}</Notice> : null}
        {ssoError ? (
          <Notice tone="warn" role="alert">
            {ssoError}{ssoHint ? ` ${ssoHint}` : ""}
            {ssoCodeShown ? <details className="it-details"><summary>{P.details}</summary><code className="code">{ssoCodeShown}</code></details> : null}
          </Notice>
        ) : null}
        {ldapOn ? <LdapLoginForm action={ldapLoginAction} hint={hint} next={next} /> : null}
        {ldapOn && localOn ? <div className="login-or">{TEXT.or}</div> : null}
        {localOn ? <LocalLoginForm action={localLoginAction} next={next} autoFocus={!ldapOn} /> : null}
        {ssoOn ? (
          <>
            {ldapOn || localOn ? <div className="login-or">{TEXT.or}</div> : null}
            <a className="btn sso" href={ssoStartHref(next, fresh)}>{WORKPLACE_LOGIN_TEXT.ssoButtonLabel}</a>
          </>
        ) : null}
        {methods && !ldapOn && !ssoOn && !localOn ? (
          <Notice tone="info">
            <strong>{P.off}</strong>
            <details className="it-details"><summary>{P.details}</summary><span className="muted small">{P.offAdmin}</span></details>
          </Notice>
        ) : null}
        {!methods ? <Notice tone="warn">{P.down}</Notice> : null}
        <details className="login-help" open={Boolean(ssoError) || undefined}>
          <summary>{P.help}</summary>
          <p>{localOnly ? LOCAL_SIGNIN.helpPassword : P.helpPassword}</p>
          {localOnly ? null : <p>{P.helpAccess}</p>}
          <p><strong>{whereToAsk(contact)}</strong></p>
        </details>
        <p className="foot login-admin"><Link href="/admin/login" prefetch={false}>{P.admin}</Link></p>
        <LanguageSwitch className="login-lang" returnTo={next ? `/login?next=${encodeURIComponent(next)}` : "/login"} />
      </div>
    </div>
  );
}

