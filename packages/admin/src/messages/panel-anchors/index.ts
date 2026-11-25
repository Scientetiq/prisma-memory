import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const KIND_TITLES = localized({ en: en.KIND_TITLES, ru: ru.KIND_TITLES }) as typeof en.KIND_TITLES;
export const DRAFT_ERRORS = localized({ en: en.DRAFT_ERRORS, ru: ru.DRAFT_ERRORS }) as typeof en.DRAFT_ERRORS;
export const PAGE_TEXT = localized({ en: en.PAGE_TEXT, ru: ru.PAGE_TEXT }) as typeof en.PAGE_TEXT;
