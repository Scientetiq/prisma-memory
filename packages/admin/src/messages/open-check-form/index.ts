import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const REGEXP_PROBLEMS = localized({ en: en.REGEXP_PROBLEMS, ru: ru.REGEXP_PROBLEMS }) as typeof en.REGEXP_PROBLEMS;
export const OPEN_CHECK_PACK_TITLES = localized({ en: en.OPEN_CHECK_PACK_TITLES, ru: ru.OPEN_CHECK_PACK_TITLES }) as typeof en.OPEN_CHECK_PACK_TITLES;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;

export const OPEN_CHECK_MEDIA_NOTE = en.OPEN_CHECK_MEDIA_NOTE;
