"use server";
import { derived } from "@/i18n/runtime";
import { peopleActions } from "@/messages/panel-people";
import { createHash } from "node:crypto";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { formatDecimal } from "@/i18n/format";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { gw } from "@/lib/api";
import { custodyUploadLine, CUSTODY_VIEW_TEXT, REACTIVATION_FIELD, reactivationAsk, reactivationLogins } from "@/lib/custody-view";
import { GatewayError } from "@/lib/gateway";
import { parseOrgUnitsUpload, parsePeopleUpload, type ParsedUpload, type PeopleBody, type PersonInput } from "@/lib/people-csv";
import { requireSession } from "@/lib/session";
import type { AccessSummary, DeactivationPreview, OrgUnitsUpsertResponse, PeopleRowNote, PeopleUpsertResponse } from "@/lib/types";

function rowPlace(parsed: ParsedUpload<unknown>, row: number | undefined): string | null {
  if (!row) return null;
  const at = parsed.lines[row - 1] ?? row;
  return parsed.format === "csv" ? peopleActions.line(at) : peopleActions.element(at);
}
const rowNote = (parsed: ParsedUpload<unknown>, n: PeopleRowNote): string => {
  const place = rowPlace(parsed, n.row);
  return peopleActions.message(place ? `${place[0]!.toUpperCase()}${place.slice(1)}` : peopleActions.row, n.login ? ` (${n.login})` : "", n.message);
};

function rejectedLines(parsed: ParsedUpload<unknown>, details: unknown): string[] {
  const d = (details ?? {}) as { departments?: Array<{ department: string; logins?: string[]; rows?: number[] }>; errors?: PeopleRowNote[] };
  const out: string[] = [];
  for (const dep of d.departments ?? []) {
    const places = (dep.rows ?? []).map((r) => rowPlace(parsed, r)).filter(Boolean);
    out.push(peopleActions.departmentHasNoCodeDepartmentCode(dep.department, places.length ? ` — ${places.join(", ")}` : "", dep.logins?.length ? `: ${dep.logins.slice(0, 10).join(", ")}${dep.logins.length > 10 ? "…" : ""}` : ""));
  }
  for (const e of (d.errors ?? []).slice(0, 50)) out.push(peopleActions.error(rowNote(parsed, e)));
  if ((d.errors?.length ?? 0) > 50) out.push(peopleActions.andMoreErrors(d.errors!.length - 50));
  return out;
}

const ORG_OWNER_SOURCE: Record<string, string> = derived(() => ({ export: peopleActions.fromUpload, kept: peopleActions.unchanged, admin: peopleActions.assignedByAnAdministrator }));
const orgOwnerLines = (o: PeopleUpsertResponse["org_owner"]): string[] =>
  o?.login ? [peopleActions.companyKnowledgeOwner(o.login, ORG_OWNER_SOURCE[o.source] ? ` (${ORG_OWNER_SOURCE[o.source]})` : "")] : [];

const accessLine = (a: AccessSummary | undefined): string =>
  a ? peopleActions.accessSummary(a.spaces_created, a.added, a.removed, a.orphaned_spaces ?? [])
    : peopleActions.noAccessRecalculationDetails;

const CONFIRM_FIELD = "confirm_deactivations";

const UPLOAD_FIELD = "confirm_upload";

const uploadPrint = (people: readonly PersonInput[]): string => createHash("sha256").update(JSON.stringify(people)).digest("hex").slice(0, 32);


function massOf(details: unknown): DeactivationPreview | null {
  const m = (details as { reason?: string; mass_deactivation?: DeactivationPreview } | undefined);
  return m?.reason === "mass_deactivation" && typeof m.mass_deactivation?.will_deactivate === "number" ? m.mass_deactivation : null;
}

const pctText = (share: number | undefined): string => `${formatDecimal(Math.round((share ?? 0.2) * 1000) / 10)}%`;

