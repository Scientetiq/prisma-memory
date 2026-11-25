import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const SESSION_PLAIN = localized({ en: en.SESSION_PLAIN, ru: ru.SESSION_PLAIN }) as typeof en.SESSION_PLAIN;
