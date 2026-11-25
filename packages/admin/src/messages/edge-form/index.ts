import { localized, derived } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

const groups = localized({ en: en.GROUPS_BY_STAGE, ru: ru.GROUPS_BY_STAGE }) as typeof en.GROUPS_BY_STAGE;

export const GROUPS_BY_STAGE = derived(() => {
  const result = { ...en.GROUPS_BY_STAGE };
  for (const stage of Object.keys(result) as (keyof typeof result)[]) {
    result[stage] = en.GROUPS_BY_STAGE[stage].map((group, i) => {
      const text = groups[stage][i]!;
      return { ...group, title: text.title, ...(group.hint === undefined ? {} : { hint: text.hint }), fields: group.fields.map((field, j) => {
        const value = text.fields[j]!;
        return { ...field, label: value.label, ...(field.hint === undefined ? {} : { hint: value.hint }), ...(field.placeholder === undefined ? {} : { placeholder: value.placeholder }) };
      }) };
    });
  }
  return result;
});
