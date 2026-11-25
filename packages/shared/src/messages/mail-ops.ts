// Service mails to the administrator: the test message of the "Mail (SMTP)" section, the report of an open-check recheck
// and the request to return the security mode to basic. Rendered by renderMail (../mail-render.ts).
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.mail-ops", {
  testSubject: { en: "{product}: test message", ru: "Память: тестовое письмо" },
  testIntro: {
    en: "This is a test message from {product}: the “Mail (SMTP)” section is set up and mail gets delivered.",
    ru: "Это тестовое письмо Prisma Memory: раздел «Почта (SMTP)» настроен, письма доходят.",
  },
  testBy: { en: "Sent by: {by}.", ru: "Отправил: {by}." },
  testWorkplace: { en: "Workspace: {url}", ru: "Рабочее место: {url}" },
  testNoWorkplace: {
    en: "The workspace address is not set (setting access.workplace_url), so mails will carry no links.",
    ru: "Адрес рабочего места не задан (настройка access.workplace_url) — в письмах не будет ссылок.",
  },
  testNoReply: { en: "There is no need to reply to this message.", ru: "Отвечать на это письмо не нужно." },

  recheckSubject: { en: "Recheck against the NDA list", ru: "Перепроверка по списку NDA" },
  recheckSubjectNfd: { en: "Open-check recheck: records saved from a Mac", ru: "Перепроверка открытого: записи, сохранённые с Mac" },
  recheckIntro: {
    en: "Recheck of open records against the list of customers under a strict NDA: {checked} checked, {held} hidden from agents.",
    ru: "Перепроверка открытых записей по списку заказчиков со строгим NDA: проверено {checked}, скрыто от агентов {held}.",
  },
  recheckIntroNfd: {
    en: "Recheck of open records saved from a Mac (letters in decomposed form) against all open-check rules: {checked} checked, {held} hidden from agents.",
    ru: "Перепроверка открытых записей, сохранённых с Mac (буквы в разложенном виде), всеми правилами проверки открытого: проверено {checked}, скрыто от агентов {held}.",
  },
  recheckUnchecked: {
    en: "Could not be checked in three attempts and hidden as well: {unchecked}.",
    ru: "Из них не удалось проверить трижды и тоже скрыто: {unchecked}.",
  },
  recheckFailed: {
    en: "Busy on all three attempts and still visible to agents: {failed}. Run “Check everything again” later.",
    ru: "Были заняты все три попытки и пока видны агентам: {failed} — запустите «Проверить всё заново» позже.",
  },
  recheckOnRestore: {
    en: "Records in the trash with a match: {onRestore}. When restored, they come back closed.",
    ru: "Записей в корзине с совпадением: {onRestore} — при восстановлении они вернутся сразу закрытыми.",
  },
  recheckNames: {
    en: "Matches in space names or descriptions: {spaces}; in entity names: {entities}. Agents still see these: rename them by hand.",
    ru: "Совпадения в названиях или описаниях пространств: {spaces}, в названиях сущностей: {entities} — их агенты по-прежнему видят, переименуйте вручную.",
  },
  recheckLook: {
    en: "See the list in the admin panel, section “Open check”: keep the records hidden, or refine the list entry and recheck the hidden ones.",
    ru: "Посмотрите список в панели, раздел «Проверка открытого»: оставить записи скрытыми или уточнить строку списка и перепроверить скрытые.",
  },
  recheckLookNfd: {
    en: "See the list in the admin panel, section “Open check”: the records stay hidden until the author fixes them and shows them to agents with the regular button.",
    ru: "Посмотрите список в панели, раздел «Проверка открытого»: записи остаются скрытыми, пока автор не исправит их и не покажет агентам штатной кнопкой.",
  },
  recheckNoText: { en: "This message contains no customer names or record titles.", ru: "Названий заказчиков и заголовков записей в этом письме нет." },
  recheckNoTextNfd: { en: "This message contains no record text or titles.", ru: "Текста и заголовков записей в этом письме нет." },

  downgradeSubject: { en: "{product}: request to return the security mode to basic", ru: "Память: заявка на возврат режима безопасности в basic" },
  downgradeAsked: {
    en: "Administrator {by} has requested to return the security mode from advanced to basic.",
    ru: "Администратор {by} подал заявку на возврат режима безопасности из advanced в basic.",
  },
  downgradeWhen: {
    en: "It can be carried out no earlier than {when}, and only after another administrator signs it.",
    ru: "Исполнить её можно не раньше {when} и только после подписи другого администратора.",
  },
  downgradeDelayEnd: { en: "the end of the delay", ru: "конца задержки" },
  downgradeCancel: {
    en: "If you do not know about this request, cancel it in the admin panel (section “Security mode”) or with the command security-mode cancel-downgrade.",
    ru: "Если вы не знаете об этой заявке — отмените её в панели администратора (раздел «Режим безопасности») или командой security-mode cancel-downgrade.",
  },
});
