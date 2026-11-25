import { derivedList } from "../i18n/runtime";
import { GROUPS_BY_STAGE } from "../messages/edge-form";
import type { LdapField } from "./ldap-form";

export type EdgeFieldCategory = "edge" | "admin";
export interface EdgeField extends Omit<LdapField, "category"> { category: EdgeFieldCategory }
export interface EdgeGroup { title: string; hint?: string; fields: EdgeField[] }

type Stage = "P0" | "1a" | "1b" | "1c" | "1d" | "1e" | "1f" | "S2-3" | "4" | "E2" | "5";


export const EDGE_GROUPS: readonly EdgeGroup[] = derivedList(() => Object.values(GROUPS_BY_STAGE).flat());
export const EDGE_FIELDS: readonly EdgeField[] = derivedList(() => EDGE_GROUPS.flatMap((g) => g.fields));
export const edgeFieldPath = (f: Pick<EdgeField, "category" | "key">): string => `${f.category}.${f.key}`;
