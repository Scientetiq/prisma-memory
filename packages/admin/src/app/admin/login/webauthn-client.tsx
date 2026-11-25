"use client";
import { TEXT } from "../../../messages/panel-login";
import { useEffect, useRef, useState } from "react";
import { credentialToJson, requestOptionsFromJson, webauthnAvailable, webauthnErrorText, type RequestOptionsJson } from "@/lib/webauthn-browser";
import { ssoCallbackAction, webauthnAssertAction } from "./actions";

type Phase = { kind: "working"; text: string } | { kind: "key"; tx: string; options: RequestOptionsJson } | { kind: "error"; text: string };

export function SsoCallbackClient({ params }: { params: { state?: string; code?: string; iss?: string; error?: string } }) {
  const [phase, setPhase] = useState<Phase>({ kind: "working", text: TEXT.checkingSignIn });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    ssoCallbackAction(params).then((r) => {
      if (!r) return;
      if (r.kind === "webauthn") setPhase({ kind: "key", tx: r.tx, options: r.options as RequestOptionsJson });
      else setPhase({ kind: "error", text: r.message });
    }, () => setPhase({ kind: "error", text: TEXT.signInDidNotCompleteStartAgain5 }));
  }, [params]);

  async function touch(tx: string, options: RequestOptionsJson) {
    if (!webauthnAvailable()) { setPhase({ kind: "error", text: TEXT.thisBrowserCannotUseSecurityKeysAt }); return; }
    setPhase({ kind: "working", text: TEXT.touchYourSecurityKey });
    let credential: PublicKeyCredential | null;
    try {
      credential = await navigator.credentials.get({ publicKey: requestOptionsFromJson(options) }) as PublicKeyCredential | null;
    } catch (e) {
      setPhase({ kind: "error", text: webauthnErrorText(e) });
      return;
    }
    if (!credential) { setPhase({ kind: "error", text: TEXT.theKeyDidNotRespondStartSign }); return; }
    setPhase({ kind: "working", text: TEXT.checkingKey });
    try {
      const r = await webauthnAssertAction(tx, credentialToJson(credential));
      if (!r) return;
      setPhase({ kind: "error", text: r.kind === "error" ? r.message : TEXT.signInDidNotCompleteStartAgain4 });
    } catch (e) {
      if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
      setPhase({ kind: "error", text: TEXT.signInDidNotCompleteStartAgain3 });
    }
  }

  if (phase.kind === "working") return <p className="sub" role="status" aria-live="polite">{phase.text}</p>;
  if (phase.kind === "key") return (
    <>
      <p className="sub">{TEXT.confirmSignInWithYourSecurityKey}</p>
      <div className="form-actions">
        <button type="button" className="btn primary" autoFocus onClick={() => touch(phase.tx, phase.options)}>{TEXT.confirmWithSecurityKey}</button>
      </div>
    </>
  );
  return (
    <>
      <div className="notice danger" role="alert">{phase.text}</div>
      <p className="foot"><a href="/admin/login" className="btn">{TEXT.startSignInAgain}</a></p>
    </>
  );
}
