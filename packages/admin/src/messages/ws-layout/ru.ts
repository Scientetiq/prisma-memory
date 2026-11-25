import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const layoutText: Messages<typeof en.layoutText> = {
  manager: "руководитель",
  employee: "сотрудник",
  leavePreview: "Выйти из предпросмотра",
  workspace: "Рабочее место",
  yourAgentConnectionExpiresSoonCheck: "<tag0>Подключение агента скоро истекает.</tag0> Проверьте срок и порядок повторного входа в разделе <tag1>«Подключить агента»</tag1>. ",
  yourAgentKeyExpiresSoon: "Ключ агента скоро истекает",
  yourAgentKeysExpireSoon: (value0: string | number | null | undefined): string => `Ключи агентов скоро истекают (${value0})`,
  validThrough: "{value0}«{value1}» — до <tag0/>",
  connectionsCannotBeExtendedReconnectYour: "Продления нет: подключите агента заново через учётную запись компании, без ключа, — <tag0>«Подключить агента»</tag0>. Или выпустите новый ключ в разделе <tag1>«Ключи и агенты»</tag1> и замените его у агента.",
  keysCannotBeExtendedIssueA: "Продления нет: выпустите новый в разделе <tag0>«Ключи и агенты»</tag0> и замените его у агента.",
  preview: "предпросмотр",
  workspace2: "рабочее место",
  signOutOfTheWorkspace: "Выйти из рабочего места",
  ifThisContinuesContactTheAdministrator: "<tag0>{value0}</tag0> Если не проходит — обратитесь к администратору. <tag1/><tag2/>",
};
