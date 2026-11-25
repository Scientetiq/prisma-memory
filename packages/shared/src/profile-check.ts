import { estimateTokens } from "./ids.ts";
import { fmtNumber, type Locale } from "@memory/i18n";
import { instanceLocale } from "@memory/i18n/context";

export const PROFILE_SECTIONS = ["role", "focus", "expertise", "work_with_me", "agent"] as const;
export type ProfileSection = typeof PROFILE_SECTIONS[number];

export const PROFILE_SECTION_TITLES: Readonly<Record<ProfileSection, string>> = {
  role: "Role and responsibilities", focus: "Current work", expertise: "Expertise", work_with_me: "How to work with me", agent: "For the agent",
};

export const isProfileSection = (v: unknown): v is ProfileSection => typeof v === "string" && (PROFILE_SECTIONS as readonly string[]).includes(v);

export const PROFILE_TITLE = "Work profile";

export const WORKPROFILE_PREFIX = "workprofile:";
export const WORKPROFILE_PUBLIC_PREFIX = "workprofile-public:";
export const workProfileRef = (login: string): string => `${WORKPROFILE_PREFIX}${login}`;
export const workProfilePublicRef = (login: string): string => `${WORKPROFILE_PUBLIC_PREFIX}${login}`;

export const isWorkProfileRow = (r: { type?: string | null; source_kind?: string | null; source_ref?: string | null } | null | undefined): boolean =>
  !!r && r.type === "profile" && r.source_kind === "agent" && typeof r.source_ref === "string"
  && (r.source_ref.startsWith(WORKPROFILE_PREFIX) || r.source_ref.startsWith(WORKPROFILE_PUBLIC_PREFIX));

export const PROFILE_ENABLED_SETTING = "access.profile_enabled";
export const PROFILE_SETTING = "access.profile";

export interface ProfileLimits { max_tokens: number; section_max_tokens: number; focus_fresh_days: number }
export const PROFILE_LIMITS_DEFAULT: Readonly<ProfileLimits> = Object.freeze({ max_tokens: 800, section_max_tokens: 200, focus_fresh_days: 30 });
const LIMIT_RANGES: Readonly<Record<keyof ProfileLimits, readonly [number, number]>> = {
  max_tokens: [200, 4000], section_max_tokens: [50, 1000], focus_fresh_days: [1, 365],
};

const intIn = (v: unknown, [min, max]: readonly [number, number]): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function profileSettingProblems(path: string, value: unknown): string[] {
  if (path !== PROFILE_SETTING || value === null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["object {max_tokens, section_max_tokens, focus_fresh_days}"];
  const o = value as Record<string, unknown>, out: string[] = [];
  const extra = Object.keys(o).filter((k) => !(k in LIMIT_RANGES));
  if (extra.length) out.push(`unexpected fields: ${extra.join(", ")}`);
  const words: Record<keyof ProfileLimits, string> = { max_tokens: "tokens for the entire profile", section_max_tokens: "tokens for a single section", focus_fresh_days: "days before “Current work” is out of date" };
  for (const k of Object.keys(LIMIT_RANGES) as Array<keyof ProfileLimits>) {
    const [min, max] = LIMIT_RANGES[k];
    if (k in o && !intIn(o[k], LIMIT_RANGES[k])) out.push(`${k} (${words[k]}) must be an integer from ${min} to ${max}`);
  }
  if (intIn(o.max_tokens, LIMIT_RANGES.max_tokens) && intIn(o.section_max_tokens, LIMIT_RANGES.section_max_tokens) && o.section_max_tokens > o.max_tokens)
    out.push("section_max_tokens cannot exceed max_tokens: a section cannot be longer than the entire profile");
  return out;
}

export function profileLimits(raw: unknown): ProfileLimits {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const pick = (k: keyof ProfileLimits): number => (intIn(o[k], LIMIT_RANGES[k]) ? o[k] as number : PROFILE_LIMITS_DEFAULT[k]);
  const max = pick("max_tokens"), section = pick("section_max_tokens");
  return { max_tokens: max, section_max_tokens: Math.min(section, max), focus_fresh_days: pick("focus_fresh_days") };
}

export type ProfileSource = "person" | "agent_on_behalf";
export interface ProfileSectionValue { text: string; updated_at: string; source: ProfileSource; extended?: true }
export type ProfileSections = Partial<Record<ProfileSection, ProfileSectionValue>>;
export interface ProfileAttrs { sections: ProfileSections; public: ProfileSection[]; changed?: ProfileSection[]; by?: ProfileSource; public_changed?: true }

const SOURCES: readonly ProfileSource[] = ["person", "agent_on_behalf"];

export function parseProfileAttrs(raw: unknown): ProfileAttrs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rawSections = o.sections && typeof o.sections === "object" && !Array.isArray(o.sections) ? o.sections as Record<string, unknown> : {};
  const sections: ProfileSections = {};
  for (const s of PROFILE_SECTIONS) {
    const v = rawSections[s] as Record<string, unknown> | undefined;
    if (!v || typeof v !== "object" || typeof v.text !== "string" || !v.text.trim()) continue;
    sections[s] = { text: v.text, updated_at: typeof v.updated_at === "string" ? v.updated_at : "", source: SOURCES.includes(v.source as ProfileSource) ? v.source as ProfileSource : "person",
                    ...(v.extended === true ? { extended: true as const } : {}) };
  }
  const codes = (x: unknown): ProfileSection[] => (Array.isArray(x) ? PROFILE_SECTIONS.filter((s) => x.includes(s)) : []);
  return { sections, public: codes(o.public).filter((s) => s !== "agent"),
           ...(Array.isArray(o.changed) ? { changed: codes(o.changed) } : {}), ...(SOURCES.includes(o.by as ProfileSource) ? { by: o.by as ProfileSource } : {}),
           ...(o.public_changed === true ? { public_changed: true as const } : {}) };
}

