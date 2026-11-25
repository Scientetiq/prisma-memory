import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const ACTIONS_TEXT = localized({ en: en.ACTIONS_TEXT, ru: ru.ACTIONS_TEXT }) as typeof en.ACTIONS_TEXT;
export const PAGE_TEXT = localized({ en: en.PAGE_TEXT, ru: ru.PAGE_TEXT }) as typeof en.PAGE_TEXT;
