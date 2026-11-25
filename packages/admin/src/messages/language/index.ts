// The language switch in the locale of the current request; `names` gives every locale's own name. One constant per
// dictionary.
import type { Locale } from "../../i18n/core";
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const language = localized({ en: en.language, ru: ru.language });

/** Each locale by the name its own catalog gives it ("English" for English), in the order of the switch. */
export const LANGUAGE_NAMES: ReadonlyArray<{ readonly locale: Locale; readonly name: string }> = Object.freeze([
  Object.freeze({ locale: "en" as const, name: en.language.name }),
  Object.freeze({ locale: "ru" as const, name: ru.language.name }),
]);
