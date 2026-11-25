// Refusal texts of the upload limits (../upload-limits.ts), in plain words: a person sees them in the workspace and an agent
// retells them. Rendered with tr in the locale of the answer; the numbers come already formatted for that locale.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.upload-limits", {
  mib: { en: "{n} MiB", ru: "{n} МиБ" },
  gib: { en: "{n} GiB", ru: "{n} ГиБ" },
  daily_refusal: {
    en: "The daily upload limit is used up: one person may upload up to {files} files and {volume} a day. You can go on tomorrow or ask the memory administrator to raise the limit. Reading and searching work as usual",
    ru: "Суточный предел загрузки исчерпан: за сутки один человек загружает до {files} файлов и {volume}. Продолжить можно завтра или попросите администратора памяти поднять предел. Читать и искать можно как обычно",
  },
});
