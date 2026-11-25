// Words of the sign-in form of the local account (app/admin/login/local-form.tsx).
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const loginForm: Messages<typeof en.loginForm> = {
  login: "Логин",
  password: "Пароль",
  submit: "Войти",
  pending: "Вход…",
};
