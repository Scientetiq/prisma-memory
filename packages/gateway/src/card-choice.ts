// Choice of a person card by candidates, shared by the directory login, the identity provider login,
// the login check and the reconciliation of directory groups with spaces (space-groups.ts): one logic, one decision.

export interface CardRow { id: string; login: string; employee_id: string | null; active: boolean; demo: boolean; bound_elsewhere: boolean }
/** The link row of this objectGUID (person_identities system 'ad') in any state, with the card it leads to. */
export interface GuidLink extends CardRow { link_active: boolean; link_verified: boolean }
export interface CardMatch { guidLink: GuidLink | null; byEmployee: CardRow | null; byMail: CardRow | null }

/** How the card was found: guid is a confirmed link; guid_confirmed / guid_restored a preliminary (org table) or retired link confirmed by this login. */
export type MatchedBy = "guid" | "guid_confirmed" | "guid_restored" | "employee_id" | "mail" | "created";
/** Refusal 409: two cards; the card is linked to another objectGUID already; the card changed during login (a race, UNIQUE). */
export type ConflictReason = "two_cards" | "other_guid" | "race";
export type LinkResult =
  | { kind: "ok"; personId: string; login: string; created: boolean; renamedFrom: string | null; matchedBy: MatchedBy;
      /** A mail change marked the links to it of dismissed people: who, for the log after the commit. */
      detached?: ReadonlyArray<{ person: string; space: string | null }> }
  | { kind: "no_mail" } | { kind: "bad_guid" } | { kind: "conflict"; reason: ConflictReason; candidates: string[] }
  | { kind: "guid_unconfirmed"; personId: string; state: "unverified" | "inactive" } | { kind: "inactive"; personId: string } | { kind: "untrusted_mail" };
export type Refusal = Exclude<LinkResult, { kind: "ok" }>;
export type Choice = { kind: "card"; card: CardRow | null; matchedBy: MatchedBy };

export const candidatesOf = (m: CardMatch): string[] => [...new Set([m.guidLink?.id, m.byEmployee?.id, m.byMail?.id].filter((x): x is string => !!x))];

/**
 * Card choice by candidates is a pure function: the login, the login check and the group reconciliation decide alike.
 *  - A confirmed active objectGUID link: the card is found. An unverified one (preliminary, from the org table) or
 *    a retired one (the export removed it) is taken only if the same card also matched by personnel number or directory
 *    mail; else the refusal guid_unconfirmed: no foreign card by mail and no new one, since the GUID points to another card,
 *    and a retired link must not be switched on silently.
 *  - trust = false (the identity provider does not confirm the mail): mail and personnel number from the token link and confirm nothing.
 *  - A card chosen not by a confirmed link but already linked to another objectGUID (by a login or the org table) gets
 *    the refusal other_guid: the mail was given out again or the AD object was re-created, and the new object does not enter
 *    another person's card and its personal memory.
 */
export function chooseCard(m: CardMatch, trust: boolean): Choice | Refusal {
  const g = m.guidLink, same = (c: CardRow | null) => !!g && c?.id === g.id;
  let anchor: CardRow | null = null, matchedBy: MatchedBy = "created";
  if (g && g.link_active && g.link_verified) { anchor = g; matchedBy = "guid"; }
  else if (g) {
    if (!same(m.byEmployee) && !same(m.byMail)) return { kind: "guid_unconfirmed", personId: g.id, state: g.link_active ? "unverified" : "inactive" };
    if (!trust) return { kind: "untrusted_mail" };
    anchor = g; matchedBy = g.link_active ? "guid_confirmed" : "guid_restored";
  }
  if (!trust && !anchor) return { kind: "untrusted_mail" };
  const fallbacks = trust ? [m.byEmployee, m.byMail] : [];
  const ids = [...new Set([anchor, ...fallbacks].filter((c): c is CardRow => !!c).map((c) => c.id))];
  if (ids.length > 1) return { kind: "conflict", reason: "two_cards", candidates: ids };
  const card = anchor ?? m.byEmployee ?? m.byMail;
  if (!card) return { kind: "card", card: null, matchedBy: "created" };
  if (!anchor) matchedBy = m.byEmployee ? "employee_id" : "mail";
  if (!card.active || card.demo) return { kind: "inactive", personId: card.id };
  if (matchedBy !== "guid" && card.bound_elsewhere) return { kind: "conflict", reason: "other_guid", candidates: [card.id] };
  return { kind: "card", card, matchedBy };
}
