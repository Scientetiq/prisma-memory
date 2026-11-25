import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;
export const TRANSPORT_TITLES = localized({ en: en.TRANSPORT_TITLES, ru: ru.TRANSPORT_TITLES }) as typeof en.TRANSPORT_TITLES;
export const ROLE_TITLES = localized({ en: en.ROLE_TITLES, ru: ru.ROLE_TITLES }) as typeof en.ROLE_TITLES;
export const ACTIONS_TEXT = localized({ en: en.ACTIONS_TEXT, ru: ru.ACTIONS_TEXT }) as typeof en.ACTIONS_TEXT;
export const PAGE_TEXT = localized({ en: en.PAGE_TEXT, ru: ru.PAGE_TEXT }) as typeof en.PAGE_TEXT;
export const REGISTER_CLIENT_TEXT = localized({ en: en.REGISTER_CLIENT_TEXT, ru: ru.REGISTER_CLIENT_TEXT }) as typeof en.REGISTER_CLIENT_TEXT;
