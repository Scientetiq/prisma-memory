import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const ROLE_TITLES: Messages<typeof en.ROLE_TITLES> = { memory_admin: "администратор памяти", security_auditor: "аудитор ИБ" };

export const METHOD_TITLES: Messages<typeof en.METHOD_TITLES> = {
    sso_webauthn: "единый вход и ключ", sso: "единый вход", sso_breakglass: "единый вход, аварийный доступ", local: "admin@local", local_breakglass: "admin@local, аварийный доступ",
    tool: "сессия инструмента",
};

export const TEXT: Messages<typeof en.TEXT> = {
  since: "с {date}",
  administrators: "Администраторы",
  neverSignedIn: "не входил",
  lastSignIn: "Последний вход",
  login: "Логин",
  lastSignIn2: "Последний вход",
  login2: "Логин",
  noLocalAccounts: "Локальных учётных записей нет.",
  adminLocalSignsInWithAPassword: "admin@local — вход по паролю. В режиме advanced открыт только в окне аварийного доступа.",
  localAccounts: "Локальные учётные записи",
  neverSignedIn2: "не входил",
  lastSignIn3: "Последний вход",
  noKeys: "нет ключей",
  boundToADevice: "привязаны к устройству: {value1}",
  keys: "Ключи",
  role: "Роль",
  person: "Человек",
  lastSignIn4: "Последний вход",
  keys2: "Ключи",
  role2: "Роль",
  person2: "Человек",
  noRoleAssignmentsThePanelIsAccessed: "Назначений нет: в панель входят через admin@local.",
  assignOrRemoveARoleInRoles: "Назначить или снять роль — в <link1>«Ролях»</link1>; ключи — в <link2>«Ключах WebAuthn»</link2>.",
  byRoleAssignment: "По назначениям ролей",
  listOfAdministrators: "список администраторов",
  currentMemoryAdministratorsAndSecurityAuditorsTheir: "Кто сейчас администратор памяти и аудитор ИБ, сколько у них ключей безопасности и когда входили. В режиме advanced нужны хотя бы два администратора памяти с ключами, привязанными к устройству: иначе вернуть basic некому подписать.",
  administrators2: "Администраторы",
};
