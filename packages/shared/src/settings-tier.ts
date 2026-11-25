// Settings tier map: which settings a simple install needs and which belong to a future profile.
//
//   standard — what every install may need: sign-in, directory, models, storage, limits, locale, the security mode switch;
//   hardened — features of the hardened profile: second signatures and their step-up, break-glass access, WebAuthn keys of
//              administrators and their attestation list, service keys by fingerprint only, the delay of a mode downgrade;
//   edge     — the external contour (every `edge.*` key).
//
// Pure data: no setting changes its value, its validation or its visibility because of the tier. The admin API returns the
// tier with each item of the settings listing so that the panel can hide the non-standard tiers by default later.
// Keys added later need no edit here: `edge.*` → edge by prefix, everything else → standard unless it is listed below.
// A unit test walks `contracts/settings/registry.json`: a listed key that does not exist fails it.

export const SETTING_TIERS = ["standard", "hardened", "edge"] as const;
export type SettingTier = (typeof SETTING_TIERS)[number];

/** The explicit exceptions: keys of the hardened profile ("category.key"). Frozen; `tierOf` reads a private copy. */
export const HARDENED_SETTINGS: readonly string[] = Object.freeze([
  // second signatures and the fresh key touch that signs another administrator's request
  "admin.second_signature",
  "admin.second_signature_ttl_hours",
  "admin.stepup_max_min",
  // break-glass access
  "admin.breakglass_max_hours",
  "admin.bastion_cidrs",
  // WebAuthn keys of administrators and the attestation list (device-bound key models)
  "admin.webauthn_required",
  "admin.webauthn_rp_id",
  "admin.webauthn_origins",
  "admin.webauthn_uv",
  "admin.webauthn_min_keys",
  "admin.webauthn_aaguids",
  // service keys by fingerprint only (the advanced mode layer)
  "admin.service_keys_by_fingerprint",
  // how long a return from the advanced mode waits after it is signed
  "security.downgrade_delay_hours",
]);

// Private to the module, so no importer can move a key between tiers at run time.
const hardened: ReadonlySet<string> = new Set(HARDENED_SETTINGS);

/** Tier of a setting by its path "category.key". */
export function tierOf(path: string): SettingTier {
  if (path.startsWith("edge.")) return "edge";
  return hardened.has(path) ? "hardened" : "standard";
}

/** Tier of a setting by its category and key (the shape of the settings listing). */
export const tierOfSetting = (category: string, key: string): SettingTier => tierOf(`${category}.${key}`);
