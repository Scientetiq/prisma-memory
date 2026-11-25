// Preparation check of the settings restore of a built-in sign-in check session. The
// session changes settings for a time and restores them from its snapshot through operator recovery (`recover`,
// memory-admin-cli recover set) and the admin API (`put`, PUT /api/v1/admin/settings with the system key). Both paths run
// Settings.validate on every value before anything else (recoverSettings in recovery.ts; PUT /settings in admin.ts, through
// Settings.setMany). A value the installation saved under older rules that the running release no longer saves —
// agent_auth.dcr_limits {per_day: 50} without per_day_trusted is the known one — would be refused in the middle of the
// restore, and the stop rule then holds every later batch. So before the session every restore value goes through the CURRENT
// validators with the settings rows the installation has now — the body of GET /api/v1/admin/settings (values and seed
// defaults; secrets only set or not): any refusal and the session does not start until the value is migrated to a form the
// release saves, with the same effect, and a new snapshot is taken. The check writes nothing and needs no database or
// network.
//
// What it does not see (the price): the batch rules (section rules, assertBatch, the contour gate) — the restore brings
// back the state the gateway already runs with, and a refusal there still stops the session by the stop rule; the pins of
// signed anchors and the security-mode floor of the database (a test installation is basic without anchors; recovery refuses in
// advanced); whether the source of a hidden secret is readable — the operator confirms it.
//
// Run with the release's own code, inside the deployed gateway image (stdin — the body of GET /api/v1/admin/settings):
//   … | docker run --rm -i --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
//         --entrypoint node_modules/.bin/tsx memory-gateway:<deployed sha> packages/gateway/src/admin-plane/restore-check.ts \
//         [--hidden-ready oidc.client_secret] [--without-l5b]
// Exit 0 — every restore value would be saved; 1 — stop (the lines say why and how to migrate); 2 — bad input.
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { agentAuthConfig, Settings, SettingsTypeError, type Category } from "@memory/shared";
import { recoveryKeys } from "./recovery.ts";

export const LIVE_RESTORE_PLAN = {
  recover: ["agent_auth.mode", "agent_auth.clients", "agent_auth.cimd_hosts", "agent_auth.cimd_any_https", "agent_auth.dcr_enabled",
    "access.trusted_proxies", "oidc.issuer", "oidc.ca_cert", "oidc.claims", "oidc.private_networks", "oidc.client_secret"],
  put: ["agent_auth.dcr_limits", "agent_auth.dcr_trusted_egress", "access.cloud_agent_base_url", "access.public_base_url", "access.workplace_url",
    "oidc.enabled", "oidc.client_id", "oidc.redirect_uri", "oidc.scopes", "oidc.login_groups", "oidc.timeout_sec"],
  compare: ["oauth.enabled"],
  unchanged: ["agent_auth.connection_days", "agent_auth.idle_days"],
} as const;

export interface RestorePlan { recover: readonly string[]; put: readonly string[]; compare: readonly string[] }
export interface RestoreCheckOptions {
  /** Secret keys whose current value's source the operator has confirmed readable. */
  hiddenReady?: readonly string[];
  withoutL5b?: boolean;
  plan?: RestorePlan;
}
export interface RestoreCheckResult {
  /** Why the session must not start (empty — it may). */
  problems: string[];
  /** One line per key: ok, or the refusal. */
  lines: string[];
  /** Forms with the same effect the current release saves, for the refused values it can migrate itself. */
  migrations: Array<{ key: string; path: "put" | "recover"; value: unknown }>;
}

export class RestoreCheckInputError extends Error {}

interface Item { category: string; key: string; value: unknown; secret: boolean; required: boolean; isSet: boolean; defaultValue: unknown }

function itemsOf(body: unknown): Item[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) throw new RestoreCheckInputError("expected the body of GET /api/v1/admin/settings: {\"items\": [...]}");
  return items.map((it, n) => {
    const o = it as Record<string, unknown> | null;
    if (!o || typeof o.category !== "string" || typeof o.key !== "string") throw new RestoreCheckInputError(`items[${n}]: {category, key, value, …} expected`);
    return { category: o.category, key: o.key, value: o.value ?? null, secret: o.secret === true, required: o.required === true, isSet: o.isSet === true,
             defaultValue: o.defaultValue ?? null };
  });
}

