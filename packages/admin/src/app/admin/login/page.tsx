import { rich } from "../../../i18n/rich";
import { TEXT } from "../../../messages/panel-login";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Brand } from "@/components/brand";
import { LanguageSwitch } from "@/components/language-switch";
import { firstRunStatus } from "@/lib/gateway";
import { param, type SearchParams } from "@/lib/paging";
import { plainHttpHint, publicHttpsOrigin } from "@/lib/workplace-login";
import { PlainHttpHint } from "@/app/login/plain-http-hint";
import { ssoStartAction } from "./actions";
import { LocalLoginForm } from "./local-form";
import { adminMethods, LEGACY_METHODS, localFormVisible } from "./methods";

export function generateMetadata(): Metadata { return { title: TEXT.signIn3 }; }

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const firstRun = await firstRunStatus();
  if (firstRun === "needed") redirect("/admin/first-run");
  const expired = param(await searchParams, "expired") === "1";
  const m = firstRun === "unreachable" ? LEGACY_METHODS : await adminMethods();
  const local = localFormVisible(m);
  // with an https public address the panel session cookie is Secure too — a plain-HTTP visit cannot sign in here
  const httpsOrigin = publicHttpsOrigin();
  const plainHint = httpsOrigin ? plainHttpHint(httpsOrigin, "/admin/login") : null;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <Brand sub={TEXT.adminPanel2} />
        <h1>{TEXT.panelSignIn2}</h1>
        {plainHint ? <PlainHttpHint text={plainHint.text} href={plainHint.href} /> : null}
        <p className="sub">{m.sso
          ? TEXT.memoryAdministratorsSignInWithTheirCompany
          : TEXT.instanceAdministratorUseTheLoginAndPassword}</p>
        {expired ? <div className="notice warn">{m.sso ? TEXT.yourAdministratorSessionHasEndedItLasts : TEXT.yourPanelSignInHasExpiredIt}</div> : null}
        {firstRun === "unreachable" ? <div className="notice danger" role="alert">{TEXT.memoryIsNotRespondingSignInIs}</div> : null}
        {m.breakglass_open ? <div className="notice warn" role="status">{TEXT.emergencyAccessIsOpenAdminLocalSign}</div> : null}
        {m.sso ? (
          <ActionForm action={ssoStartAction} submitLabel={TEXT.signInWithYourCompanyAccount} pendingLabel={TEXT.openingSignIn}>
            <input type="hidden" name="sso" value="1" />
          </ActionForm>
        ) : null}
        {local ? (
          <>
            {m.sso ? <p className="foot">{TEXT.orUseYourAdminLocalAccount}</p> : null}
            {/* the form asks for the authenticator code after the password when the account has a second factor */}
            <LocalLoginForm autoFocus={!m.sso} />
          </>
        ) : null}
        {!m.sso && !local ? <div className="notice warn" role="status">{TEXT.panelSignInIsClosedCompanySign}</div> : null}
        <p className="foot">{rich(TEXT.forEmployeeAccessSignInToThe, { link1: (children) => <Link href="/login">{children}</Link> }, null)}</p>
        {m.sso ? null : <p className="foot">{TEXT.signInWithTheAdministratorAccountCreated}</p>}
        <LanguageSwitch className="login-lang" returnTo="/admin/login" />
      </div>
    </div>
  );
}