function massRefusal(m: DeactivationPreview, confirmed: number | undefined, keep: Record<string, string> = {}, extra: string[] = []): ActionState {
  const names = m.sample.slice(0, 10).map((x) => x.display_name || x.login);
  const more = m.will_deactivate - names.length;
  return failState(confirmed === undefined
    ? peopleActions.aSecondConfirmationIsRequiredTheUpload(m.will_deactivate, m.active_total, pctText(m.share))
    : peopleActions.theCountChangedYouConfirmedButThe(confirmed, m.will_deactivate, m.active_total), {
    lines: [
      ...extra,
      peopleActions.peopleToBeDeactivatedInclude(names.join(", "), more > 0 ? peopleActions.andMore(more) : ""),
      peopleActions.thisCanHappenWithADamagedFile,
      peopleActions.ifTheFileIsCorrectConfirmBelow,
    ],
    ask: CONFIRM_FIELD, askValue: String(m.will_deactivate),
    askLabel: peopleActions.yesDeactivateOfICheckedTheFile(m.will_deactivate, m.active_total),
    ...(Object.keys(keep).length ? { askKeep: keep } : {}),
  });
}

const backLogins = (notes: readonly PeopleRowNote[] | undefined): string[] =>
  [...new Set((notes ?? []).filter((e) => e.reason === "reactivation_confirm").map((e) => e.login.toLowerCase()))];

function reactivationRefusal(logins: string[], partial: boolean, keep: Record<string, string>, lines: string[] = []): ActionState {
  const ask = reactivationAsk(logins, partial);
  return failState(ask.message, { lines: [...ask.lines, ...lines], ask: REACTIVATION_FIELD, askValue: logins.join(","), askLabel: CUSTODY_VIEW_TEXT.reactivationAskLabel,
                                  ...(Object.keys(keep).length ? { askKeep: keep } : {}) });
}

function custodianIsOperatorOf(details: unknown): string[] | null {
  const d = details as { reason?: unknown; logins?: unknown } | null | undefined;
  return d && d.reason === "custodian_is_operator" && Array.isArray(d.logins) ? d.logins.map(String) : null;
}

export async function uploadPeopleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const denied = await denyAuditor(); if (denied) return denied;
  const parsed = parsePeopleUpload(String(formData.get("payload") ?? ""));
  if (!parsed.body) return failState(peopleActions.uploadNotSentTheTextCouldNot, { lines: parsed.errors.slice(0, 30) });
  const full = formData.get("deactivate_missing") === "on";
  const print = uploadPrint(parsed.body.people);
  const asked = formData.get(CONFIRM_FIELD) !== null || formData.get(REACTIVATION_FIELD) !== null;
  const same = formData.get(UPLOAD_FIELD) === print;
  const changed = asked && !same;
  const confirmed = same ? String(formData.get(CONFIRM_FIELD) ?? "") : "";
  const back = same ? reactivationLogins(formData.get(REACTIVATION_FIELD)) : [];
  const body: PeopleBody = { people: parsed.body.people, ...(full ? { deactivate_missing: true } : {}),
                             ...(full && /^\d{1,6}$/.test(confirmed) ? { confirm_deactivations: Number(confirmed) } : {}),
                             ...(back.length ? { confirm_reactivations: back } : {}) };
  const keepPrint: Record<string, string> = { [UPLOAD_FIELD]: print };
  const keepBack: Record<string, string> = { ...(back.length ? { [REACTIVATION_FIELD]: back.join(",") } : {}), ...keepPrint };
  const keepMass: Record<string, string> = { ...(body.confirm_deactivations !== undefined ? { [CONFIRM_FIELD]: String(body.confirm_deactivations) } : {}), ...keepPrint };
  const changedLine = changed ? [peopleActions.theUploadTextChangedAfterConfirmationConfirm] : [];

  let out: PeopleUpsertResponse;
  try {
    out = await gw<PeopleUpsertResponse>("/api/v1/admin/people", { method: "PUT", body, timeoutMs: 300_000 });
  } catch (e) {
    const mass = e instanceof GatewayError ? massOf(e.details) : null;
    if (mass) return massRefusal(mass, body.confirm_deactivations, keepBack, changedLine);
    const rejected = e instanceof GatewayError ? ((e.details ?? {}) as { errors?: PeopleRowNote[] }).errors ?? [] : [];
    const backs = backLogins(rejected);
    if (backs.length && backs.length === rejected.length) {
      const inFile = new Set(parsed.body.people.map((p) => String(p?.login ?? "").trim().toLowerCase()));
      return reactivationRefusal([...new Set([...back.filter((l) => inFile.has(l)), ...backs])], false, keepMass, changedLine);
    }
    const self = e instanceof GatewayError ? custodianIsOperatorOf(e.details) : null;
    if (self) return failState(peopleActions.uploadRejectedYouWouldBecomeCustodianOf, { lines: [
      peopleActions.formerEmployees(self.join(", ")),
      peopleActions.aMemoryAdministratorCannotBecomeCustodianOf,
    ] });
    if (e instanceof GatewayError) return failState(peopleActions.gatewayRejectedTheUpload(e.message), { lines: rejectedLines(parsed, e.details) });
    throw e;
  }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  const rowErrors = out.errors ?? [], rowWarnings = out.row_warnings ?? [];
  const lines = [
    peopleActions.formatRowsInUpload(parsed.format === "csv" ? "CSV" : "JSON", body.people.length),
    peopleActions.createdUpdatedDeactivated(out.created, out.updated, out.deactivated, body.deactivate_missing ? peopleActions.includingPeopleMissingFromTheUpload : "", out.renamed ? peopleActions.loginsChanged(out.renamed) : ""),
    accessLine(out.access),
    ...(out.keys_revoked ? [peopleActions.deactivatedPeopleSKeysRevoked(out.keys_revoked)] : []),
    ...orgOwnerLines(out.org_owner),
    ...(custodyUploadLine(out.custody) ? [custodyUploadLine(out.custody)!] : []),
    ...rowErrors.slice(0, 50).map((e) => peopleActions.error(rowNote(parsed, e))),
    ...(rowErrors.length > 50 ? [peopleActions.andMoreErrors(rowErrors.length - 50)] : []),
    ...rowWarnings.slice(0, 50).map((w) => peopleActions.warning(rowNote(parsed, w))),
    ...(rowWarnings.length > 50 ? [peopleActions.andMoreWarnings(rowWarnings.length - 50)] : []),
    ...(out.warnings ?? []).map((w) => peopleActions.warning(w)),
    ...parsed.warnings,
  ];
  const backs = backLogins(rowErrors);
  if (backs.length) return reactivationRefusal(backs, true, keepMass, [...changedLine, ...lines]);
  return rowErrors.length
    ? failState(peopleActions.uploadPartiallyAcceptedRowsWithErrors(rowErrors.length), { lines })
    : okState(peopleActions.orgTableUploaded, { lines });
}

