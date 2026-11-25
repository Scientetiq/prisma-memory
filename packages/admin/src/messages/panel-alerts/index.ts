import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const LEVEL_FILTERS = localized({ en: en.LEVEL_FILTERS, ru: ru.LEVEL_FILTERS }) as typeof en.LEVEL_FILTERS;
export const STATUS_FILTERS = localized({ en: en.STATUS_FILTERS, ru: ru.STATUS_FILTERS }) as typeof en.STATUS_FILTERS;
export const LEVEL_BADGES = localized({ en: en.LEVEL_BADGES, ru: ru.LEVEL_BADGES }) as typeof en.LEVEL_BADGES;
export const STATUS_BADGES = localized({ en: en.STATUS_BADGES, ru: ru.STATUS_BADGES }) as typeof en.STATUS_BADGES;
export const SUBJECT_TITLES = localized({ en: en.SUBJECT_TITLES, ru: ru.SUBJECT_TITLES }) as typeof en.SUBJECT_TITLES;
export const HOST_FACT_TITLES = localized({ en: en.HOST_FACT_TITLES, ru: ru.HOST_FACT_TITLES }) as typeof en.HOST_FACT_TITLES;
export const QUOTA_KIND_TITLES = localized({ en: en.QUOTA_KIND_TITLES, ru: ru.QUOTA_KIND_TITLES }) as typeof en.QUOTA_KIND_TITLES;
export const ACTIONS_TEXT = localized({ en: en.ACTIONS_TEXT, ru: ru.ACTIONS_TEXT }) as typeof en.ACTIONS_TEXT;
export const PAGE_TEXT = localized({ en: en.PAGE_TEXT, ru: ru.PAGE_TEXT }) as typeof en.PAGE_TEXT;
export const VIEW_TEXT = localized({ en: en.VIEW_TEXT, ru: ru.VIEW_TEXT }) as typeof en.VIEW_TEXT;
