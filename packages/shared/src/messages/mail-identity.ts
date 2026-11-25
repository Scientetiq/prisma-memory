// Mail to a person whose profile gained or lost a linked account (kind identity_change). Rendered by renderMail
// (../mail-render.ts).
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.mail-identity", {
  subjectBoth: { en: "The accounts linked to your {product} profile have changed", ru: "Изменены учётные записи вашей карточки в памяти" },
  subjectAdded: { en: "An account has been linked to your {product} profile", ru: "К вашей карточке в памяти привязана учётная запись" },
  subjectRemoved: { en: "An account has been unlinked from your {product} profile", ru: "От вашей карточки в памяти отвязана учётная запись" },
  intro: {
    en: "The {product} administrator has changed which accounts are linked to your profile in {product}.",
    ru: "Администратор памяти изменил, какие учётные записи связаны с вашей карточкой в Prisma Memory.",
  },
  added: { en: "Linked: {account} {id}.", ru: "Привязана: {account} {id}." },
  removed: { en: "Unlinked: {account} {id}.", ru: "Отвязана: {account} {id}." },
  agents: {
    en: "A linked account is used to sign in to {product}, and agents act on your behalf through it, including with your personal records.",
    ru: "Через связанную учётную запись входят в память и работают от вашего имени агенты, в том числе с вашими личными записями.",
  },
  unexpected: { en: "If you did not expect this, contact your {product} administrator right away.", ru: "Если вы этого не ждали — сразу напишите администратору памяти." },
  keys: { en: "Your keys and connections: {where}", ru: "Ваши ключи и подключения: {where}" },
  keysPlace: { en: "in the {product} workspace", ru: "в рабочем месте памяти" },
  systemAd: { en: "company directory account", ru: "учётная запись каталога компании" },
  systemSap: { en: "SAP account", ru: "учётная запись SAP" },
  systemTelegram: { en: "Telegram account", ru: "аккаунт Telegram" },
  systemHub: { en: "internal portal account", ru: "учётная запись внутреннего портала" },
  systemSso: { en: "single sign-on account", ru: "учётная запись единого входа" },
  systemOther: { en: "account", ru: "учётная запись" },
});
