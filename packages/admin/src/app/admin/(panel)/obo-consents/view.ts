import { VIEW_TEXT, REVOKED_BY, STATE_BADGES } from "../../../../messages/panel-obo-consents";
export { VIEW_TEXT };

export interface OboConsent {
  id: string | null;
  service: { id: string; name: string };
  person?: string | null;
  granted_at: string | null; expires_at: string | null; revoked_at: string | null;
  revoked_by: "person" | "admin" | "service_off" | "person_inactive" | "expired" | null;
}

export { REVOKED_BY };

export type ConsentState = "none" | "live" | "expired" | "revoked";
export function consentState(c: Pick<OboConsent, "id" | "expires_at" | "revoked_at">, now = Date.now()): ConsentState {
  if (!c.id) return "none";
  if (c.revoked_at) return "revoked";
  return c.expires_at && Date.parse(c.expires_at) <= now ? "expired" : "live";
}

export { STATE_BADGES };


export type OboReadMode = "consent" | "legacy" | "off";
export interface ConsentTexts {
  mode: OboReadMode;
  tone: "info" | "warn";
  notice: string;
  none: string;
  revokeChange: (service: string) => string;
  revokedOk: string;
}

export function consentTexts(raw: string | null | undefined): ConsentTexts {
  const mode: OboReadMode = raw === "consent" || raw === "legacy" ? raw : "off";
  if (mode === "consent") return {
    mode, tone: "info",
    notice: VIEW_TEXT.theServiceCanReadMemoryOnYourBehalfOnly,
    none: VIEW_TEXT.withoutConsentTheServiceCannotReadOnYourBehalf,
    revokeChange: (s) => VIEW_TEXT.value1WillStopReadingMemoryOnYourBehalf(s),
    revokedOk: VIEW_TEXT.consentRevokedTheServiceCanNoLongerReadOn,
  };
  if (mode === "legacy") return {
    mode, tone: "info",
    notice: VIEW_TEXT.consentIsCurrentlyOptionalServicesWithReadAccessCan,
    none: VIEW_TEXT.noConsentWhileConsentIsOptionalTheServiceCan,
    revokeChange: (s) => VIEW_TEXT.consentWillBeClosedUntilAnAdministratorRequiresConsent(s),
    revokedOk: VIEW_TEXT.consentRevokedUntilAnAdministratorRequiresConsentTheService,
  };
  return {
    mode, tone: "warn",
    notice: VIEW_TEXT.readingOnBehalfOfColleaguesIsCurrentlyDisabledFor,
    none: VIEW_TEXT.noConsentReadingOnBehalfOfPeopleIsCurrently,
    revokeChange: (s) => VIEW_TEXT.consentWillBeClosedValue1AlreadyCannotReadOn(s),
    revokedOk: VIEW_TEXT.consentRevokedReadingOnBehalfOfColleaguesIsCurrently,
  };
}