export function profileText(sections: ProfileSections): string {
  return PROFILE_SECTIONS.filter((s) => sections[s]?.text.trim()).map((s) => `## ${PROFILE_SECTION_TITLES[s]}\n${sections[s]!.text.trim()}`).join("\n\n");
}

export function sectionSpans(sections: ProfileSections): Array<{ section: ProfileSection; start: number; end: number }> {
  const out: Array<{ section: ProfileSection; start: number; end: number }> = [];
  let pos = 0;
  for (const s of PROFILE_SECTIONS) {
    const text = sections[s]?.text.trim();
    if (!text) continue;
    if (out.length) pos += 2;
    const len = `## ${PROFILE_SECTION_TITLES[s]}\n${text}`.length;
    out.push({ section: s, start: pos, end: pos + len });
    pos += len;
  }
  return out;
}

export const sectionAt = (spans: ReadonlyArray<{ section: ProfileSection; start: number; end: number }>, at: number): ProfileSection | null =>
  spans.find((s) => at >= s.start && at < s.end)?.section ?? null;

export type ProfileMode = "replace" | "append";
export type ProfileChanges = Partial<Record<ProfileSection, string | null>>;

export function applySections(current: ProfileSections, changes: ProfileChanges, mode: ProfileMode, at: string, source: ProfileSource,
                              marked = false): { next: ProfileSections; changed: ProfileSection[] } {
  const next: ProfileSections = { ...current };
  const changed: ProfileSection[] = [];
  for (const s of PROFILE_SECTIONS) {
    if (!(s in changes)) continue;
    const add = (changes[s] ?? "").trim();
    const before = current[s]?.text.trim() ?? "";
    const text = mode === "append" ? (before && add ? `${before}\n${add}` : before || add) : add;
    if (text === before) continue;
    const keep = mode === "append" && !!before && current[s]?.extended === true;
    if (text) next[s] = { text, updated_at: at, source, ...(marked || keep ? { extended: true as const } : {}) };
    else delete next[s];
    changed.push(s);
  }
  return { next, changed };
}

export const PUBLIC_SECTIONS = ["role", "focus", "expertise", "work_with_me"] as const;
export type PublicSection = typeof PUBLIC_SECTIONS[number];
export const isPublicSection = (v: unknown): v is PublicSection => typeof v === "string" && (PUBLIC_SECTIONS as readonly string[]).includes(v);

