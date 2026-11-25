import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const FORM_TEXT = localized({ en: en.FORM_TEXT, ru: ru.FORM_TEXT }) as typeof en.FORM_TEXT;
