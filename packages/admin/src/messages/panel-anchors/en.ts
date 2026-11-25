
export const KIND_TITLES: Readonly<Record<string, string>> = { inner: "Internal (administrators and settings)", edge: "External perimeter (edge and bridge)" };

export const DRAFT_ERRORS: Readonly<Record<string, string>> = {
    stepup: "A draft requires a recent security key touch: sign in again with your key and retry.",
    role: "A memory administrator prepares the draft; security auditors have read-only access.",
    failed: "Draft not prepared: the gateway did not respond. Try again later.",
    roles_not_split: "Draft not prepared: an advanced mode floor is unavailable in this release (roles_not_split). The system cannot yet verify that every service has its own database password. Prepare a document without that floor: memory-admin-cli anchors draft --floor basic.",
};

export const PAGE_TEXT = {
  lead: "Trust anchors are a file signed by two of three signers: administrator networks and accounts, their security keys and pinned values of important settings. While the anchors are in force, these settings can only be changed with a new signed file. Without a signers file on the VM, anchors are inactive and the database supplies settings.",
  trustAnchors: "Trust anchors",
  trustAnchors2: "Trust anchors",
  anchorStatus: "anchor status",
  status: "Status",
  theSettingsPolicyFileDoesNotMatchTheSigned: "The settings policy file does not match the signed file: settings changes are blocked until the anchors are signed again.",
  theSettingsPolicyFileMatchesTheSignedFile: "The settings policy file matches the signed file.",
  tag1AnchorsAreInForceTag1Value2: "<tag1>Anchors are in force.</tag1> {value2}",
  inactiveAnchors: "<tag1>Anchors are inactive</tag1> — the database supplies settings (legacy). They take effect when root places the signers file and signed document on the VM.",
  unpinnedSettings: "Unpinned or inconsistent with the database: these settings are treated as unset until pinned by a new anchors file:",
  appliedDocuments: "Applied documents",
  noAnchorsHaveBeenAppliedYet: "No anchors have been applied yet.",
  document: "Document",
  serial: "Serial",
  applied: "Applied",
  signers: "Signers",
  document2: "Document",
  serial2: "Serial",
  applied2: "Applied",
  signers2: "Signers",
  signerKeyFingerprint: "Signer key fingerprint",
  tag1Value2Tag1: "<tag1>{value2}</tag1>",
  newDocumentForSigning: "New document for signing",
  theDraftUsesTheCurrentStatePinnedAnchorSettings: "The draft uses the current state: pinned anchor settings (secrets include only an HMAC fingerprint), administrator accounts, their security keys and panel networks. Its serial follows the last applied document. Two of three signers sign offline: each runs ssh-keygen -Y sign -f KEY -n memory-anchors-inner trust-anchors-inner.json (KEY is their ed25519 key) and renames the resulting trust-anchors-inner.json.sig to trust-anchors-inner.json.sig.N (each signer uses a different N); verify before applying with memory-admin-cli anchors verify.",
  aMemoryAdministratorPreparesTheDraft: "A memory administrator prepares the draft.",
  downloadTrustAnchorsInnerJsonDraft: "Download trust-anchors-inner.json draft",
};