export function samePublic(a: readonly ProfileSection[], b: readonly ProfileSection[]): boolean {
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every((s) => y.has(s));
}

export interface PublicValue { text: string; updated_at: string }
export interface PublicCopy {
  sections: PublicSection[];
  values: Partial<Record<PublicSection, PublicValue>>;
  text: string;
  marked: { op: "remember"; at: string } | null;
}

export function publicCopyOf(sections: ProfileSections, pub: readonly ProfileSection[]): PublicCopy | null {
  const shown = PUBLIC_SECTIONS.filter((s) => pub.includes(s) && !!sections[s]?.text.trim());
  if (!shown.length) return null;
  const values: PublicCopy["values"] = {}, subset: ProfileSections = {};
  for (const s of shown) {
    const v = sections[s]!;
    values[s] = { text: v.text.trim(), updated_at: v.updated_at };
    subset[s] = v;
  }
  const marks = shown.filter((s) => sections[s]!.extended === true).map((s) => sections[s]!.updated_at).sort();
  return { sections: shown, values, text: profileText(subset), marked: marks.length ? { op: "remember", at: marks.at(-1) || new Date(0).toISOString() } : null };
}

export interface PublicAttrs { sections: PublicSection[]; values: Partial<Record<PublicSection, PublicValue>>; from: string | null }

export const publicAttrsOf = (copy: PublicCopy, from: string | null): { profile_public: PublicAttrs } =>
  ({ profile_public: { sections: [...copy.sections], values: { ...copy.values }, from } });

export function parsePublicAttrs(raw: unknown): PublicAttrs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rawValues = o.values && typeof o.values === "object" && !Array.isArray(o.values) ? o.values as Record<string, unknown> : {};
  const values: PublicAttrs["values"] = {};
  for (const s of PUBLIC_SECTIONS) {
    const v = rawValues[s] as Record<string, unknown> | undefined;
    if (!v || typeof v !== "object" || typeof v.text !== "string" || !v.text.trim()) continue;
    values[s] = { text: v.text, updated_at: typeof v.updated_at === "string" ? v.updated_at : "" };
  }
  const listed = Array.isArray(o.sections) ? PUBLIC_SECTIONS.filter((s) => (o.sections as unknown[]).includes(s)) : [];
  return { sections: listed.filter((s) => s in values), values, from: typeof o.from === "string" ? o.from : null };
}

export function publicCopyMatches(want: PublicCopy | null, have: { attrs: PublicAttrs; marked: boolean } | null): boolean {
  if (!want || !have) return !want && !have;
  if (want.sections.length !== have.attrs.sections.length || want.sections.some((s, i) => have.attrs.sections[i] !== s)) return false;
  if (want.sections.some((s) => (have.attrs.values[s]?.text.trim() ?? "") !== want.values[s]!.text)) return false;
  return !!want.marked === have.marked;
}

export function publicCopyWithin(want: Pick<PublicCopy, "sections" | "values">, have: PublicAttrs): boolean {
  return want.sections.every((s) => have.sections.includes(s) && (have.values[s]?.text.trim() ?? "") === (want.values[s]?.text.trim() ?? ""));
}

export interface ProfileLimitProblem { section: ProfileSection | null; tokens: number; max: number; chars: number }

const charCount = (text: string): number => { let n = 0; for (const _ of text) n++; return n; };

export function profileLimitProblem(next: ProfileSections, changed: readonly ProfileSection[], limits: ProfileLimits): ProfileLimitProblem | null {
  for (const s of changed) {
    const text = next[s]?.text ?? "";
    const tokens = estimateTokens(text);
    if (tokens > limits.section_max_tokens) return { section: s, tokens, max: limits.section_max_tokens, chars: charCount(text) };
  }
  const all = profileText(next), total = estimateTokens(all);
  return total > limits.max_tokens ? { section: null, tokens: total, max: limits.max_tokens, chars: charCount(all) } : null;
}

const CHARS_PER_TOKEN = 4;
const charsWord = (n: number): string => (n === 1 ? "character" : "characters");

