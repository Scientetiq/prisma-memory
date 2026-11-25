import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const ROLE_TITLES = localized({ en: en.ROLE_TITLES, ru: ru.ROLE_TITLES }) as typeof en.ROLE_TITLES;
export const METHOD_TITLES = localized({ en: en.METHOD_TITLES, ru: ru.METHOD_TITLES }) as typeof en.METHOD_TITLES;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;
