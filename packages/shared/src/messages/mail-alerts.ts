// Alert mails to the administrators (kind alert): one alert, the catch-up after a time without alert mail, and the daily
// digest. Rendered by renderMail (../mail-render.ts). Only service data: codes, times, counts, identifiers.
import { defineMessages, plural } from "@memory/i18n";

export const M = defineMessages("shared.mail-alerts", {
  timeUnknown: { en: "time unknown", ru: "время неизвестно" },
  where: { en: "the {product} admin panel, section “Alerts”", ru: "панель администратора памяти, раздел «Оповещения»" },
  footer: {
    en: "This message contains no record text, queries, passwords or keys: only the event code, the time and a service line. It was sent automatically by {product}.",
    ru: "В письме нет текстов записей, запросов, паролей и ключей: только код события, время и служебная строка. Это письмо Prisma Memory отправила автоматически.",
  },
  all: { en: "All alerts and the “Acknowledged” mark: {where}.", ru: "Все тревоги и отметка «Принято»: {where}." },
  levelPage: { en: "urgent", ru: "срочная" },
  levelHigh: { en: "high", ru: "высокая" },
  levelMedium: { en: "medium", ru: "средняя" },
  levelMetric: { en: "counter", ru: "счётчик" },

  subject: { en: "{product}: {kind}{again} — {title}", ru: "Память: {kind}{again} — {title}" },
  kindAlert: { en: "alert", ru: "тревога" },
  kindPage: { en: "urgent alert", ru: "срочная тревога" },
  again: { en: " (repeated)", ru: " (повтор)" },
  intro: {
    en: "Alert for the administrators of {product} (instance {instance}), level: {level}.",
    ru: "Тревога администраторам памяти (инстанс {instance}), уровень — {level}.",
  },
  what: { en: "What happened: {title} (code {code}).", ru: "Что случилось: {title} (код {code})." },
  whatCode: { en: "What happened: event code {code}.", ru: "Что случилось: {code} (код {code})." },
  when: { en: "When: {time}.", ru: "Когда: {time}." },
  whenLast: { en: "When: {time} (most recent).", ru: "Когда: {time} (последний раз)." },
  repeated: {
    en: "Repeated: {count} times. Mark it “Acknowledged” once you have dealt with it.",
    ru: "Повторялась: {count} раз. Отметьте «Принято», когда разберётесь.",
  },
  repeatedSince: {
    en: "Repeated: {count} times, first {first}. Mark it “Acknowledged” once you have dealt with it.",
    ru: "Повторялась: {count} раз, впервые {first}. Отметьте «Принято», когда разберётесь.",
  },
  about: { en: "Subject (identifier): {subject}.", ru: "Предмет (идентификатор): {subject}." },
  details: { en: "Details: {summary}", ru: "Подробно: {summary}" },
  todo: { en: "What to do: {hint}", ru: "Что сделать: {hint}" },

  catchupSubject: {
    en: "{product}: high alerts raised while alert mail was off — {count}",
    ru: "Память: высокие тревоги, пока письма не уходили — {count}",
  },
  catchupIntro: {
    en: plural({
      one: "Alerts for the administrators of {product} (instance {instance}): {count} high alert was not mailed while alert mail was off (mail was switched off or no recipients were set). If you did not switch the mail off, find out who did and why.",
      other: "Alerts for the administrators of {product} (instance {instance}): {count} high alerts were not mailed while alert mail was off (mail was switched off or no recipients were set). If you did not switch the mail off, find out who did and why.",
    }),
    ru: "Тревоги администраторам памяти (инстанс {instance}): {count} высоких тревог не ушли письмом, пока письма-тревоги не уходили (почта была выключена или получатели не заданы). Если письма выключали не вы — разберитесь, кто и зачем.",
  },
  catchupMore: { en: "• and {count} more", ru: "• и ещё {count}" },

  digestSubject: { en: "{product}: alert digest for {day} — {total}", ru: "Память: сводка тревог за {day} — {total}" },
  digestSubjectOpen: {
    en: "{product}: alert digest for {day} — {total}, open security alerts: {open}",
    ru: "Память: сводка тревог за {day} — {total}, не разобрано тревог безопасности: {open}",
  },
  digestIntro: {
    en: "Digest of medium alerts for the administrators of {product} (instance {instance}) for {day}: {total} in total.",
    ru: "Сводка средних тревог администраторам памяти (инстанс {instance}) за {day}: всего {total}.",
  },
  digestByKind: { en: "By kind:", ru: "По видам:" },
  digestGroup: { en: "• {name} — {total}, latest {time}", ru: "• {name} — {total}, последняя {time}" },
  digestRecent: { en: "Latest:", ru: "Последние:" },
  digestRecentOf: { en: "Latest {shown} of {total}:", ru: "Последние {shown} из {total}:" },
  digestMore: {
    en: plural({
      one: "{count} more medium alert is in the admin panel; it will be included in the next digest.",
      other: "{count} more medium alerts are in the admin panel; they will be included in the next digest.",
    }),
    ru: "И ещё {count} средних тревог — в панели; они войдут в следующую сводку.",
  },
  digestOpen: {
    en: "Open security and security-mode alerts (they have already been mailed; mark them “Acknowledged” once you have dealt with them):",
    ru: "Не разобраны тревоги безопасности и режима (письмо о них уже уходило; отметьте «Принято», когда разберётесь):",
  },
  digestOpenRow: { en: "• {name} — {alerts}, latest {time}", ru: "• {name} — {alerts}, последняя {time}" },
  digestOpenRowRepeats: { en: "• {name} — {alerts}, {repeats} repeats, latest {time}", ru: "• {name} — {alerts}, повторов {repeats}, последняя {time}" },
  digestOpenMore: { en: "• and {count} more", ru: "• и ещё {count} видов" },
  digestHostFacts: {
    en: "Host facts about the security mode (who is in the docker group, passwordless sudo, the runner, the bridge) were updated {time}: see the admin panel, section “Alerts”.",
    ru: "Факты хоста о режиме (кто в группе docker, sudo без пароля, раннер, мост) обновлены {time} — смотрите в панели, раздел «Оповещения».",
  },

  transportSubject: { en: "{product}: the mail transport for alerts is being changed", ru: "Память: меняется транспорт почты тревог" },
  transportNow: {
    en: "The mail transport that carries alert mail is being changed right now: {keys}.",
    ru: "Сейчас меняют транспорт почты, через который уходят письма-тревоги: {keys}.",
  },
  transportNowWho: {
    en: "The mail transport that carries alert mail is being changed right now: {keys} ({who}).",
    ru: "Сейчас меняют транспорт почты, через который уходят письма-тревоги: {keys} ({who}).",
  },
  transportOld: {
    en: "This message was sent through the previous transport, before the change. If you are not making this change and it is not planned, check the “Mail (SMTP)” section and the audit log.",
    ru: "Это письмо ушло через прежний транспорт до смены. Если смену делаете не вы и не по плану — проверьте раздел «Почта (SMTP)» и журнал событий.",
  },
  transportNext: { en: "The next alert mails will go through the new transport.", ru: "Следующие письма-тревоги пойдут через новый транспорт." },
});
