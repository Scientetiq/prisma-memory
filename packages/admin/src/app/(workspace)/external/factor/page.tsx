import type { Metadata } from "next";
import { LocalTime } from "@/components/local-time";
import { Badge, LoadError, Notice, PageHead, Section } from "@/components/ui";
import { meGw } from "@/lib/me-api";
import { requireWorkspace } from "@/lib/me";
import { PREVIEW_TEXT } from "@/lib/preview";
import { FactorSetup, ReissueCodes } from "./enroll-form";
import { WS_EXTERNAL_MESSAGES, MODE_TEXT, type FactorState } from "./texts";
import { rich } from "@/i18n/rich";

export function generateMetadata(): Metadata { return { title: WS_EXTERNAL_MESSAGES.factorTitle }; }

export default async function FactorPage() {
  const { session } = await requireWorkspace();
  const res = session.preview ? null : await meGw<FactorState>(session.key, "/api/v1/me/external/factor");
  return (
    <>
      <PageHead title={WS_EXTERNAL_MESSAGES.factorTitle} lead={WS_EXTERNAL_MESSAGES.factorLead} />
      {session.preview || !res ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice>
        : !res.ok ? <LoadError result={res} what={WS_EXTERNAL_MESSAGES.secondFactorStatus} />
        : <FactorBody s={res.data} />}
    </>
  );
}

function FactorBody({ s }: { s: FactorState }) {
  return (
    <>
      <Section title={WS_EXTERNAL_MESSAGES.status} id="state" icon="shield" actions={<Badge tone={s.enrolled ? "ok" : "muted"}>{s.enrolled ? WS_EXTERNAL_MESSAGES.setUp : WS_EXTERNAL_MESSAGES.notSetUp}</Badge>}>
        <p>{MODE_TEXT[s.mode] ?? MODE_TEXT.off}</p>
        {s.enrolled ? (
          <p>{rich(WS_EXTERNAL_MESSAGES.setUpRecoveryCodesRemaining, null, { value1: s.label ? <>{rich(WS_EXTERNAL_MESSAGES.onThePhone, null, { value1: s.label })}</> : null, value2: s.activated_at ? <> <LocalTime iso={s.activated_at} /></> : null, value3: " ", value4: s.recovery_left })}</p>
        ) : s.mode === "required" ? <Notice tone="warn">{WS_EXTERNAL_MESSAGES.youCannotSignInFrom}</Notice> : null}
        {s.enrolled && s.recovery_low ? <Notice tone="warn">{WS_EXTERNAL_MESSAGES.recoveryLowText}</Notice> : null}
        {s.locked_until ? <Notice tone="warn">{rich(WS_EXTERNAL_MESSAGES.afterIncorrectCodesSignIn, null, { value1: <LocalTime iso={s.locked_until} relative={false} /> })}</Notice> : null}
      </Section>
      {s.enrolled ? (
        <>
          <Section title={WS_EXTERNAL_MESSAGES.replacePhone2} id="replace" icon="refresh" hint={WS_EXTERNAL_MESSAGES.newPhoneEnterACode}>
            <FactorSetup kind="replace" />
          </Section>
          <Section title={WS_EXTERNAL_MESSAGES.recoveryCodes} id="codes" icon="key" hint={WS_EXTERNAL_MESSAGES.ifYourPhoneIsUnavailable}>
            <ReissueCodes />
          </Section>
        </>
      ) : (
        <Section title={WS_EXTERNAL_MESSAGES.setUp2} id="setup" icon="key" hint={WS_EXTERNAL_MESSAGES.factorApps}>
          <FactorSetup kind="enroll" />
        </Section>
      )}
      <Section title={WS_EXTERNAL_MESSAGES.ifYourPhoneIsLost} id="lost" icon="info">
        <p>{WS_EXTERNAL_MESSAGES.lostPhoneText}</p>
      </Section>
    </>
  );
}
