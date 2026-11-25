import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const SMTP_GROUPS = localized({ en: en.SMTP_GROUPS, ru: ru.SMTP_GROUPS }) as typeof en.SMTP_GROUPS;
export const SMTP_ENABLED = localized({ en: en.SMTP_ENABLED, ru: ru.SMTP_ENABLED }) as typeof en.SMTP_ENABLED;
export const MAIL_KIND_TITLES = localized({ en: en.MAIL_KIND_TITLES, ru: ru.MAIL_KIND_TITLES }) as typeof en.MAIL_KIND_TITLES;
export const MAIL_STATUS_TITLES = localized({ en: en.MAIL_STATUS_TITLES, ru: ru.MAIL_STATUS_TITLES }) as typeof en.MAIL_STATUS_TITLES;
export const SMTP_ERROR_TITLES = localized({ en: en.SMTP_ERROR_TITLES, ru: ru.SMTP_ERROR_TITLES }) as typeof en.SMTP_ERROR_TITLES;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;
