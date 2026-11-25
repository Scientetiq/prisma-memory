import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const LOCAL_CHANGE = localized({ en: en.LOCAL_CHANGE, ru: ru.LOCAL_CHANGE }) as typeof en.LOCAL_CHANGE;
