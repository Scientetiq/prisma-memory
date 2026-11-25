"use client";
import { REGISTER_CLIENT_TEXT } from "../../../../messages/panel-webauthn";
import { rich } from "../../../../i18n/rich";
import { useState } from "react";
import { creationOptionsFromJson, credentialToJson, requestOptionsFromJson, webauthnAvailable, webauthnErrorText,
         type CreationOptionsJson, type RequestOptionsJson } from "@/lib/webauthn-browser";
import { registerOptionsAction, registerVerifyAction, stepupOptionsAction, stepupVerifyAction } from "./actions";

type Note = { tone: "ok" | "danger" | "info"; text: string } | null;


function Message({ note }: { note: Note }) {
  if (!note) return null;
  return <div className={`notice ${note.tone === "danger" ? "danger" : note.tone === "ok" ? "ok" : "info"}`} role={note.tone === "danger" ? "alert" : "status"}>{note.text}</div>;
}

async function touch(): Promise<Note> {
  const o = await stepupOptionsAction();
  if (!o.ok) return { tone: "danger", text: o.message };
  let cred: PublicKeyCredential | null;
  try { cred = await navigator.credentials.get({ publicKey: requestOptionsFromJson(o.options as RequestOptionsJson) }) as PublicKeyCredential | null; }
  catch (e) { return { tone: "danger", text: webauthnErrorText(e) }; }
  if (!cred) return { tone: "danger", text: REGISTER_CLIENT_TEXT.theKeyDidNotRespondTryAgain };
  const v = await stepupVerifyAction(o.tx, credentialToJson(cred));
  return { tone: v.ok ? "ok" : "danger", text: v.message };
}

export function StepupButton() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  return (
    <div className="form">
      <Message note={note} />
      <div className="form-actions">
        <button type="button" className="btn" disabled={busy} onClick={async () => {
          if (!webauthnAvailable()) { setNote({ tone: "danger", text: REGISTER_CLIENT_TEXT.noWebauthn }); return; }
          setBusy(true); setNote({ tone: "info", text: REGISTER_CLIENT_TEXT.touchYourSecurityKey });
          setNote(await touch().catch(() => ({ tone: "danger" as const, text: REGISTER_CLIENT_TEXT.couldNotCompleteTheActionTryAgain })));
          setBusy(false);
        }}>{busy ? REGISTER_CLIENT_TEXT.waitingForKey : REGISTER_CLIENT_TEXT.confirmWithATouch}</button>
      </div>
    </div>
  );
}

export function RegisterKey() {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function register() {
    if (!webauthnAvailable()) { setNote({ tone: "danger", text: REGISTER_CLIENT_TEXT.noWebauthn }); return; }
    setBusy(true);
    try {
      const o = await registerOptionsAction();
      if (!o.ok) { setNote({ tone: "danger", text: o.message }); return; }
      setNote({ tone: "info", text: REGISTER_CLIENT_TEXT.touchTheNewSecurityKey });
      let cred: PublicKeyCredential | null;
      try { cred = await navigator.credentials.create({ publicKey: creationOptionsFromJson(o.options as CreationOptionsJson) }) as PublicKeyCredential | null; }
      catch (e) { setNote({ tone: "danger", text: webauthnErrorText(e) }); return; }
      if (!cred) { setNote({ tone: "danger", text: REGISTER_CLIENT_TEXT.theKeyDidNotRespondTryAgain2 }); return; }
      const v = await registerVerifyAction(o.tx, credentialToJson(cred), label);
      setNote({ tone: v.ok ? "ok" : "danger", text: v.message });
      if (v.ok) setLabel("");
    } catch {
      setNote({ tone: "danger", text: REGISTER_CLIENT_TEXT.couldNotCompleteTheActionTryAgain2 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <Message note={note} />
      <label className="field">{rich(REGISTER_CLIENT_TEXT.tag1KeyLabelTag1Value2, { tag1: (children) => <span className="field-label">{children}</span> }, { value2: <input type="text" value={label} maxLength={60} placeholder={REGISTER_CLIENT_TEXT.forExampleMainKeySpareInSafe} onChange={(e) => setLabel(e.target.value)} /> })}</label>
      <div className="form-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={register}>{busy ? REGISTER_CLIENT_TEXT.waitingForKey2 : REGISTER_CLIENT_TEXT.addKey}</button>
      </div>
    </div>
  );
}
