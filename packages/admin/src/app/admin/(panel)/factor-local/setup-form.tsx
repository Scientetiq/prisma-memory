"use client";
// "Two-step sign-in" set-up in steps: password again → QR code and key → first code → recovery codes once; and
// turning the factor off with a code. The QR code, the key and the codes live only in the state of these forms: a reload
// of the page wipes them (an unconfirmed set-up expires by itself after 10 minutes), and the page itself never renders
// them. The plain-HTTP warning is decided here: only the browser knows the scheme it used.
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useSyncExternalStore } from "react";
import { copyText } from "@/components/secret-box";
import { confirmLocalFactorAction, disableLocalFactorAction, enrollLocalFactorAction, type LocalFactorFlow } from "./actions";
import { codesFileText, groupedSecret, plainHttpExposed, TEXT } from "./view";

const subscribe = () => () => {};

/** Opened over plain HTTP from another machine — the warning above the set-up. Server render: nothing. */
export function PlainHttpWarning() {
  const plain = useSyncExternalStore(subscribe, () => plainHttpExposed(window.location.protocol, window.location.hostname), () => false);
  return plain ? <div className="notice warn" role="alert">{TEXT.plainHttp}</div> : null;
}

function Refusal({ state }: { state: LocalFactorFlow }) {
  if (!state || state.ok) return null;
  return <div className="result"><div className="notice danger" role="alert"><strong>{state.message}</strong></div></div>;
}

/** Recovery codes once: show, copy, download; "Done" only after "I have saved the codes". */
export function CodesOnce({ state }: { state: NonNullable<LocalFactorFlow> }) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  const codes = state.codes ?? [];
  const text = codes.join("\n");
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([codesFileText(state.login ?? "admin", codes)], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "recovery-codes.txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const finish = (): void => {
    // the legacy panel token was signed out with the others: the next page is the sign-in
    if (state.signedOut) window.location.assign("/admin/login");
    else router.refresh();
  };
  return (
    <div className="secret-box factor-codes" role="alert">
      <div className="secret-title">{state.message}</div>
      {state.lines?.length ? <ul className="lines">{state.lines.map((l) => <li key={l}>{l}</li>)}</ul> : null}
      <p className="secret-warning">{TEXT.codesWarning}</p>
      <textarea ref={field} className="secret-value" readOnly rows={Math.min(codes.length, 10)} value={text} onFocus={(e) => e.currentTarget.select()} spellCheck={false} autoComplete="off" />
      <div className="secret-actions">
        <button type="button" className="btn sm" onClick={async () => setCopied((await copyText(text, field.current)) ? "done" : "failed")}>{TEXT.copy}</button>
        <button type="button" className="btn sm" onClick={download}>{TEXT.download}</button>
        {copied === "done" ? <span className="ok-text">{TEXT.copied}</span> : null}
        {copied === "failed" ? <span className="danger-text">{TEXT.copyFailed}</span> : null}
      </div>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} /> {TEXT.codesSaved}</label>
      <div className="row-actions">
        <button type="button" className="btn primary" disabled={!saved} onClick={finish}>{state.signedOut ? TEXT.signInAgain : TEXT.finish}</button>
      </div>
    </div>
  );
}

/** QR code, key as text and the first code — shown only after the gateway accepted the password. */
export function PendingStep({ state, confirmAction, confirming, done, onRestart }:
  { state: NonNullable<LocalFactorFlow>; confirmAction: (fd: FormData) => void; confirming: boolean; done: LocalFactorFlow; onRestart: () => void }) {
  const p = state.pending!;
  return (
    <div className="factor-pending">
      <p>{state.message} {TEXT.apps}</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- a picture from a data address, the Next optimizer has nothing to do */}
      <img className="factor-qr" src={p.qrSrc} alt={TEXT.qrAlt} width={220} height={220} />
      <p className="hint">{TEXT.secretHint}</p>
      <p><code className="code secret-value">{groupedSecret(p.secretText)}</code></p>
      <p className="hint">{TEXT.expires}</p>
      <form action={confirmAction} className="form">
        <label className="field">
          <span className="field-label">{TEXT.codeLabel}</span>
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,8}" maxLength={8} required />
        </label>
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={confirming}>{confirming ? TEXT.confirming : TEXT.confirm}</button>
          <button type="button" className="btn quiet" onClick={onRestart}>{TEXT.restart}</button>
        </div>
      </form>
      <Refusal state={done} />
    </div>
  );
}

export function LocalFactorSetup() {
  const [start, startAction, starting] = useActionState(enrollLocalFactorAction, null as LocalFactorFlow);
  const [done, confirmAction, confirming] = useActionState(confirmLocalFactorAction, null as LocalFactorFlow);
  const [round, setRound] = useState(0);
  if (done?.ok && done.codes?.length) return <CodesOnce state={done} />;
  if (start?.ok && start.pending && round === 0)
    return <PendingStep state={start} confirmAction={confirmAction} confirming={confirming} done={done} onRestart={() => setRound(1)} />;
  return (
    <div className="factor-start">
      <PlainHttpWarning />
      <form action={(fd) => { setRound(0); startAction(fd); }} className="form">
        <label className="field">
          <span className="field-label">{TEXT.passwordLabel}</span>
          <input type="password" name="password" autoComplete="current-password" required />
          <span className="field-hint">{TEXT.setupHint}</span>
        </label>
        <button type="submit" className="btn primary" disabled={starting}>{starting ? TEXT.starting : TEXT.start}</button>
      </form>
      <Refusal state={start} />
    </div>
  );
}

export function LocalFactorDisable() {
  const [state, action, pending] = useActionState(disableLocalFactorAction, null as LocalFactorFlow);
  if (state?.ok) return <div className="notice ok" role="status"><strong>{state.message}</strong></div>;
  return (
    <div>
      <form action={action} className="form">
        <label className="field">
          <span className="field-label">{TEXT.disableLabel}</span>
          <input name="code" autoComplete="one-time-code" maxLength={64} required />
          <span className="field-hint">{TEXT.disableHint}</span>
        </label>
        <button type="submit" className="btn danger" disabled={pending}>{pending ? TEXT.disabling : TEXT.disable}</button>
      </form>
      <Refusal state={state} />
    </div>
  );
}
