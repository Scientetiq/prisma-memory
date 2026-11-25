import { parserText } from "../messages/people-csv";
import { formatCount } from "../i18n/format";

export const CSV_COLUMNS = ["login", "display_name", "given_name", "employee_id", "department", "department_code", "parent_department_code", "manager_login", "role", "unit_relation"] as const;
const OPTIONAL_EXTRA = ["active"] as const;

// Header names recognised on import: English synonyms and Russian ones (data for Russian spreadsheets).
const HEADER_ALIASES: Record<string, string> = {
  "work email": "login", "email address": "login", "name": "display_name", "full name": "display_name", "display name": "display_name",
  "employee name": "display_name", "employee id": "employee_id", "employee number": "employee_id", "department name": "department",
  "department code": "department_code", "parent department code": "parent_department_code", "manager": "manager_login",
  "manager email": "manager_login", "manager login": "manager_login", "title": "role", "job title": "role", "position": "role",
  "preferred name": "given_name", "personnel number": "employee_id", "staff id": "employee_id", "dept": "department", "unit": "department",
  "dept code": "department_code", "unit code": "department_code", "parent dept code": "parent_department_code",
  "parent unit code": "parent_department_code", "parent code": "parent_department_code", "supervisor": "manager_login",
  "unit relation": "unit_relation", "role in department": "unit_relation", "role in unit": "unit_relation",
  "is active": "active", "employed": "active", "enabled": "active",
  "логин": "login", "почта": "login", "email": "login", "e-mail": "login", "mail": "login", "рабочая почта": "login", "электронная почта": "login", "эл. почта": "login",
  "фио": "display_name", "ф.и.о.": "display_name", "имя": "display_name", "сотрудник": "display_name",
  "имя для обращения": "given_name", "обращение": "given_name", "first name": "given_name", "firstname": "given_name", "given name": "given_name",
  "табельный номер": "employee_id", "табельный": "employee_id", "таб. номер": "employee_id", "таб номер": "employee_id", "табельный №": "employee_id", "таб. №": "employee_id",
  "подразделение": "department", "отдел": "department",
  "код подразделения": "department_code", "код отдела": "department_code",
  "код вышестоящего подразделения": "parent_department_code", "код вышестоящего": "parent_department_code",
  "руководитель": "manager_login", "почта руководителя": "manager_login", "логин руководителя": "manager_login",
  "должность": "role",
  "роль в подразделении": "unit_relation",
  "активен": "active", "работает": "active",
};
const normHeader = (h: string): string => {
  const k = h.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").replace(/[*:]+$/, "").trim();
  return HEADER_ALIASES[k] ?? k;
};
const RELATIONS: Record<string, "head" | "deputy" | "member"> = {
  head: "head", deputy: "deputy", member: "member", "руководитель": "head", "заместитель": "deputy", "сотрудник": "member", "участник": "member",
};
const MAIL_RE = /^[^@\s]+@[^@\s]+$/;
const CLEAR_MARKS = new Set(["-", "–", "—"]);
const givenNameProblem = (attrs: unknown): string | null => {
  const g = attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>).given_name : undefined;
  if (g === undefined || g === null) return null;
  if (typeof g !== "string") return parserText.givenNameAttrsGivenNameMustBe;
  return g.replace(/\s+/g, " ").trim().length > 100 ? parserText.givenNameAttrsGivenNameMustBeLabel : null;
};

export interface PersonInput {
  login: string;
  display_name: string;
  employee_id?: string;
  department?: string;
  manager_login?: string;
  role?: string;
  active?: boolean;
  attrs?: { department_code?: string; parent_department_code?: string; unit_relation?: "head" | "deputy"; given_name?: string | null; [k: string]: unknown };
}
export interface PeopleBody { people: PersonInput[]; deactivate_missing?: boolean; confirm_deactivations?: number;
  confirm_reactivations?: string[] }

export interface ParsedUpload<B> {
  format: "json" | "csv" | "empty";
  body: B | null;
  rows: number;
  errors: string[];
  warnings: string[];
  lines: number[];
}

export interface CsvRow { cells: string[]; line: number }

