// The person's default for new records in the personal space. The instance default
// access.personal_upload_default stays closed; with access.personal_upload_default_choice on, a person may choose open on
// "What my agent sees" (people.upload_default). The choice applies only to a human workspace session writing to its own
// personal space of closed default class: such a record takes the existing "personal open" path (open only after the open
// check; a finding keeps it closed with the mark; a PDF is checked by the worker after conversion). Agents, scripts,
// services on behalf of a person, preview sessions and the external channel never widen their own view through it.
// The person's row is read lazily, only in that one case: the request's person row (auth.ts) does not carry the column, so
// a database without 17 [LG] (test sandboxes 01, 05) keeps working. This module must not import write.ts.
import { isUploadDefault, openCheckSettings, type UploadDefault } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import type { SpaceAccess } from "./access.ts";
import { isHumanSession } from "./workplace.ts";
import { isExternal } from "./channel.ts";

/** The instance default and whether people may choose their own (settings, read with the seed's fallbacks). */
export function uploadDefaultPolicy(app: Pick<App, "settings">): { instance: UploadDefault; choice: boolean } {
  const instance = app.settings.get<string>("access.personal_upload_default", "closed");
  const choice = app.settings.get<boolean>("access.personal_upload_default_choice", true);
  return { instance: instance === "open" ? "open" : "closed", choice: choice === true };
}

/**
 * The stored choice of a person; null — none (the instance default), no such person, or a database without the column
 * (to_jsonb of the row: the statement does not name the column, so it never fails on an older schema).
 */
export async function personUploadDefault(app: Pick<App, "db" | "instanceId">, personId: string): Promise<UploadDefault | null> {
  const row = (await app.db.control.query("SELECT to_jsonb(p) ->> 'upload_default' AS v FROM people p WHERE p.id = $1 AND p.instance_id = $2", [personId, app.instanceId])).rows[0];
  return isUploadDefault(row?.v) ? row.v : null;
}

/**
 * value — what a new record in the personal space gets now; personal — the stored choice; open_check_enabled — false when the
 * administrator switched the open check off: then nothing takes the "personal open" path and value is closed whatever is
 * stored (the screen says why instead of promising "visible to agents").
 */
export interface EffectiveUploadDefault { value: UploadDefault; personal: UploadDefault | null; instance_default: UploadDefault; choice_allowed: boolean; open_check_enabled: boolean }

/**
 * The one rule of what applies (the answer of the routes and the upload path must never differ): closed while the open
 * check is off; otherwise the person's choice when people may choose, else the instance default (a stored choice is
 * ignored, not erased).
 */
function applied(policy: { instance: UploadDefault; choice: boolean }, checkOn: boolean, personal: UploadDefault | null): UploadDefault {
  if (!checkOn) return "closed";
  return policy.choice && personal ? personal : policy.instance;
}

/** What applies to the person now, with the stored choice and the reasons it may not apply. */
export async function effectiveUploadDefault(app: Pick<App, "db" | "instanceId" | "settings">, personId: string): Promise<EffectiveUploadDefault> {
  const policy = uploadDefaultPolicy(app);
  const checkOn = openCheckSettings(app.settings).enabled;
  const personal = await personUploadDefault(app, personId);
  return { value: applied(policy, checkOn, personal), personal, instance_default: policy.instance, choice_allowed: policy.choice, open_check_enabled: checkOn };
}

/**
 * Whether this write takes the "personal open" path because of the default: a human workspace session (not a key, not on
 * behalf, not a preview), not the external channel, its own personal space of closed default class, the open check on, and
 * the effective default open. Cheap guards first; the person's row is read only when all of them hold.
 */
export async function humanOpenDefault(app: Pick<App, "db" | "instanceId" | "settings">, caller: Caller, space: Pick<SpaceAccess, "kind" | "owner_id" | "default_class">): Promise<boolean> {
  if (!isHumanSession(caller) || isExternal(caller) || space.kind !== "personal" || space.owner_id !== caller.person!.id || space.default_class !== "closed") return false;
  if (!openCheckSettings(app.settings).enabled) return false;
  const policy = uploadDefaultPolicy(app);
  return applied(policy, true, policy.choice ? await personUploadDefault(app, caller.person!.id) : null) === "open";
}
