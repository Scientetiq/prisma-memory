import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const DONE = localized({ en: en.DONE, ru: ru.DONE }) as typeof en.DONE;
export const STATE_FILTERS = localized({ en: en.STATE_FILTERS, ru: ru.STATE_FILTERS }) as typeof en.STATE_FILTERS;
export const STATE_BADGES = localized({ en: en.STATE_BADGES, ru: ru.STATE_BADGES }) as typeof en.STATE_BADGES;
export const APPROVAL_ERRORS = localized({ en: en.APPROVAL_ERRORS, ru: ru.APPROVAL_ERRORS }) as typeof en.APPROVAL_ERRORS;
export const ACTIONS_TEXT = localized({ en: en.ACTIONS_TEXT, ru: ru.ACTIONS_TEXT }) as typeof en.ACTIONS_TEXT;
export const PAGE_TEXT = localized({ en: en.PAGE_TEXT, ru: ru.PAGE_TEXT }) as typeof en.PAGE_TEXT;
