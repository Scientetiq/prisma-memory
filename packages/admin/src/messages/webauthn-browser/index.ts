import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const BROWSER_TEXT = localized({ en: en.BROWSER_TEXT, ru: ru.BROWSER_TEXT }) as typeof en.BROWSER_TEXT;
