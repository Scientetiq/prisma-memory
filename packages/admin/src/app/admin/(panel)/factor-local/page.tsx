// "Two-step sign-in": the second factor of the local administrator — a code from an authenticator app asked
// after the password at every sign-in of admin@local (server). Here: the state, setting it up (password again,
// QR code and key, first code, recovery codes once), turning it off with a code. Only the local administrator's own
// session: a single sign-on administrator gets a note and the gateway is not asked. The page renders no secret: the QR
// code, the key and the recovery codes reach the browser only as the answer of a step and live in the form's state, so a
// reload never shows them again. Rendered on every request (`force-dynamic`: `Cache-Control: no-store`).
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, LoadError, Notice, Section } from "@/components/ui";
import { call, GatewayError } from "@/lib/gateway";
import { requireSession } from "@/lib/session";
import { LocalFactorDisable, LocalFactorSetup } from "./setup-form";
import { isLocalSession, parseStatus, STATUS_PATH, TEXT, type LocalTotpStatus } from "./view";

export const metadata: Metadata = { title: TEXT.title };
export const dynamic = "force-dynamic";

type Load = { kind: "ok"; status: LocalTotpStatus } | { kind: "unavailable" } | { kind: "error"; code: string; message: string; status: number };

/** The state from the gateway; its routes are missing (an older gateway) — "not available yet". */
async function load(token: string): Promise<Load> {
  try {
    const r = await call(STATUS_PATH, { token, timeoutMs: 15_000 });
    // the session is over (revoked, expired): to the sign-in page, as every panel page does (lib/api.ts gw)
    if (r.status === 401) redirect("/admin/login?expired=1");
    if (r.status === 404) return { kind: "unavailable" };
    const d = (r.data ?? {}) as { code?: unknown; message?: unknown };
    if (r.status !== 200) return { kind: "error", status: r.status, code: typeof d.code === "string" ? d.code : `http_${r.status}`, message: typeof d.message === "string" ? d.message : TEXT.failed(r.status) };
    const status = parseStatus(r.data);
    return status ? { kind: "ok", status } : { kind: "unavailable" };
  } catch (e) {
    if (e instanceof GatewayError) return { kind: "error", status: e.status, code: e.code, message: e.message };
    throw e;
  }
}

export default async function LocalFactorPage() {
  const session = await requireSession();
  const local = isLocalSession(session);
  const res = local ? await load(session.token) : null;
  return (
    <PageFrame title={TEXT.title} lead={TEXT.lead}>
      {!local ? <Notice tone="info">{TEXT.notLocal}</Notice>
        : res?.kind === "unavailable" ? <Notice tone="info">{TEXT.unavailable}</Notice>
        : res?.kind === "error" ? <LoadError result={res} what={TEXT.loadWhat} />
        : res?.kind === "ok" ? <FactorBody s={res.status} /> : null}
    </PageFrame>
  );
}

function FactorBody({ s }: { s: LocalTotpStatus }) {
  return (
    <>
      <Section title={TEXT.sectionState} id="state" icon="shield" actions={<Badge tone={s.enrolled ? "ok" : "warn"}>{s.enrolled ? TEXT.stateOn : TEXT.stateOff}</Badge>}>
        <p>{s.enrolled ? TEXT.onText : TEXT.offText}</p>
        {s.enrolled && s.activated_at ? <p className="muted">{TEXT.turnedOn} <LocalTime iso={s.activated_at} />.</p> : null}
        {s.enrolled ? <p>{TEXT.recoveryLeft(s.recovery_left)}</p> : null}
        {s.enrolled && s.recovery_left <= 3 ? <Notice tone="warn">{TEXT.recoveryLow}</Notice> : null}
        {!s.enrolled && s.pending ? <Notice tone="info">{TEXT.pendingText}</Notice> : null}
        {!s.enrolled && s.required ? <Notice tone="warn">{TEXT.requiredSetup}</Notice> : null}
      </Section>
      {s.enrolled ? (
        <Section title={TEXT.sectionOff} id="disable" icon="lock">
          {s.required ? <p>{TEXT.requiredText}</p> : <LocalFactorDisable />}
        </Section>
      ) : (
        <Section title={TEXT.sectionSetup} id="setup" icon="key" hint={TEXT.apps}>
          <LocalFactorSetup />
        </Section>
      )}
      <Section title={TEXT.sectionLost} id="lost" icon="info">
        <p>{TEXT.lostPhone}</p>
      </Section>
    </>
  );
}
