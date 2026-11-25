// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const ADMIN_GUARD_TEXT: Messages<typeof en.ADMIN_GUARD_TEXT> = {
AUDITOR_DENIED: "Режим аудитора: только чтение. Вернитесь в режим «Администратор», чтобы менять данные.",
AUDITOR_ROLE_DENIED: "Вы вошли как аудитор ИБ: панель открыта только для чтения."
};
