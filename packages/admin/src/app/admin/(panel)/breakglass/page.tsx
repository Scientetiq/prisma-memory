import { REASONS, PAGE_TEXT } from "../../../../messages/panel-breakglass";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { LoadError, Notice, Section } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.emergencyAccess }; }

interface BreakglassState { open: boolean; window?: string; reason_code?: string; expires_at?: string }


export default async function BreakglassPage() {
  await guardAuditorPage(true);
  const res = await tryGw<BreakglassState>("/api/v1/admin/breakglass");
  return (
    <PageFrame title={PAGE_TEXT.emergencyAccess2} allowAuditor
      lead={PAGE_TEXT.openAnEmergencyAccessWindowOnTheVMFrom}>
      {!res.ok ? <LoadError result={res} what={PAGE_TEXT.emergencyAccessStatus} /> : (
        <Section title={PAGE_TEXT.window} icon="lock">
          {res.data.open ? (
            <Notice tone="danger" role="status">
              <p>{rich(PAGE_TEXT.tag1WindowOpenTag1Value2, { tag1: (children) => <strong>{children}</strong> }, { value2: res.data.reason_code ? ` — ${REASONS[res.data.reason_code] ?? res.data.reason_code}` : "" })}</p>
              {res.data.expires_at ? <p>{rich(PAGE_TEXT.closesAutomaticallyValue1ToCloseItEarlierRunMemory, null, { value1: <LocalTime iso={res.data.expires_at} relative={false} /> })}</p> : null}
            </Notice>
          ) : <Notice tone="ok" role="status"><p>{PAGE_TEXT.windowClosed}</p></Notice>}
        </Section>
      )}
    </PageFrame>
  );
}
