import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { EdgeExportStatus, RecordEdgeStatus } from "../../lib/edge-status";

export const EDGE_STATE_TEXT: Messages<typeof en.EDGE_STATE_TEXT> = {
  shown: "Снаружи: показывается",
  held: "Снаружи не показывается",
  close_confirmed: "Закрытие запрошено, ребро подтвердило",
  close_failed: "Снаружи не показывается: закрытие не удалось",
  not_shown: "Снаружи не показывается",
  revoked: "Снаружи больше не показывается",
};

export const EDGE_REASON_TEXT: Messages<typeof en.EDGE_REASON_TEXT> = {
  close_requested: "вы или владелец пространства попросили закрыть запись",
  hidden: "запись была скрыта",
  deleted: "запись удаляли в корзину",
  open_check: "проверка нашла в тексте то, что нельзя показывать",
  held: "файл не прошёл проверку перед показом",
  org_review: "кураторы «Общих знаний компании» придержали запись",
  audience_people: "запись видна только выбранным людям",
  restore_tomb: "память восстанавливали из резервной копии",
  manual: "администратор придержал запись",

  canary_trip: "на ребре в записи нашли маркер приманки",
};

export const EDGE_SHOW: Messages<typeof en.EDGE_SHOW> = {
  button: "Снова показывать снаружи",
  hint: "Запись снова пройдёт проверку перед показом снаружи — как новая. Появится там, только если проверку пройдёт.",
  confirm: "Снова показывать запись снаружи? Её увидят агенты коллег, подключённые извне, — те, кто и так видит её внутри.",
  done: "Готово: запись снова проходит проверку перед показом снаружи",
  nothing: "Снимать нечего: запись и так не придержана",
  failed: "Не получилось",
} as const;

export const KILL_REASON_TEXT: Messages<typeof en.KILL_REASON_TEXT> = {
  canary: "запись-приманка из закрытого или её маркер в записи найдены на ребре",
  reconcile_extra_twice: "сверка дважды подряд нашла снаружи лишнее",
  canary_pre_send: "запись-приманка попала в пакет на отправку",
  restore: "базу восстановили из копии — экспорт стоит, пока восстановление не проверено",
};

export const UNKILL_REASON_TEXT: Messages<typeof en.UNKILL_REASON_TEXT> = {
  not_killed: "автовыключения нет — снимать нечего",
  reconcile_none: "сверки ещё не было",
  reconcile_before_kill: "после автовыключения ещё не было сверки — она идёт сама, подождите до 15 минут",
  reconcile_stale: "последняя сверка была слишком давно — проверьте, работает ли служба сверки",
  reconcile_skipped: "последняя сверка пропущена",
  reconcile_error: "последняя сверка сорвалась",
  reconcile_extra: "сверка нашла на ребре лишнее",
  reconcile_revoke: "отзыв лишнего с ребра ещё не прошёл",
  canary_found: "на ребре нашли приманку — найденное уже отозвано; снять можно после следующего чистого поиска маркеров (он идёт сам вместе со сверкой). Находки ниже снимайте только после разбора и пересборки ребра",
  canary_unchecked: "приманки не проверялись после автовыключения",
  canary_stale: "приманки давно не проверялись",
  canary_scan_missing: "после автовыключения ещё не было поиска маркеров приманок на ребре",
  canary_none: "приманок нет вовсе — пересоздайте их",

  restore_auth_unchecked: "базу восстановили из копии, а вход извне после неё ещё не сверен: второй фактор, коды восстановления, сессии — регламент восстановления из копии, шаг 4",
  kill_changed: "пока вы смотрели, автовыключение сработало снова — обновите страницу",
};

export const CANARY_HOLD_RELEASE_CONFIRM: Messages<typeof en.CANARY_HOLD_RELEASE_CONFIRM> = {
  question: "Снять находку?",
  change: "Запись снова встанет в отправку и уйдёт на ребро, только если пройдёт проверку перед показом и проверку маркеров приманок. Снимайте после разбора и пересборки ребра.",
  verb: "Снять",
} as const;

export const CANARY_HOLDS_RELEASE_ALL_CONFIRM: Messages<typeof en.CANARY_HOLDS_RELEASE_ALL_CONFIRM> = {
  question: "Снять все находки приманок?",
  change: "Все придержанные записи снова встанут в отправку и уйдут на ребро, только если пройдут проверку перед показом и проверку маркеров. Делайте это после разбора и пересборки ребра.",
  verb: "Снять все",
  danger: true,
} as const;

export const SERVICE_TITLES: Messages<typeof en.SERVICE_TITLES> = { exporter: "Экспортёр", intake: "Приёмник журналов ребра", reconciler: "Сверщик" };

export const CANARY_TEXT: Messages<typeof en.CANARY_TEXT> = {
  ok: "Приманки снаружи не найдены",
  tripped: "Приманка найдена снаружи — экспорт выключен",
  unknown: "Приманки ещё не проверялись",
};

export const TEXT: Messages<typeof en.TEXT> = {
  thereIsAReasonAnAdministratorMustResolve: "есть причина, которую снимает администратор",
  reason: (p0: string | number): string => `Почему: ${p0}.`,
  theRecordRemainsOpenInternallyItWillStay: "Внутри запись осталась открытой. Снаружи её не будет, пока вы не решите показать её снова.",
  sendingRecordsOutsideIsCurrentlyOff: "Сейчас отправка записей наружу выключена.",
  s: (p0: string | number): string => `${p0} с`,
  min: (p0: string | number): string => `${p0} мин`,
  h: (p0: string | number): string => `${p0} ч`,
  d: (p0: string | number): string => `${p0} дн.`,
  thereIsAReasonRecordedInTheLog: "есть причина, которую видно в журнале",
  unkillHint: "Что разобрали и почему снова можно отправлять — попадёт в журнал аудита. Снимает администратор в личной сессии (вход через учётную запись компании), а в режиме advanced — после второй подписи. Снять можно только после чистой сверки и свежей проверки приманок.",
  automaticProtectionWasTriggered: "сработала автоматическая защита",
  shutDownAutomatically: "Выключен автоматически",
  on: "Включён",
  off: "Выключен",
  lastFreshnessMarkerSentToTheEdgeAgo: (p0: string | number): string => `Последняя отметка свежести ушла на ребро ${p0} назад`,
  noFreshnessMarkerHasBeenSentYetWaiting: "Отметка свежести ещё не отправлялась: ждёт первой сверки после выгрузки всех записей — до неё ребро агентам не отвечает",
  noFreshnessMarkerHasBeenSentToThe: "Отметка свежести на ребро ещё не отправлялась",
  awaitingRevocationAwaitingPublication: (p0: string | number, p1: string | number, p2: string | number): string => `Ждут отзыва: ${p0}${p1}; ждут публикации: ${p2}`,
  oldest: (p0: string | number): string => ` (самый старый — ${p0})`,
  exportOffConfirm: "Выключить экспорт на ребро? Ребро перестанет получать записи и вскоре перестанет отвечать агентам снаружи. Включение — снова через настройки, личной сессией администратора (в advanced — со второй подписью).",
  canariesConfirm: "Пересоздать записи-приманки? Прежние будут сняты, новые появятся в течение минуты.",
  reasonList: (reasons: readonly string[]): string => reasons.join("; "),
};