/** The real Settings over the rows of the body: a stand-in pool answers its SELECT; secrets carry no value. */
async function settingsOf(items: readonly Item[]): Promise<Settings> {
  const rows = items.map((it) => ({ category: it.category, key: it.key, value: it.secret ? null : it.value, secret: it.secret, enc_kid: null, required: it.required,
                                    description: null, default_value: it.defaultValue }));
  const pool = {
    query: async (sql: string) => {
      if (/to_regprocedure/.test(sql)) return { rows: [{ ok: false }] };
      if (/FROM settings/.test(sql)) return { rows };
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const s = new Settings(pool, "restore-check", "restore-check: no secret is decrypted here");
  await s.load(true);
  return s;
}

/** The preparation check itself: every restore value of the plan through the current validators. Writes nothing. */
export async function restoreCheck(body: unknown, o: RestoreCheckOptions = {}): Promise<RestoreCheckResult> {
  const items = itemsOf(body);
  const byPath = new Map<string, Item>(items.map((it) => [`${it.category}.${it.key}`, it]));
  const settings = await settingsOf(items);
  const recovery = new Set(recoveryKeys());
  const plan = o.plan ?? LIVE_RESTORE_PLAN;
  const skip = (path: string) => o.withoutL5b === true && path.startsWith("oidc.");
  const out: RestoreCheckResult = { problems: [], lines: [], migrations: [] };
  const stop = (line: string) => { out.problems.push(line); out.lines.push(`STOP ${line}`); };
  const batches: Array<["recover" | "put", readonly string[]]> = [["recover", plan.recover], ["put", plan.put]];
  for (const [path, keys] of batches) {
    for (const key of keys) {
      if (skip(key)) { out.lines.push(`skip ${key} (${path}): --without-l5b — not changed in this session`); continue; }
      const it = byPath.get(key);
      if (!it) { stop(`${key} (${path}): no such setting in this installation — the plan does not fit this release`); continue; }
      // the path of its batch: one key outside recoveryKeys() refuses a whole recover batch (403 recovery_key_not_allowed);
      // put does not change a key of the group «always»
      if (path === "recover" && !recovery.has(key)) { stop(`${key} (recover): not a key of operator recovery in this release — every key of its batch would be refused (403 recovery_key_not_allowed)`); continue; }
      if (path === "put" && recovery.has(key)) { stop(`${key} (put): a key of operator recovery (group «always») in this release — put does not change it; the plan must restore it by recover`); continue; }
      if (it.secret) {
        if (!it.isSet) { out.lines.push(`ok ${key} (${path}): secret, not set`); continue; }
        if (!(o.hiddenReady ?? []).includes(key)) {
          stop(`${key} (${path}): the secret is set. To restore it, provide the source of the current value (--hidden ${key}:<source>) and confirm that the source is readable (--hidden-ready ${key}), or skip this restore step (--without-l5b)`);
          continue;
        }
        out.lines.push(`ok ${key} (${path}): secret, set; its source is confirmed`);
        continue;
      }
      try {
        if (!settings.validate(it.category as Category, it.key, it.value)) { stop(`${key} (${path}): no such setting in this installation`); continue; }
        out.lines.push(`ok ${key} (${path})`);
      } catch (e) {
        if (!(e instanceof SettingsTypeError)) throw e;
        stop(`${key} (${path}): the current release refuses the value as it is stored — ${e.message.slice(0, 400)}`);
        const migrated = migrationOf(settings, it);
        if (migrated !== undefined) out.migrations.push({ key, path, value: migrated });
      }
    }
  }
  for (const key of plan.compare) {
    if (byPath.has(key)) out.lines.push(`ok ${key} (compare only)`);
    else stop(`${key} (compare): no such setting in this installation — the plan does not fit this release`);
  }
  return out;
}

/**
 * A form with the same effect the current release saves, for the values it knows how to migrate: agent_auth.dcr_limits —
 * the limits the gateway reads now, every field written out (per_day_trusted explicit: the half of the stored day the
 * value reads without it). Offered only when it passes the same validation. Others — undefined (migrate by hand).
 */
function migrationOf(settings: Settings, it: Item): unknown {
  if (`${it.category}.${it.key}` !== "agent_auth.dcr_limits") return undefined;
  const effective = { ...agentAuthConfig(settings).dcr_limits };
  try {
    // the same per-value rule as the restore (Settings.validate runs the agent_auth rules: per_day_trusted below per_day, …)
    if (!settings.validate(it.category as Category, it.key, effective)) return undefined;
  } catch { return undefined; }
  return effective;
}

/** The command: stdin — the body of GET /api/v1/admin/settings; the report on stdout; exit 0, 1 (stop) or 2 (bad input). */
export async function runRestoreCheck(argv: readonly string[], stdin: string): Promise<{ code: number; out: string }> {
  const hiddenReady: string[] = [];
  let withoutL5b = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--hidden-ready" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) hiddenReady.push(argv[++i]!);
    else if (a === "--without-l5b") withoutL5b = true;
    else return { code: 2, out: `restore-check: unknown argument ${JSON.stringify(a).slice(0, 80)} (--hidden-ready <key>, --without-l5b)\n` };
  }
  let body: unknown;
  try { body = JSON.parse(stdin); } catch { return { code: 2, out: "restore-check: stdin is not JSON (the body of GET /api/v1/admin/settings)\n" }; }
  let r: RestoreCheckResult;
  try { r = await restoreCheck(body, { hiddenReady, withoutL5b }); } catch (e) {
    if (e instanceof RestoreCheckInputError) return { code: 2, out: `restore-check: ${e.message}\n` };
    throw e;
  }
  const lines = [...r.lines];
  for (const m of r.migrations) lines.push(`MIGRATE ${m.path} ${m.key}=${JSON.stringify(m.value)} — the same limits the gateway reads now; then check again and take a new snapshot`);
  lines.push(r.problems.length ? `restore-check: STOP — ${r.problems.length} value(s) the restore could not write; do not start the session` : "restore-check: ok — every restore value would be saved");
  return { code: r.problems.length ? 1 : 0, out: `${lines.join("\n")}\n` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk as string;
  const { code, out } = await runRestoreCheck(process.argv.slice(2), input);
  process.stdout.write(out);
  process.exitCode = code;
}
