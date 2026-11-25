import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const ACTION_TEXT = localized({ en: en.ACTION_TEXT, ru: ru.ACTION_TEXT }) as typeof en.ACTION_TEXT;
