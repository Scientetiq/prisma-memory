import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const texts = localized({ en: en.texts, ru: ru.texts });
export const actions = localized({ en: en.actions, ru: ru.actions });
