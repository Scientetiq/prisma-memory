export const SHOWCASE_LOGINS = ["demo.head@corp.test", "demo.employee@corp.test"] as const;

export function isTestDomainLogin(login: string | null | undefined): boolean {
  const d = (String(login ?? "").split("@")[1] ?? "").toLowerCase();
  return d === "corp.test" || d === "test" || d.endsWith(".test");
}

export function isShowcaseLogin(login: string | null | undefined): boolean {
  return (SHOWCASE_LOGINS as readonly string[]).includes(String(login ?? "").toLowerCase());
}

const sqlLogins = SHOWCASE_LOGINS.map((l) => `'${l}'`).join(", ");

export const testLoginSql = (p: string): string =>
  `(lower(split_part(${p}.login, '@', 2)) IN ('corp.test', 'test') OR lower(split_part(${p}.login, '@', 2)) LIKE '%.test')`;

export const showcaseSql = (p: string): string =>
  `(COALESCE(${p}.attrs->>'demo', '') = 'true' OR lower(${p}.login) IN (${sqlLogins}))`;
