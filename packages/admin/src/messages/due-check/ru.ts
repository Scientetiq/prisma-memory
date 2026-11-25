import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  checkTheDueDate: "проверьте срок",
  thisDueDateIsEarlierThan: "Срок назван датой раньше дня встречи — возможно, модель ошиблась при разборе. Исправить — «Исправить» на странице решения.",
  theDueDateIsEarlierThan: (value0: string | number | null | undefined): string => `Срок «${value0}» назван датой раньше дня встречи — возможно, модель ошиблась при разборе. Проверьте его и при необходимости исправьте: «Исправить» ниже.`,
};
