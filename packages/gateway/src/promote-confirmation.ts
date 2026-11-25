// A person confirms what an agent asks to share. With access.promote_confirmation = human (the default; "off" keeps
// the former behaviour) an agent's move of a record to a team, a project or the whole company does not move anything: it
// becomes a one-item plan that only a person applies in the workplace (plans.ts confirmationPlan). With
// access.agent_member_add = workplace an agent's key does not add a member to a space either. A person in the workplace is
// never gated. Any stored value except the exact "off" / "allow" — no row, NULL, a typo, another JSON type — gates (fail closed).
// The module reads settings and builds answers only; it imports neither owner.ts nor plans.ts (both import it).
import { MemoryError } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { isHumanSession, workplaceUrl } from "./workplace.ts";

/** The confirmation of an agent's move is on (anything but the exact "off"). */
export const promoteConfirmationOn = (app: App): boolean =>
  app.settings.get<string>("access.promote_confirmation", "human") !== "off";

/** This caller's widening move must wait for a person: the confirmation is on and the caller is not a person in the workplace. */
export const needsConfirmation = (app: App, caller: Pick<Caller, "keyKind" | "principalType" | "person" | "onBehalfOf" | "preview">): boolean =>
  promoteConfirmationOn(app) && !isHumanSession(caller);

/** An agent's call adding a space member is refused (anything but the exact "allow"; a person in the workplace — never). */
export const agentMemberAddGated = (app: App, caller: Pick<Caller, "keyKind" | "principalType" | "person" | "onBehalfOf" | "preview">): boolean =>
  app.settings.get<string>("access.agent_member_add", "workplace") !== "allow" && !isHumanSession(caller);

/** Who may own a confirmation request: a person's own key — not a service, not "on behalf of", not a panel preview. */
export const canOwnConfirmation = (caller: Pick<Caller, "principalType" | "person" | "onBehalfOf" | "preview">): boolean =>
  caller.principalType === "person" && !!caller.person && !caller.onBehalfOf && !caller.preview;

/** Where the person does it: the workplace link when the workplace address is set, otherwise the name of the section. */
const where = (app: App, path: string, section: string): { url: string | null; text: string } => {
  const url = workplaceUrl(app, path);
  return { url, text: url ?? `the workplace, section "${section}"` };
};

/**
 * Refusal for a caller that cannot own a request (a service on behalf of a person, a preview key, a space owner who does
 * not read the record) and for an agent adding a space member: only a person in the workplace does it. Given only after
 * the caller's rights are proven, so it reveals nothing the former answer did not.
 */
export function humanConfirmationRequired(app: App, path: string, section: string): MemoryError {
  const w = where(app, path, section);
  return new MemoryError("forbidden", `Only a person in the workplace can do this: ${w.text}. Nothing has been changed.`,
    { hint: "Give the person this link; do not open it yourself.", details: { reason: "human_confirmation_required", workplace_url: w.url } });
}

/** The refusal above (the plan item of a key is then skipped as no_rights, the trace is control_denied). */
export const isConfirmationDenial = (e: unknown): boolean =>
  e instanceof MemoryError && e.code === "forbidden" && (e.extra.details as { reason?: unknown } | undefined)?.reason === "human_confirmation_required";

/** Facts of a created (or still pending) request: the record, its plan and when the plan expires (ISO). */
export interface ConfirmationFacts { id: string; planId: string; expiresAt: string }

/**
 * The target answer: a result, not an error — `{id, status: "confirmation_required",
 * plan_id, workplace_url, expires_at}` and a text for the agent. The field names live only here; switching to it means
 * owner.ts calls this function instead of confirmationAnswer.
 */
export function confirmationResult(app: App, f: ConfirmationFacts) {
  const w = where(app, `/plans/${f.planId}`, "Bulk changes");
  const result = { id: f.id, status: "confirmation_required" as const, plan_id: f.planId, workplace_url: w.url, expires_at: f.expiresAt };
  return { result, text: `This move needs a person's confirmation in the workplace: ${w.text}. Nothing has been moved yet. Pass the link to the person, do not open it yourself; the request is valid until ${f.expiresAt}.` };
}

/**
 * The interim answer, valid under the present contract: a `forbidden` refusal of the shape memory_apply already uses for a
 * workplace-only plan, `details: {reason: "confirmation_required", plan_id, workplace_url, expires_at}`. Error results are
 * not bound by the tool's outputSchema. Always throws.
 */
export function confirmationAnswer(app: App, f: ConfirmationFacts): never {
  const w = where(app, `/plans/${f.planId}`, "Bulk changes");
  throw new MemoryError("forbidden", "This move needs a person's confirmation in the workplace. Nothing has been moved.", {
    hint: `A person confirms this move in the workplace: ${w.text}. Pass the link to the person, do not open it yourself; the request is valid until ${f.expiresAt}.`,
    details: { reason: "confirmation_required", plan_id: f.planId, workplace_url: w.url, expires_at: f.expiresAt },
  });
}