export function profileLimitText(p: ProfileLimitProblem): string {
  const have = `it contains ${fmtNumber(instanceLocale(), p.chars)} ${charsWord(p.chars)}`, can = `the limit is about ${fmtNumber(instanceLocale(), p.max * CHARS_PER_TOKEN)}`;
  return p.section
    ? `The “${PROFILE_SECTION_TITLES[p.section]}” section exceeds the limit: ${have}, ${can}. Shorten it and save again`
    : `The profile exceeds the limit: ${have}, ${can} for the entire profile. Shorten the sections and save again`;
}

export function focusStale(updatedAt: string | null | undefined, freshDays: number, now: Date = new Date()): boolean {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(t) && now.getTime() - t > freshDays * 86_400_000;
}

export const PROFILE_PATH = "/me/profile";
export const isProfilePath = (path: string | null | undefined): boolean => path === PROFILE_PATH || path === `${PROFILE_PATH}/`;

function ymdIn(t: number, tz: string): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(t));
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
  return { y: g("year"), m: g("month"), d: g("day") };
}

export function dayMonthText(iso: string | null | undefined, tz: string, now: Date = new Date(), locale: Locale = instanceLocale()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const at = ymdIn(t, tz), today = ymdIn(now.getTime(), tz);
  const words = new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: tz, day: "numeric", month: "long" }).format(new Date(t));
  return `${words}${at.y === today.y ? "" : ` ${at.y}`}`;
}

export function focusStaleNote(updatedAt: string | null | undefined, tz: string, now: Date = new Date()): string {
  const day = dayMonthText(updatedAt, tz, now);
  return `${day ? `updated ${day}` : "last updated a long time ago"} — ask the person whether it is still current`;
}

export type PrivateTopic = "health" | "family" | "money" | "people_rating";
export const PRIVATE_TOPICS: readonly PrivateTopic[] = ["health", "family", "money", "people_rating"];
export const PRIVATE_TOPIC_TITLES: Readonly<Record<PrivateTopic, string>> = {
  health: "health information", family: "family information", money: "a person’s salary or income", people_rating: "an assessment of people",
};

export interface PrivateFinding { topic: PrivateTopic; word: string; section: ProfileSection }

interface Norm { text: string; map: number[] }

const ZERO_WIDTH = /[\u00AD\u200B-\u200D\u2060\uFEFF]/u;
const SPACE_LIKE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\t]/u;
const DASH_LIKE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u;

function normalize(src: string): Norm {
  let text = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of src) {
    const at = i;
    i += ch.length;
    if (ZERO_WIDTH.test(ch)) continue;
    const c = SPACE_LIKE.test(ch) ? " " : DASH_LIKE.test(ch) ? "-" : ch === "ё" || ch === "Ё" ? "е" : ch.toLowerCase();
    for (let u = 0; u < c.length; u++) map.push(at);
    text += c;
  }
  const hyph = /(?<=\p{L})-[ ]*\r?\n[ ]*(?=\p{L})/gu;
  let out = "", last = 0;
  const outMap: number[] = [];
  for (const m of text.matchAll(hyph)) {
    out += text.slice(last, m.index);
    outMap.push(...map.slice(last, m.index));
    last = m.index! + m[0].length;
  }
  if (last === 0) return { text, map };
  out += text.slice(last);
  outMap.push(...map.slice(last));
  return { text: out, map: outMap };
}

interface PrivateRule {
  topic: PrivateTopic;
  re: RegExp;
  notBefore?: RegExp;
  notAfter?: RegExp;
  notNear?: RegExp;
  person?: boolean;
  except?: (before: string, after: string) => boolean;
}

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const S = String.raw`[ \r\n]+`;
const rule = (topic: PrivateTopic, body: string, o: Omit<PrivateRule, "topic" | "re"> = {}): PrivateRule => ({ topic, re: new RegExp(`${B}(?:${body})${E}`, "gu"), ...o });

