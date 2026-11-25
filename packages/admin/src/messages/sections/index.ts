// Read each dictionary in the locale of the current request.
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const SECTION_TITLES = localized({ en: en.SECTION_TITLES, ru: ru.SECTION_TITLES });