export const PEOPLE_MAX_ROWS = 20_000;
export const CSV_MAX_COLUMNS = 200;
/** Built at the point of use: the number is written in the locale of the request. */
const tooManyRows = (): string => parserText.moreThanRowsTooManyForOne(formatCount(PEOPLE_MAX_ROWS));

export function parseCsvTable(text: string, delimiter: string, maxRows = Infinity): { rows: CsvRow[]; openQuote: number | null } {
  const src = text.replace(/^\uFEFF/, "");
  const rows: CsvRow[] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0, line = 1, start = 1, quoteLine = 0;
  const endCell = () => { row.push(cell); cell = ""; };
  const endRow = () => { endCell(); if (row.some((c) => c.trim() !== "")) rows.push({ cells: row, line: start }); row = []; };
  while (i < src.length && rows.length <= maxRows) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (ch === "\n") line++;
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell.trim() === "") { cell = ""; quoted = true; quoteLine = line; i++; continue; }
    if (ch === delimiter) { endCell(); i++; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow(); i++; line++; start = line; continue;
    }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) endRow();
  return { rows, openQuote: quoted ? quoteLine : null };
}

export const parseCsvRows = (text: string, delimiter: string, maxRows = Infinity): CsvRow[] => parseCsvTable(text, delimiter, maxRows).rows;

export const parseCsv = (text: string, delimiter: string): string[][] => parseCsvRows(text, delimiter).map((r) => r.cells);

export const openQuoteError = (line: number): string =>
  parserText.lineAQuoteIsOpenUntilThe(line);

