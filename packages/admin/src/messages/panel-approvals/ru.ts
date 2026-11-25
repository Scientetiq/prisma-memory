import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const DONE: Messages<typeof en.DONE> = {
    approve: "Заявка подписана: исполнить её может тот, кто её подал",
    reject: "Заявка отклонена",
    execute: "Заявка исполнена",
    cancel: "Заявка отменена",
};

export const STATE_FILTERS: Messages<typeof en.STATE_FILTERS> = [
    { value: "pending", title: "Ждут подписи" }, { value: "approved", title: "Подписаны, ждут исполнения" }, { value: "executed", title: "Исполнены" },
    { value: "rejected", title: "Отклонены" }, { value: "expired", title: "Истекли" }, { value: "cancelled", title: "Отменены" }, { value: "all", title: "Все" },
];

export const STATE_BADGES: Messages<typeof en.STATE_BADGES> = {
    pending: { title: "ждёт подписи", tone: "info" },
    approved: { title: "подписана — исполнит просивший", tone: "warn" },
    executed: { title: "исполнена", tone: "ok" },
    rejected: { title: "отклонена", tone: "danger" },
    expired: { title: "истекла", tone: "muted" },
    cancelled: { title: "отменена", tone: "muted" },
};

export const APPROVAL_ERRORS: Messages<typeof en.APPROVAL_ERRORS> = {
    approval_self: "Свою заявку подписать нельзя: нужен другой человек",
    approval_role: "Эту заявку подписывает другая роль",
    approval_state: "Заявка уже подписана, отклонена, отменена или исполнена — обновите страницу",
    approval_expired: "Срок заявки истёк — подайте действие заново",
    approval_mismatch: "Заявка не совпала с действием: исполнение отменено, подайте действие заново",
    approval_not_found: "Заявка не найдена",
    stepup_required: "Коснитесь ключа безопасности: подпись — только со свежим касанием (войдите заново с ключом)",
};

export const ACTIONS_TEXT: Messages<typeof en.ACTIONS_TEXT> = {
  noRequestID: "Нет номера заявки",
  keySecret: "Секрет ключа",
  sessionToken: "Токен сессии",
  actionReturnedValue1: (value1: string | number): string => `Действие ответило: ${value1}`,
  shownOnceCopyItNowNobodyCanViewIt: "Показывается один раз: скопируйте сейчас, потом его не увидит никто",
  responseValue1: (value1: string | number): string => `ответ ${value1}`,
  requestedActionFailedValue1: (value1: string | number): string => `Действие по заявке не выполнено: ${value1}`,
  requestClosedSubmitTheActionAgainIfNeeded: "Заявка закрыта — при необходимости подайте действие заново",
  notCompletedResponseValue1: (value1: string | number): string => `Не выполнено: ответ ${value1}`,
};

export const PAGE_TEXT: Messages<typeof en.PAGE_TEXT> = {
  lead: "В режиме безопасности advanced действия, которые расширяют доступ, исполняются только после подписи другого человека — администратора или аудитора ИБ; подписанную заявку исполняет тот, кто её подал, срок подписи — admin.second_signature_ttl_hours (24 часа). В режиме basic заявок нет: действия исполняются сразу, а в журнале отмечается, что в advanced понадобилась бы подпись.",
  secondSignatures: "Вторые подписи",
  request: "Заявка",
  actionAdminAPIRoute: "Действие (маршрут админ-API)",
  tag1Value2Tag1Tag3NoValue4Tag3: "<tag1>{value2}</tag1> · <tag3>№ {value4}</tag3>",
  status: "Состояние",
  rejectedBy: "отклонил",
  signedBy: "подписал",
  executedValue1: "исполнена {value1}",
  requestedBy: "Подал",
  expiry: "Срок",
  actions: "Действия",
  sign: "Подписать",
  signThisRequest: "Подписать заявку?",
  value1SigningAllowsTheRequesterToExecuteTheAction: (value1: string | number): string => `${value1}. Подпись разрешает подавшему исполнить действие.`,
  sign2: "Подписать",
  reject: "Отклонить",
  execute: "Исполнить",
  executeTheSignedRequest: "Исполнить подписанную заявку?",
  execute2: "Исполнить",
  cancel: "Отменить",
  request2: "Заявка",
  status2: "Состояние",
  requestedBy2: "Подал",
  signBy: "Подписать до",
  actions2: "Действия",
  secondSignatures2: "Вторые подписи",
  linkedRequest: "Заявка по ссылке",
  request3: "заявку",
  requestsByStatus: "Заявки по состоянию",
  requests: "Заявки",
  requests2: "заявки",
  noRequests: "Заявок нет.",
};
