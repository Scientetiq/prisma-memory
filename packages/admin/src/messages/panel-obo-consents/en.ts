import type { OboConsent, ConsentState } from "../../app/admin/(panel)/obo-consents/view";

export const REVOKED_BY: Readonly<Record<NonNullable<OboConsent["revoked_by"]>, string>> = {
    person: "revoked by the colleague",
    admin: "revoked by an administrator",
    service_off: "service disabled or no longer reads on behalf of people",
    person_inactive: "colleague inactive",
    expired: "expired",
};

export const STATE_BADGES: Readonly<Record<ConsentState, { title: string; tone: "ok" | "muted" | "warn" | "neutral" }>> = {
    live: { title: "active", tone: "ok" },
    expired: { title: "expired", tone: "warn" },
    revoked: { title: "revoked", tone: "muted" },
    none: { title: "not granted", tone: "neutral" },
};

export const ACTIONS_TEXT = {
  noConsentID: "No consent ID",
  consentRevoked: "Consent revoked",
  theServiceCanNoLongerReadOnBehalfOf: "The service can no longer read on behalf of this colleague; they will see the revocation in “My actions”",
  consentAlreadyClosed: "Consent already closed",
  notRevokedResponseValue1: (value1: string | number): string => `Not revoked: response ${value1}`,
};

export const PAGE_TEXT = {
  readConsentsOnBehalfOfPeople: "On-behalf-of consents",
  readConsentsOnBehalfOfPeople2: "On-behalf-of consents",
  consents: "Consents",
  consents2: "consents",
  noConsents: "No consents.",
  service: "Service",
  colleague: "Colleague",
  status: "Status",
  expiry: "Expiry",
  actions: "Actions",
  service2: "Service",
  colleague2: "Colleague",
  status2: "Status",
  closed: "closed",
  expiry2: "Expiry",
  grantedValue1: "granted {value1}",
  untilValue1: "until {value1}",
  actions2: "Actions",
  revoke: "Revoke",
  revokeConsent: "Revoke consent?",
  thisColleague: "this colleague",
  value1WillNoLongerBeAbleToReadOn: (value1: string | number, value2: string | number): string => `“${value1}” will no longer be able to read on behalf of ${value2}. Only the colleague can restore consent in the workspace.`,
  revoke2: "Revoke",
  consents3: "consents",
};

export const VIEW_TEXT = {
  oboAdminLead: "Services can read memory on behalf of colleagues only with their consent when access.obo_read_consent = consent (legacy requires no consent; off disables reading on behalf of anyone). Colleagues grant consent in the workspace under “Service access”; administrators can only revoke it. The duration is access.obo_read_consent_days. This page shows active consents and those closed in the last 90 days.",
  theServiceCanReadMemoryOnYourBehalfOnly: "The service can read memory on your behalf only while your consent is active. Without consent, it can only write on your behalf.",
  withoutConsentTheServiceCannotReadOnYourBehalf: "without consent, the service cannot read on your behalf",
  value1WillStopReadingMemoryOnYourBehalf: (value1: string | number): string => `“${value1}” will stop reading memory on your behalf.`,
  consentRevokedTheServiceCanNoLongerReadOn: "Consent revoked: the service can no longer read on your behalf",
  consentIsCurrentlyOptionalServicesWithReadAccessCan: "Consent is currently optional: services with read access can read on behalf of colleagues as before. You can grant consent in advance for when an administrator makes it required.",
  noConsentWhileConsentIsOptionalTheServiceCan: "no consent — while consent is optional, the service can read without it",
  consentWillBeClosedUntilAnAdministratorRequiresConsent: (value1: string | number): string => `Consent will be closed. Until an administrator requires consent, “${value1}” can still read on behalf of colleagues without it.`,
  consentRevokedUntilAnAdministratorRequiresConsentTheService: "Consent revoked. Until an administrator requires consent, the service can still read on behalf of colleagues without it",
  readingOnBehalfOfColleaguesIsCurrentlyDisabledFor: "Reading on behalf of colleagues is currently disabled for all services. You can grant consent in advance.",
  noConsentReadingOnBehalfOfPeopleIsCurrently: "no consent — reading on behalf of people is currently disabled for everyone",
  consentWillBeClosedValue1AlreadyCannotReadOn: (value1: string | number): string => `Consent will be closed. “${value1}” already cannot read on your behalf: reading on behalf of people is disabled for all services.`,
  consentRevokedReadingOnBehalfOfColleaguesIsCurrently: "Consent revoked. Reading on behalf of colleagues is currently disabled for all services",
};
