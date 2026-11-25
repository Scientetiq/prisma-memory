export const actionsText = {
  noServiceSelected: "No service selected",
  thisServiceNoLongerReadsOn: "This service no longer reads on behalf of colleagues",
  allowedCanReadMemoryOnYour: (value0: string | number | null | undefined): string => `Allowed: “${value0}” can read memory on your behalf`,
  untilRenewPermissionAfterwardsIfNeeded: (value0: string | number | null | undefined): string => `Until ${value0} — renew permission afterwards if needed`,
  noConsentId: "No consent ID",
  consentHasAlreadyEnded: "Consent has already ended",
};

export const pageText = {
  companyServicesThatCanSearchAnd: "Company services that can search and read memory on your behalf see the same information you do. You choose which services to allow and can revoke permission at any time.",
  services: "services",
  services2: "Services",
  noServicesCurrentlyReadOnBehalf: "No services currently read on behalf of colleagues.",
  notAllowed: "not allowed",
  allowedUntil: "allowed until <tag0/>",
  ended: "ended",
  expired: "expired <tag0/>",
  renew: "Renew",
  withdraw: "Revoke",
  revokePermission: "Revoke permission?",
  allow: "Allow",
  allowToReadOnYourBehalf: (value0: string | number | null | undefined): string => `Allow “${value0}” to read on your behalf?`,
  withinItsPermissionsTheServiceCan: "Within its permissions, the service can search and read information you can see. Every read on your behalf appears in “My actions”.",
};
