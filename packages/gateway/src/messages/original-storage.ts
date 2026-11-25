import { defineMessages } from "@memory/i18n";

export const ORIGINAL_STORAGE = defineMessages("gateway.original-storage", {
  storage_not_configured: {
    en: "The text was saved without the original file: object storage is not configured for this class.",
    ru: "Текст сохранён без оригинала: хранилище для этого класса не настроено.",
  },
  storage_unavailable: {
    en: "The text was saved without the original file: object storage is unavailable.",
    ru: "Текст сохранён без оригинала: хранилище недоступно.",
  },
  storage_refused: {
    en: "The text was saved without the original file: object storage refused the file.",
    ru: "Текст сохранён без оригинала: хранилище отказало в сохранении файла.",
  },
  conversion_not_configured: {
    en: "The document was not accepted: its original could not be stored because object storage is not configured for this class.",
    ru: "Документ не принят: оригинал не сохранён, потому что хранилище для этого класса не настроено.",
  },
  conversion_unavailable: {
    en: "The document was not accepted: its original could not be stored because object storage is unavailable.",
    ru: "Документ не принят: оригинал не сохранён, потому что хранилище недоступно.",
  },
  conversion_refused: {
    en: "The document was not accepted: object storage refused its original file.",
    ru: "Документ не принят: хранилище отказало в сохранении оригинала.",
  },
  health_not_configured: {
    en: "Original storage for {cls} is not configured; the last upload did not store its original.",
    ru: "Хранилище оригиналов класса {cls} не настроено; оригинал последней загрузки не сохранён.",
  },
  health_unavailable: {
    en: "Original storage for {cls} was unavailable during the last upload.",
    ru: "При последней загрузке хранилище оригиналов класса {cls} было недоступно.",
  },
  health_refused: {
    en: "Original storage for {cls} refused the last upload.",
    ru: "Хранилище оригиналов класса {cls} отказало в последней загрузке.",
  },
  state_unavailable: {
    en: "The original upload outcome could not be read.",
    ru: "Не удалось прочитать результат сохранения оригинала.",
  },
});
