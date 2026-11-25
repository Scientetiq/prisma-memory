// Messages in the language of the current request. One export per dictionary.
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const GATEWAY_TEXT = localized({ en: en.GATEWAY_TEXT, ru: ru.GATEWAY_TEXT });
