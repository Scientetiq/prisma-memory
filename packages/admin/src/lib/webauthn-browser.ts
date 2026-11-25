import { BROWSER_TEXT } from "../messages/webauthn-browser";

export function fromB64url(s: string): ArrayBuffer {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error(BROWSER_TEXT.notBase64url);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function toB64url(b: ArrayBuffer | ArrayBufferView): string {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let bin = "";
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface DescriptorJson { type: "public-key"; id: string; transports?: string[] }
export interface CreationOptionsJson {
  rp: { id: string; name: string }; user: { id: string; name: string; displayName: string }; challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>; timeout?: number; excludeCredentials?: DescriptorJson[];
  authenticatorSelection?: Record<string, unknown>; attestation?: string;
}
export interface RequestOptionsJson { challenge: string; rpId: string; allowCredentials?: DescriptorJson[]; userVerification?: string; timeout?: number }

const descriptor = (d: DescriptorJson) => ({ type: "public-key" as const, id: fromB64url(d.id), ...(d.transports?.length ? { transports: d.transports as AuthenticatorTransport[] } : {}) });

export function creationOptionsFromJson(o: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    rp: { id: o.rp.id, name: o.rp.name },
    user: { id: fromB64url(o.user.id), name: o.user.name, displayName: o.user.displayName },
    challenge: fromB64url(o.challenge),
    pubKeyCredParams: o.pubKeyCredParams.map((p) => ({ type: "public-key" as const, alg: p.alg })),
    ...(o.timeout ? { timeout: o.timeout } : {}),
    excludeCredentials: (o.excludeCredentials ?? []).map(descriptor),
    ...(o.authenticatorSelection ? { authenticatorSelection: o.authenticatorSelection as AuthenticatorSelectionCriteria } : {}),
    attestation: (o.attestation ?? "none") as AttestationConveyancePreference,
  };
}

export function requestOptionsFromJson(o: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromB64url(o.challenge), rpId: o.rpId, allowCredentials: (o.allowCredentials ?? []).map(descriptor),
    ...(o.userVerification ? { userVerification: o.userVerification as UserVerificationRequirement } : {}),
    ...(o.timeout ? { timeout: o.timeout } : {}),
  };
}

export function credentialToJson(c: PublicKeyCredential): { id: string; rawId: string; type: "public-key"; response: Record<string, unknown> } {
  const r = c.response as AuthenticatorResponse & Partial<AuthenticatorAttestationResponse & AuthenticatorAssertionResponse>;
  const response: Record<string, unknown> = { clientDataJSON: toB64url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = toB64url(r.attestationObject);
    const t = typeof r.getTransports === "function" ? r.getTransports() : [];
    if (t.length) response.transports = t;
  }
  if (r.authenticatorData) response.authenticatorData = toB64url(r.authenticatorData);
  if (r.signature) response.signature = toB64url(r.signature);
  if (r.userHandle) response.userHandle = toB64url(r.userHandle);
  return { id: c.id, rawId: toB64url(c.rawId), type: "public-key", response };
}

export function webauthnErrorText(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError") return BROWSER_TEXT.theKeyDidNotConfirmTheRequestTimedOut;
  if (name === "InvalidStateError") return BROWSER_TEXT.thisKeyIsAlreadyRegistered;
  if (name === "SecurityError") return BROWSER_TEXT.theBrowserBlockedTheKeyAtThisAddressThe;
  if (name === "NotSupportedError") return BROWSER_TEXT.thisBrowserOrKeyDoesNotSupportTheRequired;
  return BROWSER_TEXT.couldNotCommunicateWithTheKeyCheckThatIt;
}

export const webauthnAvailable = (): boolean =>
  typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
