import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const CHECK_LINKS: Messages<typeof en.CHECK_LINKS> = {settings: {label: "Настройки"}, origin_allowlist: {label: "Настройки"}, t1_gate: {label: "Настройки"}, platform: {label: "Настройки"}, models: {label: "Настройки"}, embedder: {label: "Настройки"}, storage: {label: "Настройки"}, test_hooks: {label: "Настройки"}, ldap: {label: "Вход и LDAP"}, oidc: {label: "Единый вход"}, smtp: {label: "Почта"}, oauth: {label: "Настройки"}, group_sync: {label: "привязки групп в отчёте"}, open_check: {label: "Проверка открытого"}, llm: {label: "Обработка"}, converter: {label: "Обработка"}, edge_export: {label: "Экспорт на ребро"}, class_consistency: {label: "переносы класса"}, external_channel: {label: "Настройки"}, alert_channel: {label: "Оповещения"}};

export const CHECK_EFFECTS: Messages<typeof en.CHECK_EFFECTS> = {
    platform: "стадии обработки, которым нужна модель, ждут повтора",
    models: "стадии обработки, которым нужна модель, ждут подключения или допуска",
    embedder: "новые записи не готовятся к поиску по смыслу",
    storage: "оригиналы файлов не сохраняются и не выдаются",
    llm: "обращения к модели приостановлены или ждут очереди",
    converter: "документы PDF ждут перевода в текст",
    edge_export: "экспорт на ребро выключился сам: ребро не получает записей",
    ldap: "вход учётной записью компании не работает",
    oidc: "вход через провайдера единого входа не работает",
    smtp: "письма не уходят",
    group_sync: "участие в пространствах по группам каталога не обновляется",
    test_hooks: "включены тестовые хуки приёмки",
    open_check: "запись в открытый класс не проверяется",
    class_consistency: "есть остатки незавершённых переносов класса",
    origin_allowlist: "защита от подмены адреса браузером ослаблена",
    t1_gate: "часть моделей вызвать нельзя",
};

export const text: Messages<typeof en.text> = {
  off: "выключено",
  offDetail: (detail: string): string => `выключено: ${detail}`,
  versionUnknown: "версия не определена",
  version: (value: string): string => `версия ${value}`,
  banner: (parts: readonly string[]): string => {
    if (!parts.length) return "Часть проверок не пройдена — подробности на Обзоре.";
    const text = parts.join("; ");
    return `${text[0]!.toUpperCase()}${text.slice(1)}. Остальное работает.`;
  },
};