const PAYROLL_NEAR = /(?<![\p{L}])(?:зуп|1с|1c|erp|sap|hrm|hcm|ерп|конфигурац\p{L}*|бухучет\p{L}*)(?![\p{L}])/u;
const PAYROLL_BEFORE = /(?:расчет\p{L}*|начислени\p{L}*|начислят\p{L}*|начисля\p{L}*|учет\p{L}*|модул\p{L}*|фонд\p{L}*|ведомост\p{L}*|выгрузк\p{L}*|отчет\p{L}*|блок\p{L}*|подсистем\p{L}*|штатн\p{L}*|налог\p{L}*|документ\p{L}*|справочник\p{L}*)[ ]+$/u;
const PAYROLL_AFTER = /^(?:проект\p{L}*|ведомост\p{L}*|модул\p{L}*|блок\p{L}*|подсистем\p{L}*|отчет\p{L}*|документ\p{L}*|конфигурац\p{L}*|карт\p{L}*|реестр\p{L}*|справочник\p{L}*|расчет\p{L}*|начислени\p{L}*)(?![\p{L}])/u;
const TECH_PARENT = /^(?:задач|элемент|узл|узел|процесс|компонент|класс|запис|объект|директори|каталог|папк|тикет|эпик|страниц|раздел|блок|контейнер|окн|сущност|issue|epic|node)/u;
const HR_BEFORE = /(?:оформл|начисл|расчет|рассчит|учет|учитыва|провер|обрабат|обработк|прием|принима|ввод|выплачива|контрол|сопровожд|документ|реестр|ведени|веду)\p{L}*(?:[ ]+\p{L}+)?[ ]+$/u;
const HR_AFTER = /^(?:лист(?:ы|ов|ами|ах)|выплат(?:ы|ами|ах)?|пособи(?:я|й|ями|ях))(?![\p{L}])/u;
const HR_STAFF = /^(?:лист|выплат|пособи|отпуск)\p{L}*[ ]+(?:\p{L}+[ ]+)?(?:сотрудник|работник|персонал)\p{L}*/u;
const hrDuty = (before: string, after: string): boolean => (HR_BEFORE.test(before) && HR_AFTER.test(after)) || HR_STAFF.test(after);
const FAMILY_PRODUCT = String.raw`(?:продукт|решени|приложени|шрифт|сервер|модел|устройств|протокол|стандарт|алгоритм)\p{L}*`;
const RATING_PROCESS_BEFORE = /(?:провож|провод|организу|организац|отвечаю|отвечает|веду|ведет|ведени|внедр|настраива|настройк|запуска|координир|куриру|руковож|методик|методолог|систем|процесс|подбор|аттестац|регламент|кадров|hr|ежегодн|регулярн|квартальн|полугодов|годов|периодическ|итогов|планов)\p{L}*[^.!?;\n]*$/u;
const RATING_PROCESS_AFTER = /^(?:по[ ]+(?:методик|компетенц|kpi|модел|360)|360|kpi)/u;

const MY = String.raw`(?:my|his|her|their)${S}`;
const EN_PRIVATE_RULES: readonly PrivateRule[] = [
  rule("health", String.raw`sick${S}(?:leave|day|days|note)|on${S}sick${S}leave|medical${S}leave|disability${S}leave`),
  rule("health", String.raw`diagnosed${S}with|pregnan(?:t|cy)|chemotherapy|diabet(?:es|ic)|psychiatrist|psychotherapist|therapist`),
  rule("health", String.raw`${MY}(?:health|illness|diagnosis|surgery|operation|treatment|medication|doctor|disability)`),
  rule("health", String.raw`(?:chronic|serious|mental)${S}(?:illness|condition|health${S}issues?)`),
  rule("family", String.raw`${MY}(?:wife|husband|spouse|son|sons|daughter|daughters|kid|kids|child|children|baby|mother|father|mom|dad|parents|family)`),
  rule("family", String.raw`(?:maternity|paternity|parental)${S}leave|divorc(?:e|ed|ing)|wedding|school${S}run`),
  rule("money", String.raw`${MY}(?:salary|wage|wages|pay${S}rise|paycheck|bonus|income)`),
  rule("people_rating", String.raw`lazy`, { notAfter: /^(?:load|init|evaluat|fetch|import|propert|value|list|sequence)\p{L}*/u }),
  rule("people_rating", String.raw`incompetent|useless${S}(?:colleague|coworker|employee|manager|developer)`),
  rule("people_rating", String.raw`toxic${S}(?:colleague|coworker|person|manager|boss)|fire${S}(?:him|her)`),
];

