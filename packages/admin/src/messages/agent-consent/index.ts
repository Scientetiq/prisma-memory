// Messages in the language of the current request. One export per dictionary.
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const EN = localized({ en: en.EN, ru: ru.EN });
export const CONSENT_AGE_TEXT = localized({ en: en.CONSENT_AGE_TEXT, ru: ru.CONSENT_AGE_TEXT });
