// Messages in the language of the current request. One export per dictionary.
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const ANCHOR_MESSAGES = localized({ en: en.ANCHOR_MESSAGES, ru: ru.ANCHOR_MESSAGES });
