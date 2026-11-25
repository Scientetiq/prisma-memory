"use client";
import { useActionState, useState } from "react";
import { ResultBox } from "@/components/action-form";
import { confirmFactorAction, reissueCodesAction, replaceFactorAction, startFactorAction, type FactorFlow } from "./actions";
import { CodesOnce } from "./codes-once";
import { WS_EXTERNAL_MESSAGES } from "./texts";

const grouped = (s: string): string => s.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");

export function FactorSetup({ kind }: { kind: "enroll" | "replace" }) {
  const [start, startAction, starting] = useActionState(kind === "enroll" ? startFactorAction : replaceFactorAction, null as FactorFlow);
  const [done, confirmAction, confirming] = useActionState(confirmFactorAction, null as FactorFlow);
  const [round, setRound] = useState(0);
  if (done?.ok && done.codes?.length) return <CodesOnce codes={done.codes} title={done.message} lines={done.lines} />;
  const pending = start?.ok ? start.pending : undefined;
  if (pending && round === 0) {
    return (
      <div className="factor-pending">
        <p>{start?.message}. {WS_EXTERNAL_MESSAGES.factorApps}</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL; optimizer not needed */}
        <img className="factor-qr" src={pending.qrSrc} alt={WS_EXTERNAL_MESSAGES.qrCodeForAnAuthenticator} width={220} height={220} />
        <p className="hint">{WS_EXTERNAL_MESSAGES.secretTextHint}</p>
        <p><code className="code secret-value">{grouped(pending.secretText)}</code></p>
        <form action={confirmAction} className="form">
          <input type="hidden" name="pending_id" value={pending.id} />
          <label className="field">
            <span className="field-label">{WS_EXTERNAL_MESSAGES.codeFromTheApp}</span>
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
          </label>
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={confirming}>{confirming ? WS_EXTERNAL_MESSAGES.checking : WS_EXTERNAL_MESSAGES.confirm}</button>
            <button type="button" className="btn quiet" onClick={() => setRound(1)}>{WS_EXTERNAL_MESSAGES.startAgain}</button>
          </div>
        </form>
        <ResultBox state={done && !done.ok ? done : null} />
      </div>
    );
  }
  return (
    <div className="factor-start">
      <form action={(fd) => { setRound(0); startAction(fd); }} className="form">
        {kind === "replace" ? (
          <label className="field">
            <span className="field-label">{WS_EXTERNAL_MESSAGES.codeFromYourCurrentPhone}</span>
            <input name="proof" autoComplete="one-time-code" maxLength={32} required />
            <span className="hint">{WS_EXTERNAL_MESSAGES.proofHint}</span>
          </label>
        ) : null}
        <label className="field">
          <span className="field-label">{WS_EXTERNAL_MESSAGES.phoneLabelOptional}</span>
          <input name="label" maxLength={40} placeholder={WS_EXTERNAL_MESSAGES.forExampleWorkPhone} />
        </label>
        <button type="submit" className="btn primary" disabled={starting}>
          {starting ? WS_EXTERNAL_MESSAGES.preparing : kind === "enroll" ? WS_EXTERNAL_MESSAGES.setUpSecondFactor : WS_EXTERNAL_MESSAGES.replacePhone}
        </button>
      </form>
      <ResultBox state={start && !start.ok ? start : null} />
    </div>
  );
}

export function ReissueCodes() {
  const [state, action, pending] = useActionState(reissueCodesAction, null as FactorFlow);
  if (state?.ok && state.codes?.length) return <CodesOnce codes={state.codes} title={state.message} lines={state.lines} />;
  return (
    <div>
      <form action={action} className="form">
        <label className="field">
          <span className="field-label">{WS_EXTERNAL_MESSAGES.codeFromTheAppOr}</span>
          <input name="proof" autoComplete="one-time-code" maxLength={32} required />
        </label>
        <button type="submit" className="btn" disabled={pending}>{pending ? WS_EXTERNAL_MESSAGES.checking2 : WS_EXTERNAL_MESSAGES.getNewCodes}</button>
      </form>
      <ResultBox state={state && !state.ok ? state : null} />
    </div>
  );
}
