import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const FULL = localized({ en: en.FULL, ru: ru.FULL }) as typeof en.FULL;
export const AUDITOR = localized({ en: en.AUDITOR, ru: ru.AUDITOR }) as typeof en.AUDITOR;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;
