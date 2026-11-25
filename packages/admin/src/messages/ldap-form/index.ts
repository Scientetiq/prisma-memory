import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const LDAP_GROUPS = localized({ en: en.LDAP_GROUPS, ru: ru.LDAP_GROUPS }) as typeof en.LDAP_GROUPS;
export const LDAP_ENABLED = localized({ en: en.LDAP_ENABLED, ru: ru.LDAP_ENABLED }) as typeof en.LDAP_ENABLED;
export const TLS_MODES = localized({ en: en.TLS_MODES, ru: ru.TLS_MODES }) as typeof en.TLS_MODES;
export const SMTP_SECURITY_MODES = localized({ en: en.SMTP_SECURITY_MODES, ru: ru.SMTP_SECURITY_MODES }) as typeof en.SMTP_SECURITY_MODES;
export const LDAP_STEP_TITLES = localized({ en: en.LDAP_STEP_TITLES, ru: ru.LDAP_STEP_TITLES }) as typeof en.LDAP_STEP_TITLES;
export const TEST_LOGIN_OUTCOMES = localized({ en: en.TEST_LOGIN_OUTCOMES, ru: ru.TEST_LOGIN_OUTCOMES }) as typeof en.TEST_LOGIN_OUTCOMES;
export const MATCHED_BY = localized({ en: en.MATCHED_BY, ru: ru.MATCHED_BY }) as typeof en.MATCHED_BY;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;