export type DeactivationPreviewState = { ok: true; data: DeactivationPreview } | { ok: false; message: string };

export async function previewDeactivationAction(people: Array<Pick<PersonInput, "login" | "employee_id" | "active">>): Promise<DeactivationPreviewState> {
  await requireSession();
  const denied = await denyAuditor(); if (denied) return { ok: false, message: denied.message };
  if (!Array.isArray(people) || !people.length) return { ok: false, message: peopleActions.noPeopleInTheUpload };
  const rows = people.slice(0, 20_000).map((p) => ({
    login: String(p?.login ?? ""),
    ...(typeof p?.employee_id === "string" || typeof p?.employee_id === "number" ? { employee_id: String(p.employee_id) } : {}),
    ...(p?.active === false ? { active: false } : {}),
  }));
  try {
    return { ok: true, data: await gw<DeactivationPreview>("/api/v1/admin/people/deactivation-preview", { method: "POST", body: { people: rows }, timeoutMs: 60_000 }) };
  } catch (e) {
    if (e instanceof GatewayError) return { ok: false, message: e.message };
    return { ok: false, message: peopleActions.theGatewayDidNotRespond };
  }
}

export async function uploadOrgUnitsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const denied = await denyAuditor(); if (denied) return denied;
  const parsed = parseOrgUnitsUpload(String(formData.get("payload") ?? ""));
  if (!parsed.body) return failState(peopleActions.uploadNotSentTheJSONCouldNot, { lines: parsed.errors.slice(0, 30) });

  let out: OrgUnitsUpsertResponse;
  try {
    out = await gw<OrgUnitsUpsertResponse>("/api/v1/admin/org-units", { method: "PUT", body: parsed.body, timeoutMs: 300_000 });
  } catch (e) {
    if (e instanceof GatewayError) return failState(peopleActions.gatewayRejectedTheUpload(e.message));
    throw e;
  }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(peopleActions.orgUnitsUploaded, { lines: [
    peopleActions.updated(out.updated), accessLine(out.access), ...orgOwnerLines(out.org_owner),
    ...(out.warnings ?? []).map((w) => peopleActions.warning(w)),
  ] });
}
