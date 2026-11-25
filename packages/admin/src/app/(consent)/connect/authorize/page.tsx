// Consent screen of the built-in agent sign-in. The gateway sent the browser here with
// `?tx=<request>` after an app started signing in at the agent address. The page reads the request with the person's
// workplace session (`GET /api/v1/me/oauth/tx/:id` — reading does not bind the request to anyone) and shows who asks,
// where the code goes and what the app may do. The decision is a plain form to the route handler `decide`; "Not you?
// Sign out" and "Sign in again" are forms to `signout`. Server component, works without JavaScript; English first.
//
// The lines "Allow only if you just started connecting …" and "This request was started … ago" are shown for every
// client — registry, app documents, automatic registration, loopback — and a request older than 3 minutes gets the stale
// warning: a forwarded /oauth/authorize address of somebody else's connector (consent phishing) is decided here.
import type { Metadata } from "next";
import { consentText, type ConsentTextKey } from "@/lib/agent-consent-text";
import { consentApp, consentLines, isTxId, parseConsentTx, txApiPath, type ConsentTx } from "@/lib/agent-consent";
import { meGw } from "@/lib/me-api";
import { param, type SearchParams } from "@/lib/paging";
import { requireUserSession } from "@/lib/user-session";
import { DecisionForm } from "./consent-form";

export function generateMetadata(): Metadata {
  return { title: { absolute: consentText("document_title") }, referrer: "same-origin" };
}
export const dynamic = "force-dynamic";

/** A state without a decision (gone, decided, preview, failed): one sentence, no form. */
function Only({ k }: { k: ConsentTextKey }) {
  return <p className="consent-only" role="status" data-consent={k}>{consentText(k)}</p>;
}

/** "Not you? Sign out" and "Sign in again": the same handler ends this workplace session and comes back to this request. */
function SignOutForm({ tx, label, primary = false }: { tx: string; label: string; primary?: boolean }) {
  return (
    <form method="post" action="/connect/authorize/signout" className={primary ? "consent-actions" : "consent-signout"}>
      <input type="hidden" name="tx" value={tx} />
      <button type="submit" className={primary ? "btn primary" : "link-btn"}>{label}</button>
    </form>
  );
}

function ConsentScreen({ tx, id }: { tx: ConsentTx; id: string }) {
  const { app } = consentApp(tx);
  return <>
    <h1 data-consent="title">{consentText("title", { app })}</h1>
    {/* a div, not a p: a form inside a paragraph is invalid HTML — the browser would close the paragraph before it */}
    <div className="sub" data-consent="who">
      {consentText("who", { name: tx.person.display_name, login: tx.person.login })}{" "}
      <SignOutForm tx={id} label={consentText("not_you")} />
    </div>
    <ul className="consent-lines">
      {consentLines(tx).map((l) => (
        <li key={l.key} data-consent={l.key} className={l.tone ? `consent-${l.tone}` : undefined} role={l.tone === "warn" ? "alert" : undefined}>
          {consentText(l.key, l.vars)}
        </li>
      ))}
    </ul>
    {tx.fresh_login_required ? <>
      {/* the app asked for a fresh sign-in (prompt=login) and this session is older than the request: Allow would be refused */}
      <p className="notice warn" data-consent="fresh_login">{consentText("fresh_login")}</p>
      <SignOutForm tx={id} label={consentText("fresh_login_button")} primary />
    </> : <DecisionForm tx={id} csrf={tx.csrf} decided={tx.decided} />}
  </>;
}

export default async function ConsentPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const tx = param(await searchParams, "tx");
  if (!isTxId(tx)) return <Only k="gone" />;
  const session = await requireUserSession();
  // a preview of the panel cannot approve anything: no form at all
  if (session.preview) return <Only k="preview" />;
  // 401 — the session ended: meGw goes to the sign-in page with the return path of this request
  const res = await meGw<unknown>(session.key, txApiPath(tx));
  if (!res.ok) return <Only k={res.status === 404 ? "gone" : res.status === 409 && res.code === "oauth_tx_decided" ? "decided" : "failed"} />;
  const view = parseConsentTx(res.data);
  return view ? <ConsentScreen tx={view} id={tx} /> : <Only k="failed" />;
}
