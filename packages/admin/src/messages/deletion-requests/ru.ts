// Original Russian messages for this area.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { DeletionReason } from "../../lib/deletion-requests";
export const DELETION_REASON_TITLES: Messages<typeof en.DELETION_REASON_TITLES> = { by_mistake: "записана по ошибке", private: "личный разговор", no_consent: "не давал согласия на запись", other: "другое" };
export const DELETION_REQUESTS_TEXT: Messages<typeof en.DELETION_REQUESTS_TEXT> = {
    askDeleteConfirm: "Попросить удалить встречу? Организатор встречи и администратор памяти увидят просьбу (и получат письмо, если почта настроена). Удалить встречу сами вы не можете: это делают они — встреча уйдёт в корзину.",
    keepConfirm: "Оставить встречу? Участник увидит, что вы её оставили; окончательное решение по его просьбе примет администратор памяти. Если человек на встрече не был, уберите его из участников — встреча останется.",
    keptByAdmin: "Администратор памяти оставил встречу — попросить удалить её ещё раз нельзя.",
};
export const REQUESTER_GONE: Messages<typeof en.REQUESTER_GONE> = { left: "вышел(а) из встречи сам(а)", removed: "уже не в участниках встречи" };
export const DELETION_REQUESTS_MESSAGES: Messages<typeof en.DELETION_REQUESTS_MESSAGES> = {
    askDeleteHint: "Удалить встречу могут её организатор или администратор памяти. Если её не должно быть в памяти — попросите удалить.",
    adminKeepConfirm: "Оставить встречу в памяти? Все просьбы удалить её закроются: просившие увидят «администратор оставил встречу» и получат письмо, если почта включена. Попросить удалить эту встречу ещё раз будет нельзя.",
    adminDeleteConfirm: "Удалить встречу по просьбе участника? Встреча с резюме и событиями уйдёт в корзину владельца на срок корзины: владелец сможет её восстановить, после срока она очистится безвозвратно.",
};
