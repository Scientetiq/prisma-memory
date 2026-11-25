"use client";
import { rich } from "../../i18n/rich";
import { TEXT } from "../../messages/ws-login";

export default function LoginError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>{TEXT.workspaceSignIn}</h1>
        <div className="notice warn" role="alert">{rich(TEXT.theSignInPageIsOutOf, { strong1: (children) => <strong>{children}</strong> }, { value1: error.digest ? <>{rich(TEXT.code, null, { value1: error.digest })}</> : null })}</div>
        <button type="button" className="btn primary" onClick={() => { reset(); window.location.reload(); }}>{TEXT.refreshPage}</button>
      </div>
    </div>
  );
}
