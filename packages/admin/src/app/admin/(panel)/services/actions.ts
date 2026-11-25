"use server";
import { servicesActions as m } from "@/messages/panel-services";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { issueKeyHref } from "@/lib/admin-tabs";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { gw } from "@/lib/api";
import { parseKeyFingerprint } from "@/lib/key-fingerprint";
import { endOfDayIso, personKeyLimitIso } from "@/lib/format";
import { GatewayError } from "@/lib/gateway";
import { isId, text } from "@/lib/form";
import { isNetBound } from "@/lib/net-bound";
import { isClientKind, KEY_KINDS, parseCidrs, PERSON_KEY_MAX_DAYS, SERVICE_KINDS, SERVICE_OPS, TIERS, TRANSCRIBER_OPS } from "@/lib/labels";
import type { ApiKey, KeyIssueResult, Service, ServicePatchResponse } from "@/lib/types";

export async function createServiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const name = text(formData, "name"), kind = text(formData, "kind"), tier = text(formData, "tier");
  const allowed_ops = formData.getAll("allowed_ops").map(String).filter((o) => (SERVICE_OPS as readonly string[]).includes(o));
  if (!name) return failState(m.enterAServiceName);
  if (!/^\S{2,100}$/.test(name)) return failState(m.serviceNameCharactersWithoutSpacesItIdentifiesThe);
  if (!(SERVICE_KINDS as readonly string[]).includes(kind)) return failState(m.chooseAServiceKind);
  if (!(TIERS as readonly string[]).includes(tier)) return failState(m.chooseATrustTierTOrT);
  if (!allowed_ops.length) return failState(m.selectAtLeastOneAllowedOperationWithoutAny);

  const write_space = text(formData, "write_space");
  let out: Service;
  try {
    const obo_allowed = formData.get("obo_allowed") === "on";
    out = await gw<Service>("/api/v1/admin/services", { method: "POST", body: { name, kind, tier, obo_allowed, obo_read: obo_allowed && formData.get("obo_read") === "on", allowed_ops,
                                                                                ...(write_space ? { write_space } : {}) } });
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.serviceNotCreated(e.message));
    throw e;
  }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(m.serviceCreated(out.name), { lines: [m.nowIssueAServiceKeyWithoutOneThe],
                                                link: { href: issueKeyHref(out.name), label: m.issueAKeyToThisService } });
}

export async function createTranscriberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const variant = text(formData, "variant"), name = text(formData, "name"), write_space = text(formData, "write_space");
  if (variant !== "prod" && variant !== "test") return failState(m.chooseAProductionTranscriberOrATestEnvironment);
  if (!/^\S{2,100}$/.test(name)) return failState(m.serviceNameCharactersWithoutSpaces);
  if (variant === "test" && !write_space) return failState(m.aTestEnvironmentNeedsAWriteSpaceThe);
  let out: Service;
  try {
    out = await gw<Service>("/api/v1/admin/services", { method: "POST", body: {
      name, kind: "transcriber", tier: "T0", obo_allowed: true, obo_read: false, allowed_ops: [...TRANSCRIBER_OPS], ...(variant === "test" ? { write_space } : {}) } });
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.serviceNotCreated(e.message));
    throw e;
  }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(m.transcriberCreated(out.name, out.write_space ?? null), { lines: [
    m.nowIssueAKeyTheLinkBelowAlready,
    m.anOnBehalfOfServiceKeyRequiresAddress,
  ], link: { href: issueKeyHref(out.name), label: m.issueATranscriberKey } });
}

export async function setServiceWriteSpaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id"), slug = text(formData, "write_space");
  if (!isId(id)) return failState(m.serviceIdIsMissing);
  let out: ServicePatchResponse;
  try { out = await gw<ServicePatchResponse>(`/api/v1/admin/services/${encodeURIComponent(id)}`, { method: "PATCH", body: { write_space: slug || null } }); }
  catch (e) { if (e instanceof GatewayError) return failState(m.notChanged(e.message)); throw e; }
  refresh();
  return okState(out.write_space ? m.serviceWritesOnlyTo(out.name, out.write_space) : m.serviceWritesAsUsual(out.name), {
    lines: [out.write_space ? m.fromTheServiceSNextRequestMeetingsAnd : m.fromTheServiceSNextRequestMeetingsWill],
  });
}

