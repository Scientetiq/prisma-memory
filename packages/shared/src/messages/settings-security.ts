// Descriptions of the security.* settings (the security mode), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-security", {
  mode: {
    en: "Security mode: basic — agents work without human co-signers, weakenings take effect at once with an alert; advanced — second signatures, device-bound keys, offline signers. Changed only by the “Enable advanced” button and, back, by a request of two people",
    ru: "Режим безопасности: basic — агенты работают без людей-подписантов, ослабления исполняются сразу с тревогой; advanced — вторые подписи, ключи на устройствах, офлайн-подписанты. Меняется только кнопкой «Включить advanced» и возвратом по заявке двух людей",
  },
  downgrade_delay_hours: {
    en: "How many hours after the signature the return from advanced to basic takes effect (24–168). Lowering it is a weakening",
    ru: "Через сколько часов после подписи исполняется возврат из advanced в basic (24–168). Уменьшение — ослабление",
  },
});
