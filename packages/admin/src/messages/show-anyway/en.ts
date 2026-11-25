import { pluralEn } from "../../i18n/core";
export const text = {
  findingWhere: (record: number, extracted: number): string => [record ? `in the record itself: ${record}` : "", extracted ? `in records extracted from it: ${extracted}` : ""].filter(Boolean).join(" · "),
  neverReasons: (findings: readonly { kind: string; reason: string }[]): string => [...new Set(findings.map(n => n.kind === "never_open" ? text.neverOpenRule(n.reason) : n.reason))].join(", ") || text.informationThatCannotBeShownTo,

  finding: (reason: string, count: number, more: boolean): string => `${reason} — in ${count} ${more ? "or more places" : pluralEn(count, "place", "places")}`,
  audience: (names: readonly string[], other: number, people: number, total: number): string => {
    let who = names.length ? `members of the ${pluralEn(names.length, "space", "spaces")} ${names.map(n => `“${n}”`).join(", ")}` : "";
    if (other > 0) who += `${who ? " and" : "members of"} ${other} ${pluralEn(other, "other space", "other spaces")}`;
    if (people > 0) who = `${who || "you"} and ${people} other ${pluralEn(people, "person", "people")} with separate access`;
    const later = names.length + other > 0 ? ", and anyone who joins these spaces later." : "";
    return `Everyone who can see the record and their AI agents: ${who || "you"} — currently ${total} ${pluralEn(total, "person", "people")}${later}`;
  },

  neverOpenRule: (value0: string | number | null | undefined): string => `“Never open” rule: ${value0}`,
  informationThatCannotBeShownTo: "information that cannot be shown to agents",
  changed: "changed",
  audienceChanged: "audience changed",
  noPermission: "no permission",
  disabled: "disabled",
  newFinding: "new finding",
  neverOpen: "“never open”",
  other: "other",
  onlyYou: "“only you”",
  personalAlsoVisibleToOthers: "personal, also visible to others",
  teams: "teams",
  projects: "projects",
};
