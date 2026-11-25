import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const auditText: Messages<typeof en.auditText> = {
  workspace: "рабочее место",
  adminPanel: "панель администратора",
  yes: "да",
  no: "нет",
  theMemoryAdministratorBecameTheCustodian: (value1: string | number): string => `${value1} — хранителем стал сам администратор памяти`,
  overS: (value1: string | number): string => `за ${value1} с`,
  overMin: (value1: string | number): string => `за ${value1} мин`,
  overH: (value1: string | number): string => `за ${value1} ч`,
};

export const AUDIT_TIER_TITLES: Messages<typeof en.AUDIT_TIER_TITLES> = { T0: "ключ сервиса", T1: "доверенный внешний", T2: "личный ключ" };

export const DETAIL_LABELS: Messages<typeof en.DETAIL_LABELS> = {
  tool: "инструмент", reason: "причина", result: "итог", method: "запрос", session: "сессия рабочего места", session_id: "сессия",
  limit: "сколько просили", excluded: "исключено", rerank: "реранкер", rerank_failed: "реранкер не сработал", archive: "архив",
  search_id: "поиск", rank: "место в выдаче", request_id: "просьба", author: "автор", source: "откуда", server: "сервер каталога",
  matched_by: "узнан по", keys: "настройки", ok: "успешно", failed: "не прошли", failed_steps: "шаги с ошибкой", via: "как",
  to: "кому", code: "код", stage: "этап", login: "логин", person: "человек", records: "записей", affected: "затронуто",
  batch: "пакет", action: "действие", filter: "фильтр", reset: "сброшено", waiting: "ждущих модель", kicked: "в очередь",
  queued: "в очереди", mail_id: "письмо", host: "сервер", port: "порт", security: "шифрование", latency_ms: "время ответа, мс",
  closed: "закрыто", record_id: "запись", move_id: "перенос", new_move_id: "новый перенос", reason_code: "причина просьбы",
  by_operator: "хранитель — администратор памяти", manager_login: "руководитель по орг-таблице", renamed: "почту получил",
};

/** Reasons for ending custody, changing custodians and returning meetings. */
export const OP_REASON_TITLES: Messages<typeof en.OP_REASON_TITLES> = {
  custody_end: { reactivated: "сотрудник вернулся", deleted: "личное удалено по сроку", policy: "по настройке", orphan: "по настройке" },

  // A corrected department head is distinct from a policy recalculation.
  custody_change: { correction: "руководитель исправлен в орг-таблице", custodian_dismissed: "прежний хранитель уволен" },
  organizer_return: { reactivated: "он вернулся в компанию", wait: "так настроил администратор" },
};
