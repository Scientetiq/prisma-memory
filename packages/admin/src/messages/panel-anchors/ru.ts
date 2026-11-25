import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const KIND_TITLES: Messages<typeof en.KIND_TITLES> = { inner: "Внутренние (администраторы, настройки)", edge: "Внешний контур (ребро и мост)" };

export const DRAFT_ERRORS: Messages<typeof en.DRAFT_ERRORS> = {
    stepup: "Черновик выдаётся только со свежим касанием ключа безопасности: войдите заново с ключом и повторите.",
    role: "Черновик собирает администратор памяти — у аудитора ИБ только просмотр.",
    failed: "Черновик не собран: шлюз не ответил. Повторите позже.",
  roles_not_split: "Черновик не собран: пол режима advanced в этом выпуске закрыт (roles_not_split) — система ещё не умеет проверить, что у каждой службы свой пароль к базе. Соберите документ без пола: memory-admin-cli anchors draft --floor basic.",
};

export const PAGE_TEXT: Messages<typeof en.PAGE_TEXT> = {
  lead: "Якоря — подписанный двумя из трёх подписантов файл: сети и учётные записи администраторов, их ключи безопасности, закреплённые значения важных настроек. Пока якоря в силе, эти настройки в панели не меняются — только новым подписанным файлом. Нет файла подписантов на ВМ — якоря не в силе, настройки берутся из базы.",
  trustAnchors: "Якоря доверия",
  trustAnchors2: "Якоря доверия",
  anchorStatus: "состояние якорей",
  status: "Состояние",
  theSettingsPolicyFileDoesNotMatchTheSigned: "Файл политики настроек не совпал с подписанным: изменение настроек закрыто, пока якоря не переподпишут.",
  theSettingsPolicyFileMatchesTheSignedFile: "Файл политики настроек совпадает с подписанным.",
  tag1AnchorsAreInForceTag1Value2: "<tag1>Якоря в силе.</tag1>  {value2}",
  inactiveAnchors: "<tag1>Якоря не в силе</tag1> — настройки берутся из базы (наследие). Включаются, когда root кладёт на ВМ файл подписантов и подписанный документ.",
  unpinnedSettings: "Не закреплены или не совпали с базой — такие настройки считаются незаданными, пока их не закрепят новым файлом якорей:",
  appliedDocuments: "Применённые документы",
  noAnchorsHaveBeenAppliedYet: "Якоря ещё не применялись.",
  document: "Документ",
  serial: "Номер",
  applied: "Применён",
  signers: "Подписанты",
  document2: "Документ",
  serial2: "Номер",
  applied2: "Применён",
  signers2: "Подписанты",
  signerKeyFingerprint: "Отпечаток ключа подписанта",
  tag1Value2Tag1: "<tag1>{value2}</tag1>",
  newDocumentForSigning: "Новый документ для подписи",
  theDraftUsesTheCurrentStatePinnedAnchorSettings: "Черновик собирается из текущего состояния: закрепления всех якорных настроек (у секретов — только отпечаток HMAC, значения нет), учётные записи администраторов, их ключи безопасности, сети панели. Номер — следующий после применённого. Подписывают офлайн двое из трёх подписантов: каждый выполняет ssh-keygen -Y sign -f КЛЮЧ -n memory-anchors-inner trust-anchors-inner.json (КЛЮЧ — его ключ ed25519) и переименовывает полученный trust-anchors-inner.json.sig в trust-anchors-inner.json.sig.N (N у каждого подписанта своё); проверка до установки — memory-admin-cli anchors verify.",
  aMemoryAdministratorPreparesTheDraft: "Черновик собирает администратор памяти.",
  downloadTrustAnchorsInnerJsonDraft: "Скачать черновик trust-anchors-inner.json",
};
