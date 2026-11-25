import { formatCount } from "../../i18n/format";
import { pluralRu } from "../../i18n/core";
// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const VISIBILITY_TEXT: Messages<typeof en.VISIBILITY_TEXT> = {
 people: (n: number): string => `${formatCount(n)} ${pluralRu(n, ["человек", "человека", "человек"])}`,
 moreNames: (list: string, more: number): string => list + (more ? ` и ещё ${formatCount(more)}` : ""),
 company: "все сотрудники компании",
 you: "вы",
 personalOther: (placement: boolean): string => placement ? "ещё один сотрудник в своём личном пространстве" : "автор в своём личном пространстве",
 project: (name: string, n: string): string => `участники проекта «${name}»${n}`,
 hiddenProject: (placement: boolean, n: string): string => placement ? `участники ещё одного проекта${n}` : `участники проекта, который вам не виден${n}`,
 space: (name: string, n: string): string => `участники «${name}»${n}`,
 hiddenSpace: (placement: boolean, n: string): string => placement ? `участники ещё одного пространства${n}` : `участники пространства, которое вам не видно${n}`,
 extraPeople: (meeting: boolean, names: string): string => `${meeting ? "участники встречи" : "люди из списка записи"}: ${names}`,
 whyOwner: "Вы автор: свою запись вы открываете всегда, даже если не участвуете в пространстве, где она лежит.",
 whyListed: (meeting: boolean): string => `Вы ${meeting ? "участник встречи" : "в списке людей записи"}: поэтому видите её, даже если не участвуете в пространстве, где она лежит.`,
 owner: (name: string, meeting: boolean): string => `${name} (${meeting ? "организатор" : "автор"})`,
 author: (name: string): string => `${name} (автор)`,
 groups: (list: string, extra: string): string => extra ? `${list}, а также ${extra}` : list,
 onlyYou: "Только вы",
 meetingPeople: (iAmOwner: boolean, rest: string): string => `Вы и ${iAmOwner ? "" : "другие "}участники встречи: ${rest}`,
 meetingOwner: (name: string, rest: string): string => rest ? `Вы, организатор ${name} и другие участники встречи: ${rest}` : `Вы и организатор встречи ${name}`,
 listed: (list: string, more: number): string => `Вы и ${list}${more ? ` и ещё ${formatCount(more)}` : ""}`,
 withAgents: (who: string, agents: string, alone: boolean, iAmOwner: boolean, extended: boolean): string => `${who}${agents === "readers" ? (alone ? " и ваши ИИ-агенты" : " и их ИИ-агенты") : agents === "held" ? (iAmOwner ? " (пока запись оспорена, из ИИ-агентов её открывают только ваши)" : " (ИИ-агентам не выдаётся, пока запись оспорена)") : extended ? " (из ИИ-агентов — только ваш агент с расширенным доступом)" : " (без ИИ-агентов)"}`,
 meetingDetail: "Встречу, её резюме и решения видят организатор и участники встречи; состав меняет организатор.",
 peopleDetail: "Запись видят только автор и люди из её списка: участники пространства, где она лежит, её не видят.",
 personalDetail: (iAmOwner: boolean): string => iAmOwner ? "Запись лежит в вашем личном пространстве: коллеги её не видят. Если вы уйдёте из компании, её сможет прочитать ваш руководитель — сам, в рабочем месте, без агентов." : "Запись лежит в личном пространстве автора: коллеги её не видят. Если автор уйдёт из компании, её сможет прочитать его руководитель.",
 pending: (n: number): string => `Ещё ${formatCount(n)} ${pluralRu(n, ["участник", "участника", "участников"])} встречи ${n === 1 ? "получит доступ, когда впервые войдёт" : "получат доступ, когда впервые войдут"} в память.`,
 placementsDetail: "Этот же файл загружен в пространства, которых вы не видите: их участники тоже видят запись.",
 heldDetail: (iAmOwner: boolean): string => iAmOwner ? "Запись отмечена в «Общих знаниях компании» как неверная или не для всех: пока решает куратор, ИИ-агенты коллег её не получают. Ваши ИИ-агенты открывают её по ссылке, но в поиске и списках не находят." : "Запись отмечена в «Общих знаниях компании» как неверная или не для всех: ИИ-агентам она не выдаётся, пока решает куратор.",
 extendedDetail: "Ваш ИИ-агент с расширенным доступом читает и ваши закрытые записи — его выдаёт администратор памяти.",
};
