import { localized, derivedList } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const LANE_TITLES = localized({ en: en.LANE_TITLES, ru: ru.LANE_TITLES }) as typeof en.LANE_TITLES;
const toggles = localized({ en: en.TOGGLES, ru: ru.TOGGLES }) as typeof en.TOGGLES;
export const DESPITE_ON_CONFIRM = localized({ en: en.DESPITE_ON_CONFIRM, ru: ru.DESPITE_ON_CONFIRM }) as typeof en.DESPITE_ON_CONFIRM;
export const ALL_CONFIRM = localized({ en: en.ALL_CONFIRM, ru: ru.ALL_CONFIRM }) as typeof en.ALL_CONFIRM;
export const RECHECK_REASON_TITLES = localized({ en: en.RECHECK_REASON_TITLES, ru: ru.RECHECK_REASON_TITLES }) as typeof en.RECHECK_REASON_TITLES;
export const RECHECK_STATE_TITLES = localized({ en: en.RECHECK_STATE_TITLES, ru: ru.RECHECK_STATE_TITLES }) as typeof en.RECHECK_STATE_TITLES;
export const RECHECK_WHY_TITLES = localized({ en: en.RECHECK_WHY_TITLES, ru: ru.RECHECK_WHY_TITLES }) as typeof en.RECHECK_WHY_TITLES;
export const TEXT = localized({ en: en.TEXT, ru: ru.TEXT }) as typeof en.TEXT;

export const TOGGLES = derivedList(() => en.TOGGLES.map((value, i) => ({ ...value, title: toggles[i]!.title, hint: toggles[i]!.hint })));