const PRIVATE_RULES: readonly PrivateRule[] = [
  ...EN_PRIVATE_RULES,
  rule("health", String.raw`болезн\p{L}{0,4}`, { notAfter: /^рост\p{L}*/u }),
  rule("health", String.raw`заболе\p{L}{0,7}`),
  rule("health", String.raw`боле(?:ю|ет|ют|ешь|ем|ете|ла|л|ли|ть)`, { notAfter: /^за(?![\p{L}])/u }),
  rule("health", String.raw`диагноз(?:а|у|ом|е|ы|ов|ам|ами|ах)?`),
  rule("health", String.raw`больничн\p{L}{0,4}`, { notAfter: /^(?:систем|информацион|учрежден|комплекс|касс|сет|кластер|мис)\p{L}*/u, except: hrDuty }),
  rule("health", String.raw`беременн\p{L}{0,4}`),
  rule("health", String.raw`инвалид(?:ност\p{L}{0,3}|н\p{L}{1,4}|а|у|ом|ы|ов|ам|ами|ах)?`),
  rule("health", String.raw`лечени\p{L}{0,3}`, { notAfter: /^(?:инцидент|баг|ошиб|систем|сервер|проблем|дефект|уязвим|сбо|кластер|баз|данн|кода|код|сайт|прилож)\p{L}*/u }),
  rule("health", String.raw`леч(?:усь|ится|атся|ился|илась|ились|ащ\p{L}{1,3})`),
  rule("health", String.raw`психотерапевт\p{L}{0,3}|психиатр\p{L}{0,3}`),
  rule("health", String.raw`депресси\p{L}{0,3}`, { notBefore: /(?:экономическ|рыночн|велик)\p{L}*[ ]+$/u, notAfter: /^(?:рынк|экономик)\p{L}*/u }),
  rule("health", String.raw`онколог\p{L}{0,4}|диабет\p{L}{0,3}`),
  rule("health", String.raw`(?:после|перед)${S}операци\p{L}{0,3}`,
       { notAfter: /^(?:по|списани|слияни|обновлени|миграци|перенос|восстановлени|закрыти|оплат|продаж|покупк|внедрени|загрузк|выгрузк|импорт|экспорт|резервн)\p{L}*/u }),
  rule("health", String.raw`операци\p{L}{0,3}${S}на${S}(?:сердц|колен|глаз|позвоночник|спин|ног|рук|желуд|почк|зуб|плеч|сустав|печен|легк|сосуд)\p{L}{0,4}`),
  rule("health", String.raw`(?:в|из)${S}больниц\p{L}{0,3}`),
  rule("health", String.raw`(?:к|у|от)${S}врач(?:а|у|ом|е|ей|ам)?`),
  rule("health", String.raw`(?:состояни\p{L}{0,3}|проблем\p{L}{0,3}${S}со)${S}здоровь\p{L}{0,2}`,
       { notAfter: /^(?:систем|сервис|сервер|кластер|проект|баз|инфраструктур|сайт|приложени|сети|сеть|узл)\p{L}*/u }),
  rule("health", String.raw`(?:мо|сво)(?:е|ем|его|ему)${S}здоровь\p{L}{0,2}`),
  rule("family", String.raw`жен(?:а|ы|е|у|ой|ою)`),
  rule("family", String.raw`муж(?:а|у|ем|е|ья|ьям)?`),
  rule("family", String.raw`ребен(?:ок|ка|ку|ком|ке)|дет(?:и|ей|ям|ьми|ях)`),
  rule("family", String.raw`(?<=(?<![\p{L}])(?:забира\p{L}*|забрать|забер\p{L}*|отвож\p{L}*|отвоз\p{L}*|отвести|отвед\p{L}*|вожу|водить)${S}(?:\p{L}{1,12}${S}){0,2})`
    + String.raw`(?:из|в)${S}детск\p{L}{0,3}${S}сад\p{L}{0,3}|(?:в|из)${S}(?:детск\p{L}{0,3}${S})?садик\p{L}{0,2}`),
  rule("family", String.raw`доч(?:ь|ери|ерью|ерей|ерям|ка|ки|ке|кой|ку)`),
  rule("family", String.raw`сын(?:а|у|ом|е|ы|овья|овей|ок|ка|ку|ишк\p{L}{1,2})?`),
  rule("family", String.raw`развод(?:а|у|ом|е|ы|ов|ится|ятся|ились|илась|ился|имся)?|разв(?:ожусь|одимся|елся|елась|елись)`,
       { notAfter: /^(?:плат|кабел|провод|сет|трасс|стенд)\p{L}*/u }),
  rule("family", String.raw`свадьб\p{L}{0,3}|свадебн\p{L}{0,3}`),
  rule("family", String.raw`декрет\p{L}{0,4}`, { notAfter: /^(?:правительств|президент|совнарком)\p{L}*/u, except: hrDuty }),
  rule("family", String.raw`родител(?:ь|я|ю|ем|е|и|ей|ям|ями|ях)`, { notAfter: TECH_PARENT }),
  rule("family", String.raw`семь(?:я|и|ей|ями|ях)`, { notAfter: new RegExp(`^${FAMILY_PRODUCT}`, "u") }),
  rule("family", String.raw`семью`, { notAfter: new RegExp(String.raw`^${FAMILY_PRODUCT}|^\p{L}*(?:ами|ями|ыми|ими)(?![\p{L}])`, "u") }),
  rule("family", String.raw`семейн\p{L}{0,4}${S}(?:обстоятельств|положени|причин|дел|праздник|отпуск)\p{L}{0,4}`),
  rule("money", String.raw`зарплат\p{L}{0,4}|заработн\p{L}{0,3}${S}плат\p{L}{0,2}|зп`, { notBefore: PAYROLL_BEFORE, notAfter: PAYROLL_AFTER, notNear: PAYROLL_NEAR }),
  rule("money", String.raw`оклад(?:а|у|ом|е|ы|ов|ам|ами|ах)?`, { notBefore: PAYROLL_BEFORE, notAfter: PAYROLL_AFTER, notNear: PAYROLL_NEAR }),
  rule("money", String.raw`преми(?:я|и|ю|ей|ям|ями|ях|альн\p{L}{0,3})`, {
    notBefore: new RegExp(`(?:страхов|рыночн|риск|ценов|опцион)\\p{L}*[ ]+$|${PAYROLL_BEFORE.source}`, "u"),
    notAfter: new RegExp(`^(?:рынк\\p{L}*|за[ ]+риск\\p{L}*|риск\\p{L}*|ликвидност\\p{L}*`
      + `|(?:сегмент|клиент|продукт|класс|линейк|тариф|категори|бренд|марк|ассортимент|товар|услуг|обслуживани|сервис|качеств|позиционир)\\p{L}*)|${PAYROLL_AFTER.source}`, "u"),
    notNear: PAYROLL_NEAR }),
  rule("money", String.raw`(?:мо(?:й|и|его|их|ему|им)|мне)${S}бонус\p{L}{0,3}|бонус\p{L}{0,3}${S}(?:мне|мой|у${S}меня)`),
  rule("money", String.raw`(?:мо(?:й|его|ему|им)|личн\p{L}{0,3}|семейн\p{L}{0,3})${S}доход\p{L}{0,3}|доход\p{L}{0,3}${S}(?:семьи|у${S}меня)`),
  rule("people_rating", String.raw`ленив\p{L}{0,4}`, { notAfter: /^(?:загрузк|инициализац|вычислени|подгрузк|оценк|список|итерат|свойств|поток|рендер|импорт|load)\p{L}*/u }),
  rule("people_rating", String.raw`некомпетентн\p{L}{0,4}|бездарн\p{L}{0,4}|лентя(?:й|я|ю|ем|и|ев|ям)`),
  rule("people_rating", String.raw`токсичн\p{L}{0,4}`, { notAfter: /^(?:актив|отход|веществ|долг|кредит|выброс)\p{L}*/u }),
  rule("people_rating", String.raw`плохо${S}работа(?:ет|ют|л|ла|ли)`, { person: true }),
  rule("people_rating", String.raw`увол(?:ить|ю|им|ят|ил|или|ила|ите|ьте)`),
  rule("people_rating", String.raw`оценк\p{L}{0,3}(?:${S}\p{L}{2,20})?${S}(?:сотрудник|коллег|подчиненн|работник)\p{L}{0,3}`,
       { notBefore: RATING_PROCESS_BEFORE, notAfter: RATING_PROCESS_AFTER }),
];

