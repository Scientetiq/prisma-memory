// Each component imports only its own request-local dictionary.
import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const ACTION_FORM_TEXT = localized({ en: en.ACTION_FORM_TEXT, ru: ru.ACTION_FORM_TEXT });
export const STEP_LABEL = localized({ en: en.STEP_LABEL, ru: ru.STEP_LABEL });
export const ADMIN_PLANE_STUB_TEXT = localized({ en: en.ADMIN_PLANE_STUB_TEXT, ru: ru.ADMIN_PLANE_STUB_TEXT });
export const AGENT_CARD_TEXT = localized({ en: en.AGENT_CARD_TEXT, ru: ru.AGENT_CARD_TEXT });
export const CONNECTION_KIND_TITLES = localized({ en: en.CONNECTION_KIND_TITLES, ru: ru.CONNECTION_KIND_TITLES });
export const APPROVAL_PENDING_TEXT = localized({ en: en.APPROVAL_PENDING_TEXT, ru: ru.APPROVAL_PENDING_TEXT });
export const CONFIRM_DIALOG_TEXT = localized({ en: en.CONFIRM_DIALOG_TEXT, ru: ru.CONFIRM_DIALOG_TEXT });
export const CONVERTER_BLOCK_TEXT = localized({ en: en.CONVERTER_BLOCK_TEXT, ru: ru.CONVERTER_BLOCK_TEXT });
export const COPY_BLOCK_TEXT = localized({ en: en.COPY_BLOCK_TEXT, ru: ru.COPY_BLOCK_TEXT });
export const ERROR_ACTIONS_TEXT = localized({ en: en.ERROR_ACTIONS_TEXT, ru: ru.ERROR_ACTIONS_TEXT });
export const EXTERNAL_NOTICES_TEXT = localized({ en: en.EXTERNAL_NOTICES_TEXT, ru: ru.EXTERNAL_NOTICES_TEXT });
export const HEALTH_BANNER_TEXT = localized({ en: en.HEALTH_BANNER_TEXT, ru: ru.HEALTH_BANNER_TEXT });
export const STATUS_TITLES = localized({ en: en.STATUS_TITLES, ru: ru.STATUS_TITLES });
export const HEALTH_DEGRADED_TEXT = localized({ en: en.HEALTH_DEGRADED_TEXT, ru: ru.HEALTH_DEGRADED_TEXT });
export const LLM_STATE_BLOCK_TEXT = localized({ en: en.LLM_STATE_BLOCK_TEXT, ru: ru.LLM_STATE_BLOCK_TEXT });
export const LOGIN_STATUS_CARD_TEXT = localized({ en: en.LOGIN_STATUS_CARD_TEXT, ru: ru.LOGIN_STATUS_CARD_TEXT });
export const MEETING_ROW_TEXT = localized({ en: en.MEETING_ROW_TEXT, ru: ru.MEETING_ROW_TEXT });
export const MISSING_PLAIN = localized({ en: en.MISSING_PLAIN, ru: ru.MISSING_PLAIN });
export const MOCKS_TEXT = localized({ en: en.MOCKS_TEXT, ru: ru.MOCKS_TEXT });
export const KEYS = localized({ en: en.KEYS, ru: ru.KEYS });
export const WHO = localized({ en: en.WHO, ru: ru.WHO });
export const PAGER_TEXT = localized({ en: en.PAGER_TEXT, ru: ru.PAGER_TEXT });
export const PEOPLE_PICKER_TEXT = localized({ en: en.PEOPLE_PICKER_TEXT, ru: ru.PEOPLE_PICKER_TEXT });
export const PERSON_SUGGEST_TEXT = localized({ en: en.PERSON_SUGGEST_TEXT, ru: ru.PERSON_SUGGEST_TEXT });
export const SLUG_PREVIEW = localized({ en: en.SLUG_PREVIEW, ru: ru.SLUG_PREVIEW });
export const RECORD_ROW_TEXT = localized({ en: en.RECORD_ROW_TEXT, ru: ru.RECORD_ROW_TEXT });
export const REPORT_DESPITE_TEXT = localized({ en: en.REPORT_DESPITE_TEXT, ru: ru.REPORT_DESPITE_TEXT });
export const REPORT_QUALITY_TEXT = localized({ en: en.REPORT_QUALITY_TEXT, ru: ru.REPORT_QUALITY_TEXT });
export const RETRY_LATER_TEXT = localized({ en: en.RETRY_LATER_TEXT, ru: ru.RETRY_LATER_TEXT });
export const ROW_MENU_TEXT = localized({ en: en.ROW_MENU_TEXT, ru: ru.ROW_MENU_TEXT });
export const SECRET_BOX_TEXT = localized({ en: en.SECRET_BOX_TEXT, ru: ru.SECRET_BOX_TEXT });
export const SECTION_SETTINGS_FORM_TEXT = localized({ en: en.SECTION_SETTINGS_FORM_TEXT, ru: ru.SECTION_SETTINGS_FORM_TEXT });
export const SETTINGS_SEARCH_TEXT = localized({ en: en.SETTINGS_SEARCH_TEXT, ru: ru.SETTINGS_SEARCH_TEXT });
export const SHELL_TEXT = localized({ en: en.SHELL_TEXT, ru: ru.SHELL_TEXT });
export const SPACE_CARD_TEXT = localized({ en: en.SPACE_CARD_TEXT, ru: ru.SPACE_CARD_TEXT });
export const SPACE_SEARCH_TEXT = localized({ en: en.SPACE_SEARCH_TEXT, ru: ru.SPACE_SEARCH_TEXT });
export const TABLE_WRAP_TEXT = localized({ en: en.TABLE_WRAP_TEXT, ru: ru.TABLE_WRAP_TEXT });
export const TEST_AFTER_SAVE_TEXT = localized({ en: en.TEST_AFTER_SAVE_TEXT, ru: ru.TEST_AFTER_SAVE_TEXT });
export const TOASTS_TEXT = localized({ en: en.TOASTS_TEXT, ru: ru.TOASTS_TEXT });
export const UI_TEXT = localized({ en: en.UI_TEXT, ru: ru.UI_TEXT });
export const VIEW_AS_TEXT = localized({ en: en.VIEW_AS_TEXT, ru: ru.VIEW_AS_TEXT });
export const GROUP_VALIDITY_TEXT = localized({ en: en.GROUP_VALIDITY_TEXT, ru: ru.GROUP_VALIDITY_TEXT });
export const PAGER_NOUNS = localized({ en: en.PAGER_NOUNS, ru: ru.PAGER_NOUNS });
export const PAGER_COUNTS = localized({ en: en.PAGER_COUNTS, ru: ru.PAGER_COUNTS });

/** Keep the existing noun prop usable while each calling area adopts semantic noun keys. */
export function cursorCountText(noun: string | undefined, shown: number): string {
  if (noun === undefined) return PAGER_COUNTS.rows(shown);
  for (const key of Object.keys(en.PAGER_NOUNS) as (keyof typeof en.PAGER_NOUNS)[]) {
    if (noun === key || noun === en.PAGER_NOUNS[key] || noun === ru.PAGER_NOUNS[key] || noun === PAGER_NOUNS[key]) return PAGER_COUNTS[key](shown);
  }
  return PAGER_COUNTS.custom(noun, shown);
}
