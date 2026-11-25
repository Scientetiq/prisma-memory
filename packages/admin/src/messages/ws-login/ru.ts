import { productName } from "../../i18n/brand";
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const LOGIN_PAGE_PLAIN: Messages<typeof en.LOGIN_PAGE_PLAIN> = {
    lead: "Войдите так же, как в компьютер или корпоративную почту. Пароль память не хранит.",
    get down() { return `${productName()} временно недоступна — попробуйте через несколько минут.`; },
    off: "Вход в рабочее место ещё не включён.",
    offAdmin: "Его включает администратор памяти в панели, разделы «Вход и LDAP» и «Единый вход (OpenID Connect)». До этого в рабочее место не входит никто: администратор смотрит его глазами сотрудника и руководителя через «Смотреть как» в панели.",
    help: "Не получается войти?",
    get helpPassword() { return `Логин и пароль — те же, что для входа в компьютер. ${productName()} пароли не хранит и не меняет: забыли пароль или он не подходит — сменить его можно через обычную поддержку компании.`; },
    helpAccess: "Пароль подходит, но память пишет, что доступа нет, — значит, вашей учётной записи нет в группе доступа к памяти.",
    details: "Подробнее для администратора",
    admin: "Администратору: вход в панель",
    fresh: "Чтобы включить доступ извне, войдите заново: пароль спросят ещё раз, даже если вы уже вошли.",
} as const;

export const TEXT: Messages<typeof en.TEXT> = {
  enterYourLoginAndPassword: "Введите логин и пароль",
  refreshPage: "Обновить страницу",
  code: " код {value1}",
  theSignInPageIsOutOf: "<strong1>Страница входа устарела или не открылась.</strong1> Скорее всего, память обновилась, пока страница была открыта. Обновите страницу полностью (Ctrl+F5, на Mac — Cmd+Shift+R) и войдите снова. Если повторяется — сообщите администратору памяти{value1}.",
  workspaceSignIn: "Вход в рабочее место",
  signIn: "Войти",
  signingIn: "Вход…",
  detailsForAdministrators: "Подробнее для администратора",
  password: "Пароль",
  login: "Логин",
  signIn2: "Вход",
  or: "или",
  youHaveSignedOutYourAgentsKeys: "Вы вышли. Ключи ваших агентов продолжают действовать.{value1}",
  allYourWorkspaceSessionsHaveEndedHere: "Все ваши входы в рабочее место завершены — здесь и на других устройствах. Ключи ваших агентов продолжают действовать.{value1}",
  workspaceSignIn2: "Вход в рабочее место",
  workspace: "рабочее место",
  exampleCom: "example.com",
  orUser: (value1: string | number | null | undefined): string => ` или ${value1}\\user`,
  userUserAsYouSignInTo: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `user, user@${value1}${value2} — как при входе в компьютер`,
};