export function detectDelimiter(text: string): string {
  const head = text.replace(/^\uFEFF/, "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const count = (d: string) => head.split(d).length - 1;
  return [",", ";", "\t"].map((d) => [d, count(d)] as const).sort((a, b) => b[1] - a[1])[0]![0];
}

const TRUE = new Set(["true", "1", "да", "yes", "y"]);
const FALSE = new Set(["false", "0", "нет", "no", "n"]);

const linesText = (ls: number[], one = parserText.line, many = parserText.lines): string => ls.length === 1 ? `${one} ${ls[0]}` : parserText.and(many, ls.slice(0, -1).join(", "), ls[ls.length - 1]);

function keepLastOfLogin(people: PersonInput[], lines: number[], json: boolean): { people: PersonInput[]; lines: number[]; warnings: string[] } {
  const key = (p: PersonInput) => String(p.login ?? "").trim().toLowerCase();
  const at = new Map<string, number[]>();
  people.forEach((p, i) => { const k = key(p), was = at.get(k); if (was) was.push(i); else at.set(k, [i]); });
  const warnings: string[] = [];
  for (const [login, idx] of at) {
    if (idx.length < 2) continue;
    const ls = idx.map((i) => lines[i]!), last = ls[ls.length - 1]!;
    warnings.push(parserText.loginAppearsMoreThanOnceTakesPrecedence(login, linesText(ls, parserText.lineLabel, json ? parserText.elements : parserText.linesLabel), json ? parserText.element : parserText.lastLine, last));
  }
  const keep = people.map((p, i) => { const idx = at.get(key(p))!; return idx[idx.length - 1] === i; });
  return { people: people.filter((_, i) => keep[i]), lines: lines.filter((_, i) => keep[i]), warnings };
}

const employeeOf = (p: PersonInput): string | null =>
  [p.employee_id, p.attrs?.employee_id].map((v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "")).find(Boolean) ?? null;

function employeeRepeats(people: PersonInput[], lines: number[], json: boolean): string[] {
  const at = new Map<string, number[]>();
  people.forEach((p, i) => { const e = employeeOf(p); if (!e) return; const was = at.get(e); if (was) was.push(lines[i]!); else at.set(e, [lines[i]!]); });
  return [...at].filter(([, ls]) => ls.length > 1)
    .map(([employee, ls]) => parserText.employeeNumberIsRepeatedEachPersonMust(json ? linesText(ls, parserText.elementLabel, parserText.elementsLabel) : linesText(ls), employee));
}

export function peopleFromCsv(text: string): ParsedUpload<PeopleBody> {
  const errors: string[] = [], warnings: string[] = [];
  const { rows: table, openQuote } = parseCsvTable(text, detectDelimiter(text), PEOPLE_MAX_ROWS + 1);
  if (openQuote !== null) return { format: "csv", body: null, rows: table.length ? table.length - 1 : 0, errors: [openQuoteError(openQuote)], warnings, lines: [] };
  if (!table.length) return { format: "csv", body: null, rows: 0, errors: [parserText.emptyCSV], warnings, lines: [] };
  if (table.length - 1 > PEOPLE_MAX_ROWS) return { format: "csv", body: null, rows: table.length - 1, errors: [tooManyRows()], warnings, lines: [] };
  if (table[0]!.cells.length > CSV_MAX_COLUMNS)
    return { format: "csv", body: null, rows: table.length - 1, errors: [parserText.moreThanColumnsCheckTheSeparatorOr(CSV_MAX_COLUMNS)], warnings, lines: [] };
  const header = table[0]!.cells.map(normHeader);
  const known = new Set<string>([...CSV_COLUMNS, ...OPTIONAL_EXTRA]);
  const colIndex = new Map<string, number>(), dup = new Set<string>();
  header.forEach((h, idx) => { if (!h) return; if (colIndex.has(h)) dup.add(h); else colIndex.set(h, idx); });
  for (const need of ["login", "display_name"]) if (!colIndex.has(need)) errors.push(parserText.requiredColumnIsMissingFromTheCSV(need));
  const unknown = table[0]!.cells.filter((h, idx) => h.trim() && !known.has(header[idx]!)).map((h) => h.trim());
  if (unknown.length) warnings.push(parserText.unknownColumnsSkipped(unknown.join(", ")));
  if (dup.size) errors.push(parserText.repeatedColumns([...dup].join(", ")));
  if (errors.length) return { format: "csv", body: null, rows: table.length - 1, errors, warnings, lines: [] };

  const people: PersonInput[] = [], lines: number[] = [];
  for (const { cells, line } of table.slice(1)) {
    const get = (name: string): string => { const idx = colIndex.get(name); return idx !== undefined ? (cells[idx] ?? "").trim() : ""; };
    const login = get("login").toLowerCase(), display_name = get("display_name");
    if (!login || !display_name) { errors.push(parserText.lineLoginAndDisplayNameAreRequired(line)); continue; }
    if (!MAIL_RE.test(login)) { errors.push(parserText.lineLoginIsNotAnEmailAddress(line, login)); continue; }
    const p: PersonInput = { login, display_name };
    const employee = get("employee_id"), department = get("department"), manager = get("manager_login").toLowerCase(), role = get("role");
    if (manager && !MAIL_RE.test(manager)) { errors.push(parserText.lineManagerMustBeTheManagerS(line, get("manager_login"))); continue; }
    if (manager && manager === login) { errors.push(parserText.lineManagerLoginRefersToThePerson(line)); continue; }
    if (employee) p.employee_id = employee;
    if (department) p.department = department;
    if (manager) p.manager_login = manager;
    if (role) p.role = role;
    const attrs: NonNullable<PersonInput["attrs"]> = {};
    const code = get("department_code"), parent = get("parent_department_code");
    if (code) attrs.department_code = code;
    if (parent) attrs.parent_department_code = parent;
    const relRaw = get("unit_relation").toLowerCase(), rel = RELATIONS[relRaw];
    if (relRaw && !rel) { errors.push(parserText.lineUnitRelationMustBeHeadDeputy(line, relRaw)); continue; }
    if (rel === "head" || rel === "deputy") attrs.unit_relation = rel;
    const given = get("given_name").replace(/\s+/g, " ");
    if (given.length > 100) { errors.push(parserText.lineGivenNameMustBeNoLonger(line)); continue; }
    if (CLEAR_MARKS.has(given)) attrs.given_name = null;
    else if (given) attrs.given_name = given;
    if (Object.keys(attrs).length) p.attrs = attrs;
    const active = get("active").toLowerCase();
    if (active) {
      if (TRUE.has(active)) p.active = true;
      else if (FALSE.has(active)) p.active = false;
      else { errors.push(parserText.lineActiveMustBeYesNoReceived(line, active)); continue; }
    }
    people.push(p); lines.push(line);
  }
  const last = keepLastOfLogin(people, lines, false);
  warnings.push(...last.warnings);
  errors.push(...employeeRepeats(last.people, last.lines, false));
  if (!last.people.length && !errors.length) errors.push(parserText.noPeopleRowsInTheCSV);
  return { format: "csv", body: errors.length ? null : { people: last.people }, rows: table.length - 1, errors, warnings: [...new Set(warnings)], lines: errors.length ? [] : last.lines };
}

function parseJsonList<T>(text: string, field: string, check: (row: Record<string, unknown>, n: number) => string | null): { list: T[] | null; extra: Record<string, unknown>; errors: string[] } {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { return { list: null, extra: {}, errors: [parserText.invalidJSON((e as Error).message)] }; }
  const extra = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const list = Array.isArray(data) ? data : extra[field];
  if (!Array.isArray(list)) return { list: null, extra, errors: [parserText.expectedAnObjectContainingAArrayOr(field)] };
  if (list.length > PEOPLE_MAX_ROWS) return { list: null, extra, errors: [parserText.moreThanElementsTooManyForOne(formatCount(PEOPLE_MAX_ROWS))] };
  const errors: string[] = [];
  list.forEach((row, n) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) { errors.push(parserText.elementExpectedAnObject(n + 1)); return; }
    const msg = check(row as Record<string, unknown>, n);
    if (msg) errors.push(parserText.elementText(n + 1, msg));
  });
  if (!list.length) errors.push(parserText.arrayIsEmpty(field));
  return { list: errors.length ? null : (list as T[]), extra, errors: errors.slice(0, 50) };
}

