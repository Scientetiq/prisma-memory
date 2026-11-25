// Texts of the root layout in the locale of the current request. One constant per dictionary.
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const root = localized({ en: en.root, ru: ru.root });

export const missing = localized({ en: en.missing, ru: ru.missing });
