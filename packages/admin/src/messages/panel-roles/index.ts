import { localized } from "../../i18n/runtime";
import * as en from "./en";
import * as ru from "./ru";

export const rolesActions = localized({ en: en.rolesActions, ru: ru.rolesActions });
export const rolesGrantForm = localized({ en: en.rolesGrantForm, ru: ru.rolesGrantForm });
export const rolesPage = localized({ en: en.rolesPage, ru: ru.rolesPage });
export const rolesSpecialRoles = localized({ en: en.rolesSpecialRoles, ru: ru.rolesSpecialRoles });

export const coreRoles = localized({ en: en.coreRoles, ru: ru.coreRoles });

export function coreRoleName(code: string, fallback: string): string {
  return Object.hasOwn(coreRoles, code) ? coreRoles[code as keyof typeof coreRoles].name : fallback;
}

export function coreRoleDescription(code: string, fallback: string | null): string | null {
  return Object.hasOwn(coreRoles, code) ? coreRoles[code as keyof typeof coreRoles].description : fallback;
}
