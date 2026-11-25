import type { DemoSample } from "../../lib/demo";
// Messages in the language of the current request. One export per dictionary.
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const DEMO_UNIT = localized({ en: en.DEMO_UNIT, ru: ru.DEMO_UNIT });
export const DEMO_SPACE = localized({ en: en.DEMO_SPACE, ru: ru.DEMO_SPACE });
export const DEMO_PEOPLE = localized({ en: en.DEMO_PEOPLE, ru: ru.DEMO_PEOPLE });
export const DEMO_ROLE_TITLES = localized({ en: en.DEMO_ROLE_TITLES, ru: ru.DEMO_ROLE_TITLES });
export const DEMO_SAMPLES = localized({ en: en.DEMO_SAMPLES, ru: ru.DEMO_SAMPLES }) as DemoSample[];
