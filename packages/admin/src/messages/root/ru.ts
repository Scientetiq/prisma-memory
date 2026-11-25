// Texts of the root layout in Russian: today's description of the page, byte for byte. Same constants and keys as en.ts.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const root: Messages<typeof en.root> = {
  description: "Prisma Memory: рабочее место сотрудника и панель администратора",
};

export const missing: Messages<typeof en.missing> = { title: "Страницы нет", workspaceSub: "рабочее место", signIn: "Войти", workspace: "Рабочее место", panel: "Панель" };
