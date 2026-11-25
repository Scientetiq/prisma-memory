import { pluralRu } from "../../i18n/core";
import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  findingWhere: (record: number, extracted: number): string => [record ? `в самой записи: ${record}` : "", extracted ? `в извлечённых из неё записях: ${extracted}` : ""].filter(Boolean).join(" · "),
  neverReasons: (findings: readonly { kind: string; reason: string }[]): string => [...new Set(findings.map(n => n.kind === "never_open" ? text.neverOpenRule(n.reason) : n.reason))].join(", ") || text.informationThatCannotBeShownTo,

  finding: (reason: string, count: number, more: boolean): string => `${reason} — в ${more ? `${count} и больше местах` : `${count} ${pluralRu(count, ["месте", "местах", "местах"])}`}`,
  audience: (names: readonly string[], other: number, people: number, total: number): string => {
    let who = names.length ? `участники пространства ${names.map(n => `«${n}»`).join(", ")}` : "";
    if (other > 0) who += `${who ? " и ещё" : "участники"} ${other} ${pluralRu(other, ["пространства", "пространств", "пространств"])}`;
    if (people > 0) who += `${who ? "" : "вы"} и ещё ${people} чел. по отдельному доступу`;
    const later = names.length + other > 0 ? ", а также те, кто войдёт в эти пространства позже." : "";
    return `Все, кто видит запись, и их ИИ-агенты: ${who || "вы"} — сейчас ${total} чел.${later}`;
  },

  neverOpenRule: (value0: string | number | null | undefined): string => `правило «никогда не открывать»: ${value0}`,
  informationThatCannotBeShownTo: "то, что агентам не показывают",
  changed: "изменилась",
  audienceChanged: "изменился круг",
  noPermission: "нет права",
  disabled: "выключено",
  newFinding: "новая находка",
  neverOpen: "«никогда не открывать»",
  other: "прочее",
  onlyYou: "«только вы»",
  personalAlsoVisibleToOthers: "личное, видят и другие",
  teams: "команды",
  projects: "проекты",
};