const PERSON_BEFORE = /(?:^|[ ])(?:он|она|они|коллег\p{L}*|сотрудник\p{L}*|менеджер\p{L}*|руководител\p{L}*|начальник\p{L}*|разработчик\p{L}*|аналитик\p{L}*|тестировщик\p{L}*|подчиненн\p{L}*|программист\p{L}*|дизайнер\p{L}*|бухгалтер\p{L}*|юрист\p{L}*|подрядчик\p{L}*)[ ]+$/u;

const NOT_NAME_STEM = /^(?:сервис|систем|поиск|интеграц|связ|интернет|сет|сайт|портал|приложени|бот|модул|программ|сервер|принтер|сканер|склад|процесс|доставк|почт|телефон|оборудовани|касс|терминал|отчет|код|баз|фильтр|кнопк|форм|страниц|функци|синхронизац|загрузк|выгрузк|обмен|авторизац|вход|логистик|автоматизац|робот|конвейер|лифт|вентиляц|отоплени|битрикс|яндекс|гугл|телеграм|зум|контур|сбис|диадок)\p{L}{0,3}$/u;
const NOT_NAME_WORD = /^(?:сейчас|иногда|часто|порой|пока|все|это|оно|что|кто|никто|ничего|там|тут|здесь|вообще|очень|совсем|опять|снова|обычно|давно|теперь|тогда|также|тоже|уже|еще|ночью|утром|вечером|днем|всегда|немного|чуть|почему|зачем|который|которая|которое|которые|если|когда|где|зато|просто)$/u;

