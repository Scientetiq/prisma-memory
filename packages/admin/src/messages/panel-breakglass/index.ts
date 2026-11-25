import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const REASONS = localized({ en: en.REASONS, ru: ru.REASONS }) as typeof en.REASONS;
export const PAGE_TEXT = localized({ en: en.PAGE_TEXT, ru: ru.PAGE_TEXT }) as typeof en.PAGE_TEXT;