export async function issueKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const kind = text(formData, "kind"), principal = text(formData, "principal"), client_label = text(formData, "client_label"), expires = text(formData, "expires_at"), basis = text(formData, "basis");
  if (!(KEY_KINDS as readonly string[]).includes(kind)) return failState(m.chooseAKeyKind);
  if (!principal) return failState(kind === "service" ? m.enterTheNameOfTheServiceThatOwns : m.enterTheLoginOfThePersonWhoOwns);
  const fp = kind === "service" ? parseKeyFingerprint(text(formData, "fingerprint")) : null;
  if (fp && "error" in fp) return failState(fp.error);
  const forPerson = kind === "personal" || kind === "extended";
  const client_kind = forPerson ? text(formData, "client_kind") : "";
  if (forPerson && !client_kind) return failState(m.chooseTheProgramWhereThePersonWillUse);
  if (forPerson && !isClientKind(client_kind)) return failState(m.unknownKeyProgramChooseOneFromTheList);
  if ((kind === "personal" || kind === "extended") && basis.length < 3) return failState(m.enterAReasonForIssuingAKeyOn);
  if (basis.length > 500) return failState(m.reasonAtMostCharacters);
  const openWrite = kind === "extended" && formData.get("open_write") === "on";
  const openWriteBasis = openWrite ? text(formData, "open_write_basis") : "";
  if (openWrite && openWriteBasis.length < 3) return failState(m.enterAReasonForAllowingOpenRecordsRequest);
  if (openWriteBasis.length > 500) return failState(m.permissionReasonAtMostCharacters);
  const expires_at = expires ? endOfDayIso(expires) : null;
  if (expires && !expires_at) return failState(m.expiryEnterADate);
  const net_cidrs = parseCidrs(text(formData, "net_cidrs"));
  if (net_cidrs.length > 20) return failState(m.atMostAllowedAddresses);
  if (kind === "extended" && !isNetBound(net_cidrs)) return failState(m.anExtendedKeyRequiresAddressBindingEnterThe);
  if (expires_at && Date.parse(expires_at) <= Date.now()) return failState(m.theExpiryDateHasAlreadyPassed);
  if (kind === "personal" || kind === "extended") {
    if (!expires_at) return failState(m.aPersonSKeyMustExpireEnterA(PERSON_KEY_MAX_DAYS));
    if (expires_at > personKeyLimitIso(PERSON_KEY_MAX_DAYS)) return failState(m.aPersonSKeyMayLastAtMost(PERSON_KEY_MAX_DAYS));
  }

  let out: KeyIssueResult;
  try {
    out = await gw<KeyIssueResult>("/api/v1/admin/keys", {
      method: "POST",
      body: { kind, principal: kind === "service" ? principal : principal.toLowerCase(), client_label: client_label || null, expires_at, basis: basis || null,
              ...(forPerson ? { client_kind } : {}), ...(net_cidrs.length ? { net_cidrs } : {}), ...(openWrite ? { open_write: true, open_write_basis: openWriteBasis } : {}),
              ...(fp ? { key_sha256: fp.key_sha256, key_prefix: fp.key_prefix } : {}) },
    });
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.keyNotIssued(e.message));
    throw e;
  }
  refresh();
  const pending = approvalPendingOf(out);
  if (pending) return approvalPendingState(pending);
  return okState(m.issuedKeyMessage(kind, out.key.key_prefix, out.key.principal ?? null), {
    lines: [m.trustTier(out.key.tier), forPerson && isClientKind(client_kind) ? m.keyProgram(client_kind) : "", net_cidrs.length ? m.allowedAddresses(net_cidrs.join(", ")) : "", out.key.expires_at ? m.validUntil(out.key.expires_at) : m.noExpiryRevokeManually, basis ? m.reason(basis) : "",
      kind === "extended" ? m.theKeyReadsThePersonSOwnClosed : "",
      kind === "extended" ? (openWrite ? m.openRecordsAllowedReasonTheyAreMarkedAnd(openWriteBasis) : m.thisKeyCannotCreateOpenRecordsYouCan) : "",
      out.registered_by_fingerprint ? m.registeredByFingerprintTheSecretStaysWithThe : ""].filter(Boolean),
    ...(out.secret === null ? {} : { secret: {
      label: m.keySecret(out.key.key_prefix),
      value: out.secret,
      warning: m.theSecretIsShownOnceOnlyItsHash,
    } }),
  });
}

