import { fallbackTz, tzValid, WALL_TIME } from "./zoned-time.ts";

export type RuDateRole = "due" | "as_of";

export interface RuDateOptions {
  role: RuDateRole;
  tz?: string;
}

export type RuDateMiss = "empty" | "anchor" | "too_long" | "no_date" | "vague" | "open" | "conflict" | "invalid" | "recurring" | "past";

export interface RuDateExplain {
  date: string | null;
  rules: string[];
  miss: RuDateMiss | null;
}

export const RU_DATE_MAX_TEXT = 200;

export function explainRuDate(text: string | null | undefined, anchor: string | number | Date, opts: RuDateOptions): RuDateExplain {
  if (typeof text !== "string" || !text.trim()) return miss("empty");
  if (text.length > RU_DATE_MAX_TEXT) return miss("too_long");
  const tz = tzValid(opts.tz) ? opts.tz : fallbackTz();
  const a = anchorDay(anchor, tz);
  if (a === null) return miss("anchor");
  return resolve(normalize(text), { a, role: opts.role === "as_of" ? "as_of" : "due" });
}

export function resolveRuDate(text: string | null | undefined, anchor: string | number | Date, opts: RuDateOptions): string | null {
  return explainRuDate(text, anchor, opts).date;
}

const DAY_MS = 86_400_000;
const HALF_YEAR = 183;
const dnOf = (y: number, m: number, d: number): number | null => {
  if (![y, m, d].every(Number.isInteger) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.getTime() / DAY_MS : null;
};
const ymdOf = (dn: number) => { const t = new Date(dn * DAY_MS); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const isoOf = (dn: number) => new Date(dn * DAY_MS).toISOString().slice(0, 10);
const isoDow = (dn: number) => ((new Date(dn * DAY_MS).getUTCDay() + 6) % 7) + 1;
const weekMon = (dn: number) => dn - (isoDow(dn) - 1);
const monthStart = (y: number, m: number) => Date.UTC(y, m - 1, 1) / DAY_MS;
const monthEnd = (y: number, m: number) => Date.UTC(y, m, 0) / DAY_MS;
const monthAt = (dn: number, k: number) => { const { y, m } = ymdOf(dn); const t = new Date(Date.UTC(y, m - 1 + k, 1)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 }; };
const addMonths = (dn: number, n: number) => { const { d } = ymdOf(dn); const { y, m } = monthAt(dn, n); return Math.min(monthStart(y, m) + d - 1, monthEnd(y, m)); };

/** Day of the anchor in the zone, as days since 1970-01-01; null when the anchor cannot be read. */
export function anchorDay(anchor: string | number | Date, tz: string): number | null {
  let str: string | null = null;
  if (typeof anchor === "string") {
    const s = anchor.trim().replace(/^(\d{4}-\d{2}-\d{2}) (?=\d{2}:\d{2})/, "$1T").replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})$/, "$1$2:00");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) || WALL_TIME.test(s)) return dnOf(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)));
    if (!/(?:z|gmt|utc|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
    str = s;
  }
  const t = anchor instanceof Date ? anchor.getTime() : typeof anchor === "number" ? anchor : str !== null ? Date.parse(str) : NaN;
  if (!Number.isFinite(t)) return null;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(t));
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
  return dnOf(g("year"), g("month"), g("day"));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е")
    .replace(/[     \t\r\n]/g, " ")
    .replace(/[‐-―−]/g, "-")
    .replace(/[«»"“”„()[\]]/g, " ")
    .replace(/\s+/g, " ").trim();
}

interface Ctx { a: number; role: RuDateRole }
type WdMod = "next" | "this" | "prev" | null;
type Found =
  | { k: "iv"; from: number; to: number; rule: string; ny?: boolean; nd?: boolean }
  | { k: "wd"; dow: number; mod: WdMod; rule: string }
  | { k: "weak"; rule: string }
  | { k: "bad"; why: "invalid" | "conflict" | "recurring"; rule: string }
  | { k: "none" };
type Mention = Exclude<Found, { k: "none" }> & { s: number; e: number; open?: boolean };

const point = (dn: number, rule: string): Found => ({ k: "iv", from: dn, to: dn, rule });
const span = (from: number, to: number, rule: string): Found => (from <= to ? { k: "iv", from, to, rule } : { k: "bad", why: "conflict", rule });
const invalid = (rule: string): Found => ({ k: "bad", why: "invalid", rule });

function pickYear(c: Ctx, from: number, to: number, y0: number): number {
  if (c.role === "due" && to < c.a - HALF_YEAR) return y0 + 1;
  if (c.role === "as_of" && from > c.a + HALF_YEAR) return y0 - 1;
  return y0;
}
function placed(c: Ctx, rule: string, year: number | null, build: (y: number) => [number, number], base: (y: number) => number): Found {
  if (year !== null) { const r = build(year); return span(r[0], r[1], rule); }
  const y0 = ymdOf(c.a).y;
  const y = c.role === "due" ? (base(y0) < c.a - HALF_YEAR ? y0 + 1 : y0) : (build(y0)[0] > c.a + HALF_YEAR ? y0 - 1 : y0);
  const r = build(y), f = span(r[0], r[1], rule);
  return f.k === "iv" ? { ...f, ny: true, nd: true } : f;
}
function dayPlaced(c: Ctx, rule: string, year: number | null, mo: number, d1: number, d2 = d1): Found {
  let y = year;
  if (y === null) {
    const y0 = ymdOf(c.a).y, clamp = (d: number) => Math.min(monthStart(y0, mo) + d - 1, monthEnd(y0, mo));
    y = pickYear(c, clamp(d1), clamp(d2), y0);
  }
  const f = dnOf(y, mo, d1), t = dnOf(y, mo, d2);
  if (f === null || t === null) return invalid(rule);
  const r = span(f, t, rule);
  return r.k === "iv" && year === null ? { ...r, ny: true } : r;
}
const yearOf = (s: string | undefined): number | null => (s ? (s.length === 2 ? 2000 + Number(s) : Number(s)) : null);
const rel = (w: string | undefined) => (!w ? 0 : /^(след|буд)/.test(w) ? 1 : w.startsWith("прош") ? -1 : 0);

const MONTH_PREFIX: Array<[string, number]> = [["янв", 1], ["фев", 2], ["мар", 3], ["апр", 4], ["ма", 5], ["июн", 6], ["июл", 7], ["авг", 8], ["сен", 9], ["окт", 10], ["ноя", 11], ["дек", 12]];
const monthNum = (w: string) => MONTH_PREFIX.find(([p]) => w.startsWith(p))?.[1] ?? 0;

const ORD_STEMS: Array<[string, number]> = ([["перв", 1], ["втор", 2], ["трет", 3], ["четверт", 4], ["пят", 5], ["шест", 6], ["седьм", 7], ["восьм", 8], ["девят", 9],
  ["десят", 10], ["одиннадцат", 11], ["двенадцат", 12], ["тринадцат", 13], ["четырнадцат", 14], ["пятнадцат", 15], ["шестнадцат", 16], ["семнадцат", 17],
  ["восемнадцат", 18], ["девятнадцат", 19], ["двадцат", 20], ["тридцат", 30]] as Array<[string, number]>).sort((x, y) => y[0].length - x[0].length);
const ordStem = (w: string) => ORD_STEMS.find(([p]) => w.startsWith(p))?.[1] ?? NaN;
const ordValue = (w: string) => { const m = /^(двадцать|тридцать)\s+(.+)$/.exec(w); return m ? (m[1] === "двадцать" ? 20 : 30) + ordStem(m[2]!) : ordStem(w); };
const dayValue = (w: string) => (/^\d+$/.test(w) ? Number(w) : ordValue(w));

const NUM_WORDS: Record<string, number> = { одну: 1, один: 1, одного: 1, два: 2, две: 2, двух: 2, пару: 2, пары: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5,
  шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10 };
const numOf = (w: string | undefined) => (w === undefined ? 1 : /^\d+$/.test(w) ? Number(w) : NUM_WORDS[w] ?? NaN);
function shift(dn: number, n: number, unit: string): number {
  if (unit.startsWith("д")) return dn + n;
  if (unit.startsWith("н")) return dn + 7 * n;
  if (unit.startsWith("м")) return addMonths(dn, n);
  return addMonths(dn, 12 * n);
}

const DOW_PREFIX: Array<[string, number]> = [["понедельник", 1], ["вторник", 2], ["сред", 3], ["четверг", 4], ["пятниц", 5], ["суббот", 6], ["воскресень", 7]];
const dowOf = (w: string) => DOW_PREFIX.find(([p]) => w.startsWith(p))?.[1] ?? 0;
const modOf = (w: string | undefined): WdMod => (!w ? null : /^(след|буд)/.test(w) ? "next" : w.startsWith("прош") ? "prev" : "this");

function resolveWd(dow: number, mod: WdMod, c: Ctx): number {
  const ad = isoDow(c.a);
  if (mod === "next") return weekMon(c.a) + 7 + dow - 1;
  if (mod === "prev") return weekMon(c.a) - 7 + dow - 1;
  if (mod === "this") return c.a + ((dow - ad + 7) % 7);
  return c.role === "due" ? c.a + (((dow - ad + 7) % 7) || 7) : c.a - ((ad - dow + 7) % 7);
}

const B = "(?<![0-9a-zа-я])";
const E = "(?![0-9a-zа-я])";
const MONTH_GEN = "(январ[ьяю]|феврал[ьяю]|март[ау]?|апрел[ьяю]|ма[йяю]|июн[ьяю]|июл[ьяю]|август[ау]?|сентябр[ьяю]|октябр[ьяю]|ноябр[ьяю]|декабр[ьяю]|янв|фев|мар|апр|июн|июл|авг|сент|сен|окт|нояб|ноя|дек)\\.?";
const MONTH_ANY = "(январ[ьяею]|феврал[ьяею]|март[аеу]?|апрел[ьяею]|ма[йяею]|июн[ьяею]|июл[ьяею]|август[аеу]?|сентябр[ьяею]|октябр[ьяею]|ноябр[ьяею]|декабр[ьяею])";
const YEAR_TAIL = "(?:\\s+(\\d{4})(?:\\s*(?:г\\.?|года?))?)?";
const DSUF = "(?:-?(?:ого|ому|го|му|ое|е))?";
const ORD_END = "(?:ьего|ьему|ого|ому|ое|ый|ой|ье|ий)";
const ORD_UNITS = "перв|втор|трет|четверт|пят|шест|седьм|восьм|девят";
const ORD = `(?:(?:двадцать|тридцать)\\s+(?:${ORD_UNITS})${ORD_END}|(?:${ORD_STEMS.map(([s]) => s).join("|")})${ORD_END})`;
const NUM = `(\\d{1,3}|${Object.keys(NUM_WORDS).join("|")})`;
const UNIT = "(дней|дня|день|недели|неделю|недель|неделя|месяцев|месяца|месяц|года|год|лет)";
const WEEK_REL = "(этой\\s+же|этой|текущей|следующей|будущей|прошлой)";
const MONTH_REL = "(этого|текущего|следующего|будущего|прошлого)";
const PERIOD_REL = "(этом|текущем|следующем|будущем|прошлом)";
const QUARTER_N = "(1|2|3|4|iv|iii|ii|i|первом|втором|третьем|четвертом|первого|второго|третьего|четвертого|первому|второму|третьему|четвертому)(?:-?(?:м|го|му|й))?";
const quarterN = (w: string) => ({ i: 1, ii: 2, iii: 3, iv: 4 } as Record<string, number>)[w] ?? (/^\d$/.test(w) ? Number(w) : ordStem(w));
const quarterOf = (m: number) => Math.ceil(m / 3);
const quarterIv = (y: number, q: number): [number, number] => [monthStart(y, 3 * q - 2), monthEnd(y, 3 * q)];
const quarterAt = (dn: number, k: number) => { const { y, m } = ymdOf(dn); const t = new Date(Date.UTC(y, 3 * (quarterOf(m) - 1) + 3 * k, 1)); return quarterIv(t.getUTCFullYear(), quarterOf(t.getUTCMonth() + 1)); };
const PARTS: Record<string, [number, number | "end"]> = { начале: [1, 10], середине: [11, 20], конце: [21, "end"], "первой половине": [1, 15], "второй половине": [16, "end"] };
const partIv = (y: number, m: number, part: string): [number, number] => { const [f, t] = PARTS[part]!; return [monthStart(y, m) + f - 1, t === "end" ? monthEnd(y, m) : monthStart(y, m) + t - 1]; };
const edgeDay = (y: number, m: number, w: string) => (w.startsWith("конц") ? monthEnd(y, m) : w.startsWith("середин") ? monthStart(y, m) + 14 : monthStart(y, m));
const DOW_ANY = "(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)[а-я]*";
const WD_MOD = "(следующ[а-я]*|будущ[а-я]*|эт(?:у|от|о|а|ой)|ближайш[а-я]*|текущ[а-я]*|прошл[а-я]*)";
const WED_MOD = "(следующ[а-я]*|будущ[а-я]*|эт(?:у|от|о|а|ой)|ближайш[а-я]*|прошл[а-я]*)";
const wed = (mod: string | undefined): Found => ({ k: "wd", dow: 3, mod: modOf(mod), rule: "weekday" });
const hoursWeak = (num: string | undefined, unit: string): Found | null =>
  (unit.startsWith("час") && !(numOf(num) <= 10) ? null : { k: "weak", rule: "today_weak" });
const NOT_DATE_BEFORE = `(?<!(?:${B}(?:v|п|пп|ст|разд|гл|рис|табл|вер)\\.?|${B}(?:верси|релиз|пункт|подпункт|раздел|этап|шаг|глав|стать|таблиц|рисун|приложени|сборк|спринт|version|release|build)[a-zа-я]*\\.?)\\s*)`;

interface Pattern { re: RegExp; f: (m: RegExpMatchArray, c: Ctx) => Found | null }
const P = (src: string, f: Pattern["f"]): Pattern => ({ re: new RegExp(src, "g"), f });

const PATTERNS: Pattern[] = [
  P(`${B}через\\s+(?:${NUM}\\s+)?(час(?:а|ов)?|минут[уы]?|полчаса)${E}`, (m) => hoursWeak(m[1], m[2]!)),
  P(`${B}в\\s+течение\\s+(?:${NUM}\\s+)?(часа|часов|минут|получаса)${E}`, (m) => hoursWeak(m[1], m[2]!)),
  P(`${B}\\d{1,2}:\\d{2}${E}`, () => ({ k: "none" })),
  P(`${B}\\d{1,2}\\s*час(?:а|ов)?${E}`, () => ({ k: "none" })),
  P(`${B}\\d{1,2}\\s+(?:утра|вечера|ночи)${E}`, () => ({ k: "none" })),
  P(`${B}до\\s+конца\\s+(?:рабочего\\s+|этого\\s+|текущего\\s+)?(?:дня|часа)${E}`, () => ({ k: "weak", rule: "today_weak" })),
  P(`${B}в\\s+течение\\s+(?:этого\\s+|рабочего\\s+)?(?:дня|часа|получаса)${E}`, () => ({ k: "weak", rule: "today_weak" })),
  P(`${B}(?:до|к|после|перед)\\s+обед(?:а|у|ом)?${E}`, () => ({ k: "weak", rule: "today_weak" })),
  P(`${B}(?:в\\s+|во\\s+)?(?:первой|второй|первая|вторая|первую|вторую)\\s+половин(?:е|а|у|ы)\\s+дня${E}`, () => ({ k: "weak", rule: "today_weak" })),
  P(`${B}(?:вечером|днем|к\\s+вечеру|до\\s+вечера|в\\s+обед)${E}`, () => ({ k: "weak", rule: "today_weak" })),
  P(`${B}(?:прямо\\s+)?сейчас(?:\\s+же)?${E}`, () => ({ k: "weak", rule: "today_weak" })),
  P(`${B}(?:немедленно|сразу(?:\\s+же)?|тотчас)${E}`, () => ({ k: "weak", rule: "today_weak" })),
  P(`${B}(?:утром|с\\s+утра|к\\s+утру|до\\s+утра|ночью|к\\s+ночи)${E}`, () => ({ k: "none" })),
  P(`${B}(?:кажд[а-я]*\\s+(?:${NUM}\\s+)?(?:${DOW_ANY}|день|дня|дней|утро|вечер|недел[а-я]*|месяц[а-я]*|квартал[а-я]*|год|года|лет|раз|\\d{1,2}(?:-?(?:е|го|ое))?)`
    + `|по\\s+(?:понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям|будням|выходным|утрам|вечерам)`
    + `|еже(?:дневн|недельн|месячн|квартальн|годн)[а-я]*`
    + `|(?:(?:${NUM}\\s+)?раза?|дважды|трижды)\\s+в\\s+(?:${NUM}\\s+)?(?:день|дня|дней|неделю|недели|недель|месяц[а-я]*|квартал[а-я]*|год|года|лет))${E}`,
    () => ({ k: "bad", why: "recurring", rule: "recurring" })),

  // ISO: 2026-09-30
  P(`${B}(\\d{4})-(\\d{2})-(\\d{2})${E}`, (m) => { const dn = dnOf(Number(m[1]), Number(m[2]), Number(m[3])); return dn === null ? invalid("iso") : point(dn, "iso"); }),
  P(`${B}(\\d{1,2})${DSUF}\\s*,?\\s*(?:или|либо)\\s+(?:(?:до|к|по|на)\\s+)?(\\d{1,2})${DSUF}\\s+${MONTH_GEN}${YEAR_TAIL}${E}`, () => ({ k: "bad", why: "conflict", rule: "alternative" })),
  P(`${B}(?:с\\s+|со\\s+)?(\\d{1,2})${DSUF}\\s*(?:-|по|до)\\s*(\\d{1,2})${DSUF}\\s+${MONTH_GEN}${YEAR_TAIL}${E}`, (m, c) => {
    const d1 = Number(m[1]), d2 = Number(m[2]), mo = monthNum(m[3]!);
    if (d1 > d2) return { k: "bad", why: "conflict", rule: "range" };
    return dayPlaced(c, "range", yearOf(m[4]), mo, d1, d2);
  }),
  P(`${B}(\\d{1,2}|${ORD})${DSUF}\\s+${MONTH_GEN}${YEAR_TAIL}${E}`, (m, c) => {
    return dayPlaced(c, "day_month", yearOf(m[3]), monthNum(m[2]!), dayValue(m[1]!));
  }),
  P(`(?<![\\d.:])${NOT_DATE_BEFORE}(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?(?![\\d:])(?!\\.\\d)`, (m, c) => {
    const d = Number(m[1]), mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return dayPlaced(c, "numeric", yearOf(m[3]), mo, d);
  }),
  P(`${B}(?:до|к|по)\\s+(конца|концу|середины|середине|начала|началу)\\s+${MONTH_ANY}${YEAR_TAIL}${E}`, (m, c) => {
    const mo = monthNum(m[2]!);
    return placed(c, "month_edge", yearOf(m[3]), (y) => { const dn = edgeDay(y, mo, m[1]!); return [dn, dn]; }, (y) => monthStart(y, mo));
  }),
  P(`${B}(?:(?:в|во)\\s+)?(начале|середине|конце|первой\\s+половине|второй\\s+половине)\\s+${MONTH_ANY}${YEAR_TAIL}${E}`, (m, c) => {
    const mo = monthNum(m[2]!), part = m[1]!.replace(/\s+/g, " ");
    return placed(c, "month_part", yearOf(m[3]), (y) => partIv(y, mo, part), (y) => monthStart(y, mo));
  }),
  P(`${B}(?:(в\\s+течение|в|во|к|до|на|по|с|со)\\s+)?${MONTH_ANY}${YEAR_TAIL}${E}`, (m, c) => {
    const prep = (m[1] ?? "").replace(/\s+/g, " "), mo = monthNum(m[2]!);
    return placed(c, "month", yearOf(m[3]), (y) => {
      if (prep === "к" || prep === "до" || prep === "с" || prep === "со") return [monthStart(y, mo), monthStart(y, mo)];
      if (prep === "по") return [monthEnd(y, mo), monthEnd(y, mo)];
      return [monthStart(y, mo), monthEnd(y, mo)];
    }, (y) => monthStart(y, mo));
  }),

  P(`${B}(?:до|к|по)\\s+конц[ау]\\s+(?:(этого|текущего|следующего|будущего)\\s+)?квартала${E}`, (m, c) => point(quarterAt(c.a, rel(m[1]))[1], "quarter")),
  P(`${B}(?:в\\s+)?конце\\s+(?:(этого|текущего|следующего|будущего)\\s+)?квартала${E}`, (m, c) => point(quarterAt(c.a, rel(m[1]))[1], "quarter")),
  P(`${B}(?:в|во|на)\\s+${PERIOD_REL}\\s+квартале${E}`, (m, c) => { const [f, t] = quarterAt(c.a, rel(m[1])); return span(f, t, "quarter"); }),
  P(`${B}(?:до|к|по)\\s+конц[ау]\\s+${QUARTER_N}\\s+квартала${YEAR_TAIL}${E}`, (m, c) => {
    const q = quarterN(m[1]!);
    return placed(c, "quarter", yearOf(m[2]), (y) => { const [, t] = quarterIv(y, q); return [t, t]; }, (y) => quarterIv(y, q)[0]);
  }),
  P(`${B}(в|во|до|к)\\s+${QUARTER_N}\\s+квартал(?:е|а|у)?${YEAR_TAIL}${E}`, (m, c) => {
    const q = quarterN(m[2]!), edge = m[1] === "до" || m[1] === "к";
    return placed(c, "quarter", yearOf(m[3]), (y) => { const [f, t] = quarterIv(y, q); return edge ? [f, f] : [f, t]; }, (y) => quarterIv(y, q)[0]);
  }),
  P(`${B}(?:до|к|по)\\s+конц[ау]\\s+(?:(этого|текущего|следующего|будущего)\\s+)?года${E}`, (m, c) => { const y = ymdOf(c.a).y + rel(m[1]); return point(monthEnd(y, 12), "year"); }),
  P(`${B}(?:до|к|по)\\s+конц[ау]\\s+(\\d{4})(?:\\s*(?:г\\.?|года))?${E}`, (m) => point(monthEnd(Number(m[1]), 12), "year")),
  P(`${B}(?:в\\s+)?конце\\s+(?:(этого|текущего|следующего|будущего)\\s+)?года${E}`, (m, c) => { const y = ymdOf(c.a).y + rel(m[1]); return span(monthStart(y, 12), monthEnd(y, 12), "year"); }),
  P(`${B}(?:в\\s+)?конце\\s+(\\d{4})(?:\\s*(?:г\\.?|года))?${E}`, (m) => span(monthStart(Number(m[1]), 12), monthEnd(Number(m[1]), 12), "year")),
  P(`${B}(?:в|на)\\s+${PERIOD_REL}\\s+году${E}`, (m, c) => { const y = ymdOf(c.a).y + rel(m[1]); return span(monthStart(y, 1), monthEnd(y, 12), "year"); }),
  P(`${B}(в|во|до|к|с|со)\\s+(\\d{4})\\s*(?:г\\.?|году|года|год)${E}`, (m) => {
    const y = Number(m[2]);
    return m[1] === "в" || m[1] === "во" ? span(monthStart(y, 1), monthEnd(y, 12), "year") : point(monthStart(y, 1), "year");
  }),
  P(`${B}(?:до|к|на)\\s+нов(?:ого|ому|ый)\\s+год(?:а|у)?${E}`, (_m, c) => point(monthEnd(ymdOf(c.a).y, 12), "new_year")),
  P(`${B}(?:до|к|по)\\s+конц[ау]\\s+(?:этого\\s+|текущего\\s+)?полугодия${E}`, (_m, c) => { const { y, m } = ymdOf(c.a); return point(monthEnd(y, m <= 6 ? 6 : 12), "half_year"); }),

  P(`${B}(?:до|к|по)\\s+конц[ау]\\s+(?:${WEEK_REL}\\s+)?(рабочей\\s+)?недели${E}`, (m, c) => {
    const mon = weekMon(c.a) + 7 * rel(m[1]);
    if (!m[2]) return point(mon + 6, "week");
    return point(m[1] || isoDow(c.a) <= 5 ? mon + 4 : mon + 11, "week");
  }),
  P(`${B}(?:в\\s+)?(конце|начале|середине)\\s+(?:${WEEK_REL}\\s+)?недели${E}`, (m, c) => {
    const mon = weekMon(c.a) + 7 * rel(m[2]);
    const [f, t] = m[1] === "конце" ? [4, 6] : m[1] === "начале" ? [0, 1] : [2, 3];
    return span(mon + f, mon + t, "week");
  }),
  P(`${B}(?:с|со|к|до)\\s+(?:следующей|будущей)\\s+недел[иеюя]${E}`, (_m, c) => point(weekMon(c.a) + 7, "week")),
  P(`${B}(?:на|в\\s+течение|в)\\s+${WEEK_REL}\\s+недел[еи]${E}`, (m, c) => { const mon = weekMon(c.a) + 7 * rel(m[1]); return span(mon, mon + 6, "week"); }),
  P(`${B}на\\s+неделе${E}`, (_m, c) => span(weekMon(c.a), weekMon(c.a) + 6, "week")),
  P(`${B}(?:в|на)\\s+(?:(эти|ближайшие|следующие|будущие|прошлые)\\s+)?выходн(?:ые|ых)${E}`, (m, c) => {
    const mon = weekMon(c.a) + 7 * rel(m[1]);
    return span(mon + 5, mon + 6, "week");
  }),

  P(`${B}(?:до|к|по)\\s+(конца|концу|середины|середине|начала|началу)\\s+(?:${MONTH_REL}\\s+)?месяца${E}`, (m, c) => {
    const { y, m: mo } = monthAt(c.a, rel(m[2]));
    return point(edgeDay(y, mo, m[1]!), "month_rel");
  }),
  P(`${B}(?:в\\s+)?(начале|середине|конце|первой\\s+половине|второй\\s+половине)\\s+(?:${MONTH_REL}\\s+)?месяца${E}`, (m, c) => {
    const { y, m: mo } = monthAt(c.a, rel(m[2]));
    const [f, t] = partIv(y, mo, m[1]!.replace(/\s+/g, " "));
    return span(f, t, "month_rel");
  }),
  P(`${B}(?:в|на)\\s+${PERIOD_REL}\\s+месяце${E}`, (m, c) => { const { y, m: mo } = monthAt(c.a, rel(m[1])); return span(monthStart(y, mo), monthEnd(y, mo), "month_rel"); }),
  P(`${B}(?:(?:с|со|до)\\s+(?:следующего|будущего)\\s+месяца|к\\s+(?:следующему|будущему)\\s+месяцу)${E}`, (_m, c) => { const { y, m } = monthAt(c.a, 1); return point(monthStart(y, m), "month_rel"); }),

  P(`${B}через\\s+(?:${NUM}\\s+)?${UNIT}${E}`, (m, c) => { const n = numOf(m[1]); return Number.isFinite(n) ? point(shift(c.a, n, m[2]!), "shift") : null; }),
  P(`${B}в\\s+течение\\s+(?:${NUM}\\s+)?${UNIT}${E}`, (m, c) => { const n = numOf(m[1]); return Number.isFinite(n) ? span(c.a, shift(c.a, n, m[2]!), "shift") : null; }),
  P(`${B}(?:${NUM}\\s+)?${UNIT}\\s+(?:тому\\s+)?назад${E}`, (m, c) => { const n = numOf(m[1]); return Number.isFinite(n) ? point(shift(c.a, -n, m[2]!), "shift") : null; }),

  P(`${B}(послезавтра|позавчера|завтра|вчера|сегодня)(?:шн[а-я]*)?${E}`, (m, c) => {
    const k: Record<string, number> = { послезавтра: 2, позавчера: -2, завтра: 1, вчера: -1, сегодня: 0 };
    return point(c.a + k[m[1]!]!, "relative_day");
  }),
  P(`${B}(?:(?:в|во|к|до|на|с|со|по)\\s+)?(?:${WD_MOD}\\s+)?(понедельник[а-я]*|вторник[а-я]*|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*)${E}`,
    (m) => ({ k: "wd", dow: dowOf(m[2]!), mod: modOf(m[1]), rule: "weekday" })),
  P(`${B}(?:(?:в|во|на|по)\\s+(?:${WED_MOD}\\s+)?|${WED_MOD}\\s+)среду${E}`, (m) => wed(m[1] ?? m[2])),
  P(`${B}(?:(?:до|с|со)\\s+(?:${WED_MOD}\\s+)?|${WED_MOD}\\s+)среды${E}`, (m) => wed(m[1] ?? m[2])),
  P(`(?<=${B}(?:после|позже|позднее|ранее|раньше)\\s+)(?:${WED_MOD}\\s+)?среды${E}`, (m) => wed(m[1])),
  P(`${B}к\\s+(?:${WED_MOD}\\s+)?среде${E}`, (m) => wed(m[1])),
  P(`(?<=${B}перед\\s+)(?:${WED_MOD}\\s+)?средой${E}`, (m) => wed(m[1])),
  P(`${B}${WED_MOD}\\s+среда${E}`, (m) => wed(m[1])),
  P(`(?<=(?:^|[,.;:!?-])\\s*)среда(?=\\s*(?:$|[,.;:!?-]|\\d))`, () => wed(undefined)),
  P(`${B}(?:(?:до|к|по|на|с|со)\\s+)?(\\d{1,2})-?(?:ого|ому|го|му|ое|е)(?=\\s*(?:$|[,.;:!?]|числ|(?:или|либо)${E}))`, (m, c) => dayOfMonth(Number(m[1]), c)),
  P(`${B}(\\d{1,2})\\s+числ(?:а|о|у)${E}`, (m, c) => dayOfMonth(Number(m[1]), c)),
  P(`${B}(?:до|к|по|на|с|со)\\s+(${ORD})(?=\\s*(?:$|[,.;:!?]|числ|(?:или|либо)${E}))`, (m, c) => dayOfMonth(ordValue(m[1]!), c)),
  P(`${B}(${ORD})\\s+числ(?:а|о|у)${E}`, (m, c) => dayOfMonth(ordValue(m[1]!), c)),
];

function dayOfMonth(d: number, c: Ctx): Found {
  const { y, m, d: ad } = ymdOf(c.a);
  const k = c.role === "due" ? (d >= ad ? 0 : 1) : (d <= ad ? 0 : -1);
  const { y: yy, m: mm } = monthAt(monthStart(y, m), k);
  const dn = dnOf(yy, mm, d);
  return dn === null ? invalid("day_of_month") : point(dn, "day_of_month");
}

const VAGUE = new RegExp(`${B}(?:весн[а-я]*|лет(?:ом|а|о|у|ний|нее|него)|осен[а-я]*|зим[а-я]*|срочно|быстро|скоро|оперативно|как\\s+можно\\s+(?:скорее|быстрее|раньше)|в\\s+ближайшее\\s+время|в\\s+ближайшие\\s+дни|на\\s+днях|потом|позже|позднее|когда-нибудь|несколько|утром|с\\s+утра|к\\s+утру|до\\s+утра|ночью|asap)${E}`);
const EVENT = new RegExp(`${B}(?:после|перед|по\\s+итогам|по\\s+результатам|как\\s+только|когда)${E}`);
const PREFIX = /(?:^|[^0-9a-zа-я])((?:не\s+)?(?:после|позже|позднее|ранее|раньше|перед))\s*(?:,\s*)?(?:чем\s*)?$/;
const OPEN_WORDS = new Set(["после", "позже", "позднее", "не ранее", "не раньше"]);
const SUFFIX_OPEN = /^\s*,?\s*(?:или|и|либо)\s+(?:позже|позднее)(?![0-9a-zа-я])/;
const ALT = /(?:^|[^0-9a-zа-я])(?:или|либо)(?![0-9a-zа-я])/;

function resolve(norm: string, c: Ctx): RuDateExplain {
  let work = norm;
  const blank = (s: number, e: number) => { work = work.slice(0, s) + " ".repeat(e - s) + work.slice(e); };
  const found: Mention[] = [];
  for (const p of PATTERNS) {
    const hits: Array<[number, number]> = [];
    for (const m of work.matchAll(p.re)) {
      const f = p.f(m, c);
      if (!f) continue;
      const s = m.index!, e = s + m[0].length;
      hits.push([s, e]);
      if (f.k !== "none") found.push({ ...f, s, e });
    }
    for (const [s, e] of hits) blank(s, e);
  }
  for (const m of found) {
    if (m.k === "weak") continue;
    const from = Math.max(0, m.s - 24), pm = PREFIX.exec(work.slice(from, m.s));
    if (pm) {
      if (OPEN_WORDS.has(pm[1]!.replace(/\s+/g, " "))) m.open = true;
      blank(from + pm.index + pm[0].indexOf(pm[1]!), m.s);
    }
    const sm = SUFFIX_OPEN.exec(work.slice(m.e));
    if (sm) { m.open = true; blank(m.e, m.e + sm[0].length); }
  }
  const openSeen = found.some((m) => m.open);
  const fromEvent = EVENT.test(work);
  const live = found.filter((m) => !m.open && !((fromEvent || openSeen) && m.k === "weak")).sort((x, y) => x.s - y.s);
  const bad = live.find((m) => m.k === "bad");
  if (bad && bad.k === "bad") return miss(bad.why, [bad.rule]);
  const dated = live.filter((m) => m.k === "iv" || m.k === "wd");
  for (let i = 0; i + 1 < dated.length; i++)
    if (ALT.test(norm.slice(dated[i]!.e, dated[i + 1]!.s))) return miss("conflict", [...rulesOf(live), "alternative"]);
  const merged = joinRanges(live, norm, c);
  const badRange = merged.find((m) => m.k === "bad");
  if (badRange && badRange.k === "bad") return miss(badRange.why, rulesOf(merged));
  const ivs = merged.filter((m): m is Extract<Mention, { k: "iv" }> => m.k === "iv");
  const wds = merged.filter((m): m is Extract<Mention, { k: "wd" }> => m.k === "wd");
  const rules = rulesOf(merged);
  if (!ivs.length && !wds.length) {
    if (merged.some((m) => m.k === "weak")) return ok(c.a, c.a, c, rules);
    return miss(openSeen || fromEvent ? "open" : VAGUE.test(norm) ? "vague" : "no_date", rules);
  }
  const done = (f: number, t: number): RuDateExplain =>
    (c.role === "due" && ivs.length > 0 && ivs.every((v) => v.nd) && t < c.a ? miss("past", rules) : ok(f, t, c, rules));
  let from = -Infinity, to = Infinity;
  for (const v of ivs) { from = Math.max(from, v.from); to = Math.min(to, v.to); }
  if (from > to) return miss("conflict", rules);
  if (wds.length) {
    if (new Set(wds.map((w) => `${w.dow}:${w.mod}`)).size > 1) return miss("conflict", rules);
    const w = wds[0]!;
    if (!ivs.length) { const dn = resolveWd(w.dow, w.mod, c); return ok(dn, dn, c, rules); }
    if (w.mod) {
      const dn = resolveWd(w.dow, w.mod, c);
      return dn >= from && dn <= to ? done(dn, dn) : miss("conflict", rules);
    }
    const first = from + ((w.dow - isoDow(from) + 7) % 7);
    if (first > to) return miss("conflict", rules);
    if (first + 7 <= to) return miss("vague", rules);
    return done(first, first);
  }
  return done(from, to);
}

function wrapYear(from: number, to: number, c: Ctx): [number, number] | null {
  const cands: Array<[number, number]> = [[addMonths(from, -12), to], [from, addMonths(to, 12)]];
  const fit = cands.filter(([f, t]) => f <= t && (c.role === "due" ? t >= c.a - HALF_YEAR : f <= c.a + HALF_YEAR));
  if (!fit.length) return null;
  return fit.reduce((p, q) => (c.role === "due" ? (q[1] < p[1] ? q : p) : (q[0] > p[0] ? q : p)));
}

function joinRanges(ms: Mention[], norm: string, c: Ctx): Mention[] {
  const out: Mention[] = [];
  for (let i = 0; i < ms.length; i++) {
    const x = ms[i]!, y = ms[i + 1];
    if (y && (x.k === "iv" || x.k === "wd") && (y.k === "iv" || y.k === "wd")) {
      const between = norm.slice(x.e, y.s).trim();
      const lead = /^(по|до)\s/.exec(norm.slice(y.s, y.e))?.[1];
      const conn = between || lead || "";
      const withS = /(?:^|[^0-9a-zа-я])(?:с|со)\s*$/.test(norm.slice(Math.max(0, x.s - 4), x.s)) || /^(?:с|со)\s/.test(norm.slice(x.s, x.e));
      const aside = conn === "-" && x.k !== y.k && !withS && /\s-|-\s/.test(norm.slice(x.e, y.s));
      if ((conn === "-" && !aside) || conn === "по" || (conn === "до" && withS)) {
        const a = x.k === "iv" ? [x.from, x.to] : [resolveWd(x.dow, x.mod, c), resolveWd(x.dow, x.mod, c)];
        const b = y.k === "iv" ? [y.from, y.to]
          : y.mod ? [resolveWd(y.dow, y.mod, c), resolveWd(y.dow, y.mod, c)]
          : [a[0]! + ((y.dow - isoDow(a[0]!) + 7) % 7), a[0]! + ((y.dow - isoDow(a[0]!) + 7) % 7)];
        let f = span(a[0]!, b[1]!, "range");
        const both = x.k === "iv" && y.k === "iv";
        if (f.k === "bad" && both && x.ny && y.ny) { const w = wrapYear(a[0]!, b[1]!, c); if (w) f = span(w[0], w[1], "range"); }
        if (f.k === "iv" && both) f = { ...f, ny: x.ny && y.ny, nd: x.nd && y.nd };
        out.push({ ...(f as Exclude<Found, { k: "none" }>), s: x.s, e: y.e });
        i++;
        continue;
      }
    }
    out.push(x);
  }
  return out;
}

const rulesOf = (ms: Mention[]) => [...new Set(ms.map((m) => m.rule))];
const ok = (from: number, to: number, c: Ctx, rules: string[]): RuDateExplain => ({ date: isoOf(c.role === "due" ? to : from), rules, miss: null });
const miss = (why: RuDateMiss, rules: string[] = []): RuDateExplain => ({ date: null, rules, miss: why });