function nameBefore(src: string, n: Norm, start: number): boolean {
  const end = n.map[start] ?? src.length;
  const m = /([А-ЯЁ][а-яё]+)(?:[ \u00A0]+[-\u2010-\u2015])?[ \u00A0]+$/u.exec(src.slice(Math.max(0, end - 40), end));
  if (!m) return false;
  const w = m[1]!.toLowerCase().replace(/ё/gu, "е");
  return !NOT_NAME_WORD.test(w) && !NOT_NAME_STEM.test(w);
}

export function privateLifeFindings(sections: Partial<Record<ProfileSection, string | null>>, only?: readonly ProfileSection[]): PrivateFinding[] {
  const out: PrivateFinding[] = [];
  for (const section of PROFILE_SECTIONS) {
    if (only && !only.includes(section)) continue;
    const src = sections[section];
    if (!src || !src.trim()) continue;
    const n = normalize(src);
    let best: { at: number; end: number; topic: PrivateTopic } | null = null;
    for (const r of PRIVATE_RULES) {
      for (const m of n.text.matchAll(r.re)) {
        const start = m.index!, end = start + m[0].length;
        if (best && start >= best.at) break;
        const before = n.text.slice(Math.max(0, start - 40), start);
        const after = n.text.slice(end, end + 40).replace(/^[^\p{L}\p{N}]+/u, "");
        if (r.notBefore?.test(before) || r.notAfter?.test(after) || r.except?.(before, after)) continue;
        if (r.notNear?.test(n.text.slice(Math.max(0, start - 40), end + 40))) continue;
        if (r.person && !PERSON_BEFORE.test(before) && !nameBefore(src, n, start)) continue;
        best = { at: start, end, topic: r.topic };
        break;
      }
    }
    if (!best) continue;
    const from = n.map[best.at] ?? 0, to = (n.map[best.end - 1] ?? from) + 1;
    out.push({ topic: best.topic, section, word: src.slice(from, to).replace(/\s+/gu, " ").trim().slice(0, 60) });
  }
  return out;
}

export function privateLifeText(f: PrivateFinding): string {
  return `The “${PROFILE_SECTION_TITLES[f.section]}” section contains the word “${f.word}”, which suggests ${PRIVATE_TOPIC_TITLES[f.topic]}. `
    + "The profile cannot include health or family information, salaries or assessments of people. Remove that information and save again";
}
