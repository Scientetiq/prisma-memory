const SPACES_JS = /[ \t\n\r\f\v\u00a0]+/g;

export function normQuery(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const n = String(text).replace(SPACES_JS, " ").replace(/^ | $/g, "").toLowerCase();
  return n === "" ? null : n;
}

export const normQuerySql = (expr: string): string =>
  `NULLIF(lower(btrim(regexp_replace(${expr}, '[ \\t\\n\\r\\f\\v\\u00a0]+', ' ', 'g'))), '')`;