export async function setServiceActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id"), active = text(formData, "active") === "true";
  if (!isId(id)) return failState(m.serviceIdIsMissing);
  let out: ServicePatchResponse;
  try { out = await gw<ServicePatchResponse>(`/api/v1/admin/services/${encodeURIComponent(id)}`, { method: "PATCH", body: { active } }); }
  catch (e) { if (e instanceof GatewayError) return failState(m.notSaved(e.message)); throw e; }
  refresh();
  return okState(active ? m.serviceEnabled(out.name) : m.serviceDisabled(out.name), {
    lines: active
      ? [m.issueNewServiceKeysDisablingTheServiceRevoked]
      : [m.serviceKeysRevoked(out.keys_revoked ?? 0), m.clientsUsingTheseKeysLostAccessImmediatelyEnabling],
  });
}

export async function revokeKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(m.keyIdIsMissing);
  try {
    await gw(`/api/v1/admin/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof GatewayError) return failState(e.status === 404 ? m.alreadyRevoked : e.message);
    throw e;
  }
  refresh();
  return okState(m.revoked);
}

export async function setServiceOboReadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id"), obo_read = text(formData, "obo_read") === "true";
  if (!isId(id)) return failState(m.serviceIdIsMissing);
  let out: ServicePatchResponse;
  try { out = await gw<ServicePatchResponse>(`/api/v1/admin/services/${encodeURIComponent(id)}`, { method: "PATCH", body: { obo_read } }); }
  catch (e) { if (e instanceof GatewayError) return failState(m.notSaved(e.message)); throw e; }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(obo_read ? m.serviceReadsOnBehalfOfPeople(out.name) : m.serviceNoLongerReadsOnBehalfOfPeople(out.name), {
    lines: [obo_read ? m.searchReadAndListOnBehalfOfPeople : m.writeAndIngestOnBehalfRemainAvailableSearch],
  });
}

export async function bindKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(m.keyIdIsMissing);
  const cidrs = parseCidrs(text(formData, "cidrs"));
  if (cidrs.length > 20) return failState(m.atMostAllowedAddresses);
  let out: ApiKey;
  try { out = await gw<ApiKey>(`/api/v1/admin/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: { net_cidrs: cidrs.length ? cidrs : null } }); }
  catch (e) { if (e instanceof GatewayError) return failState(m.notSaved(e.message)); throw e; }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(cidrs.length ? m.keyBound(out.key_prefix, cidrs.join(", ")) : m.bindingRemovedForKey(out.key_prefix), {
    lines: [cidrs.length ? m.requestsFromOtherAddressesWillReceiveCheckThat : m.theKeyIsAcceptedFromAnyAddressAgain],
  });
}

export async function setKeyOpenWriteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id"), on = text(formData, "open_write") === "true", basis = text(formData, "open_write_basis");
  if (!isId(id)) return failState(m.keyIdIsMissing);
  if (on && (basis.length < 3 || basis.length > 500)) return failState(m.enterAReasonForPermissionRequestNumberOr);
  let out: ApiKey;
  try { out = await gw<ApiKey>(`/api/v1/admin/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: on ? { open_write: true, open_write_basis: basis } : { open_write: false } }); }
  catch (e) { if (e instanceof GatewayError) return failState(m.notSaved(e.message)); throw e; }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(on ? m.openRecordsAllowedForKey(out.key_prefix) : m.openRecordsDisallowedForKey(out.key_prefix), {
    lines: [on ? m.fromTheAgentSNextRequestItsOpen
               : m.fromTheAgentSNextRequestItCannot],
  });
}

export async function unpauseKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(m.keyIdIsMissing);
  try { await gw(`/api/v1/admin/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: { paused_until: null } }); }
  catch (e) { if (e instanceof GatewayError) return failState(m.notSaved(e.message)); throw e; }
  refresh();
  return okState(m.pauseCleared, { lines: [m.ifOnBehalfOfFailuresContinueTheKey] });
}
