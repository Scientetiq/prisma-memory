import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const MODE_TITLES = localized({ en: en.MODE_TITLES, ru: ru.MODE_TITLES }) as typeof en.MODE_TITLES;
export const PROBLEM_TITLES = localized({ en: en.PROBLEM_TITLES, ru: ru.PROBLEM_TITLES }) as typeof en.PROBLEM_TITLES;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;
