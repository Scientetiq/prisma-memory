import { localized, derivedList } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

const personas = localized({ en: en.PERSONAS, ru: ru.PERSONAS }) as typeof en.PERSONAS;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;

export const PERSONAS = derivedList(() => en.PERSONAS.map((value, i) => ({ ...value, title: personas[i]!.title, open: personas[i]!.open, what: personas[i]!.what })));
