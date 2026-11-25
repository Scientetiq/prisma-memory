import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const STATUS = localized({ en: en.STATUS, ru: ru.STATUS }) as typeof en.STATUS;
export const FLAG_TITLES = localized({ en: en.FLAG_TITLES, ru: ru.FLAG_TITLES }) as typeof en.FLAG_TITLES;
export const ACTIONS_TEXT = localized({ en: en.ACTIONS_TEXT, ru: ru.ACTIONS_TEXT }) as typeof en.ACTIONS_TEXT;
export const PAGE_TEXT = localized({ en: en.PAGE_TEXT, ru: ru.PAGE_TEXT }) as typeof en.PAGE_TEXT;
export const PROFILE_CONFIRM_TEXT = localized({ en: en.PROFILE_CONFIRM_TEXT, ru: ru.PROFILE_CONFIRM_TEXT }) as typeof en.PROFILE_CONFIRM_TEXT;
export const VIEW_TEXT = localized({ en: en.VIEW_TEXT, ru: ru.VIEW_TEXT }) as typeof en.VIEW_TEXT;
