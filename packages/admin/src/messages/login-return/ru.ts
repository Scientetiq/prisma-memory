import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const SESSION_PLAIN: Messages<typeof en.SESSION_PLAIN> = {
    ended: "Сеанс закончился. Войдите снова — текст не пропадёт",
    login: "Войти (в новой вкладке)",
    expired: "Срок входа истёк — войдите снова.",
    back: "После входа откроется страница, которую вы открывали.",
} as const;
