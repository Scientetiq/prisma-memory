import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const OIDC_GROUPS = localized({ en: en.OIDC_GROUPS, ru: ru.OIDC_GROUPS }) as typeof en.OIDC_GROUPS;
export const OIDC_ENABLED = localized({ en: en.OIDC_ENABLED, ru: ru.OIDC_ENABLED }) as typeof en.OIDC_ENABLED;
export const OIDC_STEP_TITLES = localized({ en: en.OIDC_STEP_TITLES, ru: ru.OIDC_STEP_TITLES }) as typeof en.OIDC_STEP_TITLES;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;
