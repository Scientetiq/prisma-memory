import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;
