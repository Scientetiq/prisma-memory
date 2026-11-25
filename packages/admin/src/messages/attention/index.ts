// Messages in the language of the current request. One export per dictionary.
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const ATTENTION_TEXT = localized({ en: en.ATTENTION_TEXT, ru: ru.ATTENTION_TEXT });
