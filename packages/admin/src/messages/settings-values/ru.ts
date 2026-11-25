import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const SETTINGS_VALUES_TEXT: Messages<typeof en.SETTINGS_VALUES_TEXT> = {
  numberRequired: "Нужно число",
  booleanRequired: "Нужно значение «включено» или «выключено»",
  invalidJson: (message: string): string => `Некорректный JSON: ${message}`,
  arrayRequired: "Ожидается JSON-массив: [ … ]",
  objectRequired: "Ожидается JSON-объект: { … }",
  secretEdgeSpaceHint: "В пароле есть пробел в начале или в конце — он сохранится как есть.",
  changedInOtherWindow: "Эту настройку уже изменили в другом окне — обновите страницу",
  clearKeyQuestion: (key: string, dirty: boolean): string => `Стереть ключ «${key}»? Память перестанет работать для всех сотрудников и их агентов, пока не будет введён новый ключ. `
    + "Панель ключ не показывает: чтобы вернуть работу, понадобится сам ключ."
    + (dirty ? " Несохранённые изменения в других полях этой категории пропадут." : ""),
  emptiedQuestion: (keys: string[]): string => {
    const what = keys.length === 1 ? `Поле «${keys[0]}» обязательной настройки пустое.` : `Поля обязательных настроек пустые: ${keys.map((k) => `«${k}»`).join(", ")}.`;
    return `${what} Если сохранить так, память перестанет работать для всех сотрудников и их агентов, пока значение не впишут снова. Сохранить с пустым значением?`;
  },
  requiredEmptyError: "Обязательная настройка: пустое значение остановит память для всех. Впишите значение — стереть её можно только с подтверждением.",
  changedElsewhere: "настройку изменили в другой вкладке — обновите страницу и повторите",
};
