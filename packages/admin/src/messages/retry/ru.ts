import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const retry: Messages<typeof en.retry> = {
  requested: (product, seconds) => `${product} просит подождать ${seconds} с — страница обновится сама.`,
  again: (seconds) => `Попробуем ещё раз через ${seconds} с — страница обновится сама.`,
  repeat: (seconds) => `Повторим через ${seconds} с — страница обновится сама.`,
  refreshing: "Обновляем…",
  busy: (product, attempted) => `${product} ${attempted ? "всё ещё" : "сейчас"} занята. Попробуйте ещё раз чуть позже.`,
  manual: "Попробуйте ещё раз.",
};

export const unavailable: Messages<typeof en.unavailable> = {
  limited: (product) => `${product} сейчас занята.`,
  unreachable: (product) => `${product} не отвечает.`,
  setup: (product) => `${product} сейчас не принимает запросы: администратору нужно закончить её настройку.`,
  other: (product) => `${product} не ответила.`,
};
