// Rule packs of the open check. A pack is a gate over the names of the built-in rules: the setting
// `open_check.packs` lists the packs in force, and a built-in rule whose pack is not listed is not compiled at all.
//   core — secrets, keys (cloud providers' too), random-looking tokens, passwords, cards, phones, e-mail next to a name, contract numbers, amounts;
//          it cannot be removed;
//   ru   — Russian identifiers: passport, INN, SNILS;
//   intl — international personal data: bank accounts, national identity numbers, phones without "+", dates of birth.
// Every install starts with ["core","intl"] (the seed writes it).
// Fail closed: no row, or a damaged list (empty, without core, unknown names), switches every pack on — never fewer rules
// than the administrator chose. The API does not accept an unset value (null): the check and the weakening policy would
// read it differently. A value of another JSON type is replaced by the seed default, the general rule of Settings.get.
// Leaf module: no imports, so the panel's sync test can read it as text and every package can import it cheaply.

export const OPEN_CHECK_PACKS = ["core", "ru", "intl"] as const;
export type OpenCheckPack = (typeof OPEN_CHECK_PACKS)[number];

/** Seed value of a fresh install (`contracts/schema/04-seed.sql`; a unit test compares them). */
export const OPEN_CHECK_PACKS_DEFAULT: readonly OpenCheckPack[] = ["core", "intl"];

/** Pack of every built-in rule. A unit test keeps the keys equal to the names of the built-in rules. */
export const OPEN_CHECK_RULE_PACK: Readonly<Record<string, OpenCheckPack>> = Object.freeze({
  memory_key: "core", gitlab_token: "core", api_key_sk: "core", service_token: "core", private_key: "core", aws_key: "core",
  jwt: "core", bearer_token: "core", password: "core", token_assignment: "core",
  phone: "core", email_near_name: "core", card: "core", amount: "core", contract_number: "core",
  cloud_key: "core", high_entropy_secret: "core",
  passport: "ru", inn: "ru", snils: "ru",
  bank_account: "intl", national_id: "intl", phone_intl: "intl", date_of_birth: "intl",
});

const PACK_SET: ReadonlySet<string> = new Set(OPEN_CHECK_PACKS);

/** Pack of a rule; a rule nobody mapped belongs to `core`, so packs can never switch it off. */
export function packOfRule(name: string): OpenCheckPack {
  return Object.prototype.hasOwnProperty.call(OPEN_CHECK_RULE_PACK, name) ? OPEN_CHECK_RULE_PACK[name] : "core";
}

const shown = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).slice(0, 60);

/** Refusal of an unset value (null) of `open_check.packs` through the API: the list is always explicit (see the header). */
export const OPEN_CHECK_PACKS_UNSET = "the rule packs cannot be unset: list them, core included";

/** Problems of a value of `open_check.packs`; an empty list when it is valid. Messages echo at most three names of 60 characters. */
export function openCheckPacksProblems(value: unknown): string[] {
  const all = OPEN_CHECK_PACKS.join(", ");
  if (!Array.isArray(value)) return [`expected a list of rule packs: ${all}`];
  const unknown = value.filter((v) => typeof v !== "string" || !PACK_SET.has(v));
  if (unknown.length) return [`unknown rule packs: ${unknown.slice(0, 3).map(shown).join(", ")}${unknown.length > 3 ? ", …" : ""}; known: ${all}`];
  const out: string[] = [];
  if (new Set(value).size !== value.length) out.push("a rule pack is listed twice");
  if (!value.includes("core")) out.push("the pack core cannot be removed");
  return out;
}

/** Packs in force for a value. A valid list gives its packs; anything else (absent, null, empty, without core, unknown names) — all packs. */
export function activePacks(value: unknown): ReadonlySet<OpenCheckPack> {
  if (openCheckPacksProblems(value).length === 0) return new Set(value as OpenCheckPack[]);
  return new Set(OPEN_CHECK_PACKS);
}

/** Packs for the language chosen by the set-up wizard: Russian adds the pack ru. */
export function packsForLocale(locale: string): OpenCheckPack[] {
  return locale === "ru" ? ["core", "ru", "intl"] : ["core", "intl"];
}