export { parserText as PEOPLE_CSV_TEXT } from "../messages/people-csv";

export function parsePeopleUpload(text: string): ParsedUpload<PeopleBody> {
  const t = text.trim();
  if (!t) return { format: "empty", body: null, rows: 0, errors: [parserText.pasteJSONOrCSV], warnings: [], lines: [] };
  if (t[0] !== "{" && t[0] !== "[") return peopleFromCsv(text);
  const { list, extra, errors } = parseJsonList<PersonInput>(t, "people", (r) =>
    !(typeof r.login === "string" && r.login.trim() && typeof r.display_name === "string" && r.display_name.trim()) ? parserText.loginAndDisplayNameAreRequired : givenNameProblem(r.attrs));
  const warnings = extra.deactivate_missing !== undefined && extra.deactivate_missing !== false ? [parserText.theTextContainsADeactivateMissingMarker] : [];
  if (!list) return { format: "json", body: null, rows: 0, errors, warnings, lines: [] };
  const last = keepLastOfLogin(list, list.map((_, i) => i + 1), true);
  const repeats = employeeRepeats(last.people, last.lines, true);
  warnings.push(...last.warnings);
  if (repeats.length) return { format: "json", body: null, rows: list.length, errors: repeats, warnings, lines: [] };
  return { format: "json", body: { people: last.people }, rows: list.length, errors, warnings, lines: last.lines };
}

export interface OrgUnitInput { code: string; name: string; parent_code?: string | null; head_login?: string | null; active?: boolean }
export interface OrgUnitsBody { org_units: OrgUnitInput[] }

export function parseOrgUnitsUpload(text: string): ParsedUpload<OrgUnitsBody> {
  const t = text.trim();
  if (!t) return { format: "empty", body: null, rows: 0, errors: [parserText.pasteJSON], warnings: [], lines: [] };
  const { list, errors } = parseJsonList<OrgUnitInput>(t, "org_units", (r) =>
    typeof r.code === "string" && r.code.trim() && typeof r.name === "string" && r.name.trim() ? null : parserText.codeAndNameAreRequired);
  return { format: "json", body: list ? { org_units: list } : null, rows: list?.length ?? 0, errors, warnings: [], lines: list ? list.map((_, i) => i + 1) : [] };
}
