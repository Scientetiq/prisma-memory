export * from "./record-text.ts";
// rule packs: a leaf module, re-exported here like record-text.ts
export * from "./open-check-packs.ts";
import { coreExtraRules } from "./open-check-core-extra.ts";
import { intlRules } from "./open-check-intl.ts";
import { activePacks, OPEN_CHECK_PACKS, OPEN_CHECK_PACKS_UNSET, openCheckPacksProblems, packOfRule, type OpenCheckPack } from "./open-check-packs.ts";

export type OpenCheckKind = "secret" | "pii" | "money" | "contract" | "nda" | "custom";
export const OPEN_CHECK_KINDS: readonly OpenCheckKind[] = ["secret", "pii", "money", "contract", "nda", "custom"];

export const OPEN_CHECK_MAX_FINDINGS = 20;

export type OpenCheckValidator = "luhn" | "snils" | "inn" | "phone" | "token" | "secret" | "assignment" | "password" | "email_near_name"
  | "passport" | "amount" | "contract" | "private_key" | "jwt" | "memory_key";

export interface OpenCheckRule {
  name: string;
  kind: OpenCheckKind;
  reason: string;
  pattern: string;
  caseSensitive?: boolean;
  validate?: OpenCheckValidator;
  /**
   * Check of a match by a function: built-in rules only — settings never carry it, the thread compiles its own
   * rules. `scratch` is a fresh object for each search of the rule in one text (matches come in increasing order).
   */
  check?: (m: RegExpExecArray, text: string, scratch: Record<string, unknown>) => boolean;
  /**
   * Built-in rules with a `check` only: a match the check refuses does not hide the label words inside it — the search goes
   * on from the character after the match's start, not from its end (a
   * gap that reads a line break before an item took "mobile: …" of the next line into a refused key "home_tel:" above it).
   * Linear: the starts the check sees only grow, so each position is a start at most once per rule, and a position inside a
   * refused match costs one attempt, as in a text without candidates. Monotone: every start the search from the end tried is
   * tried too, so no finding is lost; one may come from an earlier start.
   */
  resumeInside?: boolean;
}

export interface OpenCheckFinding { rule: string; kind: OpenCheckKind; reason: string; field: string; at: number }
export interface OpenCheckText { field: string; value: string | null | undefined }

const re = String.raw;

const NUM = re`(?:\d{1,3}(?:[ \t]\d{3}){1,5}|\d{1,3}(?:,\d{3}){1,5}|\d{1,3}(?:\.\d{3}){1,5}|\d{1,15})(?:[.,]\d{1,2})?`;
const MULT = re`(?:(?:тыс(?:яч\p{L}{0,2}|\.)?|млн\.?|миллион\p{L}{0,3}|млрд\.?|миллиард\p{L}{0,3}|mln|bn|k|к|т\.(?=[ \t]?р))[ \t]?)?`;
const CURRENCY = re`(?:₽|руб(?:л\p{L}{0,3}|\.)?|р\.?|rub|rur|usd|eur|euro|€|\$(?![{('"\x60/_])|£|¥|₸|₴|долл\p{L}{0,4}|дол\.|евро|у\.[ \t]?е\.|тенге|kzt|byn|cny|юан\p{L}{0,2}|грн\.?|uah|гривн\p{L}{0,2}|gbp|chf|jpy|фунт\p{L}{0,3}[ \t]стерлинг\p{L}{0,3})(?![\p{L}\p{N}-])`;
const MONEY_WORD = re`(?:сумм(?:а|ы|е|у|ой)|бюджет(?:а|е|у|ом)?|стоимост(?:ь|и|ью)|цен(?:а|ы|е|у|ой)|зп|зарплат(?:а|ы|е|у|ой)|оклад(?:а|е|у|ом)?`
  + re`|гонорар(?:а|е|у|ом)?|выручк(?:а|и|е|у|ой)|аванс(?:а|е|у|ом)?|предоплат(?:а|ы|е|у|ой)|оплат(?:а|ы|е|у|ой)|нмцк?|ставк(?:а|и|е|у|ой)`
  + re`|итого|всего|ндс|сч[её]т(?:а|е|у|ом)?|сделк(?:а|и|е|у|ой)|кп|тендер(?:а|е|у|ом)?|марж(?:а|и|е|у|ой)|прибыл(?:ь|и|ью)|доход(?:а|е|у|ом)?`
  + re`|оборот(?:а|е|у|ом)?|price|cost|budget|salary|amount)`;
const MONEY_QUAL = re`(?:(?:до|около|от|не[ \t]более|не[ \t]менее|более|свыше|порядка|примерно|почти|~|≈)[ \t]{0,3})?`;
const MONEY_PERIOD = re`(?:[1-4](?:-\p{L}{1,3})?[ \t]{1,3}квартал\p{L}{0,2}(?:[ \t]{1,3}(?:19|20)\d{2})?|(?:0?[1-9]|1[0-2])[./](?:19|20)\d{2})`
  + re`(?:[ \t]{1,3}(?:год\p{L}{0,2}|г\.))?(?![\p{L}\p{N}])`;
const PERIOD_VERB_W = re`(?:составил[аои]?|составля(?:ет|ют)|состав(?:ит|ят)|равн(?:а|о|ы|ялась|ялся|ялось)|равен)(?![\p{L}])`;
const PERIOD_VERB = PERIOD_VERB_W + re`(?=[ \t*_\x60"'«»:=|-]{1,8}${MONEY_QUAL}(?:[$€£¥₽]|\d{1,3}(?:[ \t]\d{3}){1,5}(?!\d)|[1-9]\d{0,2}(?:\.\d{3}){2,5}|\d{4,12},\d{2}`
  + re`|\d{1,4}(?:[.,]\d{1,2})?[ \t]?(?:тыс|млн|млрд|миллион|миллиард|к|k)(?![\p{L}])))`;
const NUM_MONEY = re`(?:(?:\d{1,3}(?:[ \t]\d{3}){1,5}|[1-9]\d{0,2}(?:\.\d{3}){2,5}|\d{4,12})(?:,\d{2})?|\d{1,4}(?:[.,]\d{1,2})?[ \t]?(?:тыс\.?|тысяч\p{L}{0,2}|млн\.?|миллион\p{L}{0,3}|млрд\.?|миллиард\p{L}{0,3}|к|k)(?![\p{L}])`
  + re`|[$€£¥₽][ \t]?\d{1,15}(?:[.,]\d{1,2})?)`;
const WIN_WORD = re`(?:[a-zа-яё]{1,15}(?![\p{L}])|\p{L}{1,15})`;
const HEAD_CUR = re`(?:руб\.?|р\.|₽|rub|usd|eur|\$|€|(?:тыс|млн)\.?[ \t]?руб\.?)`;
const HEAD_CUR_TAIL = new RegExp(re`^[ \t]{0,3}[,(][ \t]{0,3}${HEAD_CUR}\)?$`, "iu");
const NUM_WORD = re`(?:од(?:ин|на|ну)|дв(?:а|е|ести|адцать)|три(?:ста|дцать)?|четыр(?:е|еста)|сорок|пят(?:ь|ьсот|ьдесят)|шест(?:ь|ьсот|ьдесят)`
  + re`|сем(?:ь|ьсот|ьдесят)|восем(?:ь|ьсот|ьдесят)|девят(?:ь|ьсот)|девяносто|десять|сто|полтор[аы]|(?:один|две|три|четыр|пят|шест|сем|восем|девят)надцать)`;
const PG = re`(?:[ \t]?-?[ \t]?|\.)`;
const PSEP = re`(?:[ \t]?-[ \t]?|[ \t]|\.)`;
const DOGOVOR = re`(?<![\p{L}])(?:договор(?:а|у|ом|е|ы|ов|ам|ами|ах)?|(?:доп(?:\.[ \t]?|олнительн\p{L}{0,3}[ \t]{1,3})?)?соглашени(?:е|я|ю|ем|и|й|ям|ями|ях)|дог\.)(?![\p{L}])(?:[ \t]{0,3}[:(-])?`;
const KONTRAKT = re`(?<![\p{L}])контракт(?<!смарт[ -]?контракт)(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?![\p{L}])(?:[ \t]{0,3}[:(-])?`;
const CW = re`["«„“']?(?!n[oº°]?\.?[ \t]{0,3}\d)\p{L}[\p{L}\p{N}]{0,24}(?![\p{L}\p{N}]|[-/]\d)["»“”']{0,2}`;
const CWORDS = re`(?=(?<cw>(?:(?:[ \t]{1,3}|\r?\n|-)${CW}(?:(?:[ \t]{1,3}|-)${CW}){0,7})?))\k<cw>`;
const CSEP = re`[ \t*_\x60|#>]{0,6}(?:\r?\n[ \t*_\x60|#>]{0,6}){0,2}`;
const CNO = re`(?:№{1,2}|(?<![\p{L}])n[oº°]?\.?(?=[ \t]{0,3}\d))`;
const CNO_STRICT = re`(?:№|(?<![\p{L}])n[oº°]?\.?(?=[ \t]{0,3}\d))`;
const CTOKEN = re`[\p{L}\p{N}/.-]{0,20}\d`;
const COIN_UNIT = re`[ \t]{0,3}(?:g?wei|eth|ether|эфир\p{L}{0,2}|токен\p{L}{0,2}|tokens?|монет\p{L}{0,2}|coins?|units?|sat(?:oshi|s)?|lamports?`
  + re`|байт\p{L}{0,2}|bytes?|бит\p{L}{0,2}|bits?|[кмгтп]б|[kmgtp]i?b|строк\p{L}{0,2}|rows?|запис\p{L}{0,2}|records?|элемент\p{L}{0,3}|items?`
  + re`|символ\p{L}{0,3}|chars?|знак\p{L}{0,3}|шт\.?|штук\p{L}{0,1}|единиц\p{L}{0,2})(?![\p{L}])`;
const CDATE = re`(?:\d{1,2}[./]\d{1,2}[./]\d{2,4}|["«]?\d{1,2}["»]?[ \t]\p{L}{3,8}[ \t]\d{4})(?:[ \t]{0,3}(?:года|г\.?))?`;
const PEM_NL = re`(?:\r?\n|(?:\\r)?\\n)`;
const PEM_QUOTE = re`[ \t]{0,8}(?:>[ \t]{0,3}){0,3}`;
const PW_KEY = re`(?<k>(?:password|passphrase)(?![\p{L}\p{N}_])|(?<![/\\$\p{L}\p{N}])passwd(?![\p{L}\p{N}_])`
  + re`|(?<![\p{L}])парол(?:ь|я|ем|ю|и|ей|ям|ями|ях)(?![\p{L}])|(?<![(\p{L}\p{N}])(?:[a-z0-9]{1,20}_){0,4}(?:(?:src|dest)?(?:store|key))?(?:pass|pwd|pw)(?![\p{L}\p{N}_])`
  + re`|(?<![\p{L}])пасс(?![\p{L}])|(?<![\p{L}\p{N}_-])(?:requirepass|masterauth)(?![\p{L}\p{N}_]))`;

export const BUILTIN_OPEN_CHECK_RULES: readonly OpenCheckRule[] = [
  { name: "memory_key", kind: "secret", reason: "memory key (mem_…)", caseSensitive: true, validate: "memory_key",
    pattern: re`(?<![A-Za-z0-9]_*)mem_(?:(?:p|s|x|sys|ses)_[a-z2-7]{52}(?!_*[A-Za-z0-9])|adm_[A-Za-z0-9_-]{16,400}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|(?:upl|oac|oat|ort)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-]))` },
  { name: "gitlab_token", kind: "secret", reason: "GitLab token", validate: "token",
    pattern: re`(?<![A-Za-z0-9_])gl(?:pat|dt|ptt|rt|cbt|oas|ft|imt|agent|soat|ffct|wt)-[A-Za-z0-9_-]{20,200}` },
  { name: "api_key_sk", kind: "secret", reason: "API key (sk-…)", validate: "token", pattern: re`(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,200}` },
  // keys and tokens with a recognisable prefix: GitHub, Slack, Google (AIza), Hugging Face (hf_), Stripe (sk_live_), npm,
  // cloud provider keys (AQVN…, y0_…, t1.…), Telegram bot tokens; webhooks with an embedded secret: Slack
  // (hooks.slack.com/services/T…/B…/…), Discord (discord.com/api/webhooks/…/…) and CRM inbound webhooks (/rest/12/code/)
  { name: "service_token", kind: "secret", reason: "service token or key (GitHub, Slack, Telegram, Google, cloud provider keys…)", caseSensitive: true, validate: "token",
    pattern: re`(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,100}|xox[abeprs]-[A-Za-z0-9-]{10,200}|AIza[0-9A-Za-z_-]{35}`
      + re`|hf_[A-Za-z0-9]{30,60}|[sr]k_(?:live|test)_[A-Za-z0-9]{20,200}|npm_[A-Za-z0-9]{36}|AQVN[A-Za-z0-9_-]{35,40}|y[0-3]_[A-Za-z0-9_-]{40,300}`
      + re`|t1\.[A-Za-z0-9_-]{40,400}(?:\.[A-Za-z0-9_-]{20,200})?|hooks\.slack\.com/(?:services|workflows)/T[A-Z0-9]{6,12}/[AB][A-Z0-9]{6,12}/[A-Za-z0-9]{20,40}`
      + re`|discord(?:app)?\.com/api/webhooks/\d{17,20}/[A-Za-z0-9_-]{60,80}|rest/\d{1,6}/(?=[a-z]{0,15}\d)(?=\d{0,15}[a-z])[a-z0-9]{16})(?![A-Za-z0-9_-])`
      + re`|(?<![\p{N}])\d{8,10}:AA[A-Za-z0-9_-]{30,40}(?![A-Za-z0-9_-])` },
  { name: "private_key", kind: "secret", reason: "private key (BEGIN … PRIVATE KEY)", caseSensitive: true, validate: "private_key",
    pattern: re`-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----(?=[ \t]{0,8}$|[ \t]{0,8}[A-Za-z0-9+/=]{16}`
      + re`|[ \t]{0,8}${PEM_NL}(?:${PEM_QUOTE}${PEM_NL}){0,4}${PEM_QUOTE}(?:[A-Za-z0-9+/=]{16}|[A-Za-z0-9+/=]{4,15}(?:$|\r?\n|\\n)`
      + re`|(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset):[ \t]))`
      + re`|(?<![^\n])PuTTY-User-Key-File-\d{1,2}:[ \t]{0,3}[a-z0-9-]{3,40}|(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/]{30,60}` },
  { name: "aws_key", kind: "secret", reason: "AWS access key", caseSensitive: true, validate: "token", pattern: re`(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])` },
  { name: "jwt", kind: "secret", reason: "JWT token", caseSensitive: true, validate: "jwt",
    pattern: re`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,300}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10}` },
  { name: "bearer_token", kind: "secret", reason: "authorization token (Bearer …)", caseSensitive: true, validate: "secret",
    pattern: re`(?:(?<![A-Za-z])Bearer[ \t]{1,4}|(?<=[Aa]uthorization["']?[ \t]{0,3}[:=][ \t]{0,3}["']?)`
      + re`(?:(?:bearer|[Tt]oken|O[Aa]uth|oauth|Api-Key|ApiKey|api-key|apikey|Key|key)[ \t]{1,4})?)(?<v>[A-Za-z0-9._~+/=-]{20,400})` },
  { name: "password", kind: "secret", reason: "password", validate: "password",
    pattern: PW_KEY
      + re`|(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{1,20}://(?=(?<ul>[^\s:/@?#]{0,64}):(?<up>[^\s/@?#]{3,64})@)`
      + re`|(?<![\p{L}\p{N}_-])(?:-u|--user)(?=[ \t=]{1,3}["']?(?<cl>[^\s:"'@]{1,64}):(?<cp>[^\s"'@]{4,64}))`
      + re`|(?<![\p{L}\p{N}_-])-(?=(?<ff>[pa])(?:(?<fs>[ \t]{1,3})|(?=[^\s-]))(?:"(?<fq>[^"\n]{4,64})"|'(?<fq2>[^'\n]{4,64})'|(?<fp>[^\s"'-][^\s"']{3,63})))`
      + re`|(?<![A-Za-z])basic(?=[ \t]{1,3}(?<b64>[A-Za-z0-9+/]{8,400}={0,2}))`
      + re`|(?<![\p{L}])identified[ \t]{1,3}by(?=[ \t]{1,3}(?:'(?<iq>[^'\n]{1,64})'|"(?<iq2>[^"\n]{1,64})"))`
      + re`|(?<![\p{L}\p{N}_])(?:httpbasicauth|basicauth|networkcredential|usernamepasswordcredentials|passwordauthentication|auth[ \t]{0,3}=[ \t]{0,3})\(`
      + re`(?=[ \t]{0,3}(?:"[^"\n]{0,64}"|'[^'\n]{0,64}')[ \t]{0,3},[ \t]{0,3}(?:"(?<ca>[^"\n]{1,64})"|'(?<ca2>[^'\n]{1,64})'))`
      + re`|(?<![\p{L}])net[ \t]{1,3}user(?=[ \t]{1,3}[^\s/"]{1,64}[ \t]{1,3}(?<nu>[^\s/*"]{4,64})(?:[ \t]{1,3}\/|[ \t]{0,3}(?:\r?\n|$)))`
      + re`|(?<![\p{L}])echo(?=[ \t]{1,3}["']?[^\s:"']{1,64}:(?<ep>[^\s"':]{4,64})["']?[ \t]{0,3}\|[ \t]{0,3}(?:sudo[ \t]{1,3})?chpasswd)`
      + re`|(?<cw>учетк\p{L}{0,2}|учетн\p{L}{0,3}[ \t]{1,3}(?:запис|данн)\p{L}{0,3}|данн\p{L}{0,3}[ \t]{1,3}(?:для|от)[ \t]{1,3}(?:входа|доступа|авторизации|подключения)`
      + re`|уз|креды?|credentials|creds|доступ\p{L}{0,2})(?:[ \t]{1,3}(?:к|ко|в|на|для|от|to|for)[ \t]{1,3}[^\s:]{1,30})?`
      + re`(?=(?:[ \t]{1,3}(?:are|is)|[ \t]{0,3}[:=-])[ \t]{0,3}(?<cl2>[^\s:/@]{1,64})(?:(?<cs>:)|[ \t]{0,3}(?<cs2>/)[ \t]{0,3})(?<cr>[^\s]{4,64}))` },
  { name: "token_assignment", kind: "secret", reason: "key, secret or token value", validate: "assignment",
    pattern: re`(?<key>(?:(?<![A-Za-z0-9])|(?<=[_.]))(?:api[_ -]?(?:key|token)|apikey|secret[_-]?(?:access[_-]?)?key|client[_-]?secret|secret|access[_ -]?(?:key|token)`
      + re`|auth[_-]?token|refresh[_-]?token|bot[_-]?token|private[_ -]?(?:token|key)|token|account[_-]?key|shared[_-]?access[_-]?key|phpsessid|jsessionid|sessionid`
      + re`|(?<=[_.])(?:key|credentials?|auth)|key(?=[*_\x60"'\]]{0,3}[ \t]{0,3}(?::=|=>|[:=])))(?![A-Za-z0-9])`
      + re`|(?<ru>токен\p{L}{0,3}|ключ\p{L}{0,3}|секрет\p{L}{0,3})(?:[ \t]{1,3}[\p{L}\p{N}]{1,15}){0,4}(?![\p{L}\p{N}]))`
      + re`(?:[*_\x60"'\]]{0,3}[ \t]{0,3}(?::=|=>|[:=|])[ \t]{0,3}[*_\x60"'«|]{0,3}[ \t]{0,3}|[ \t]{1,3}(?:-{1,2}|is)[ \t]{1,3}[\x60"'«]?|(?<ss>[ \t]{1,3}))`
      + re`(?<v>[A-Za-z0-9_+/=:.!@#$%^&*()-]{16,200})`
      + re`|(?<![\p{L}\p{N}-])--(?:token|api-key|apikey|secret|client-secret|access-token|auth-token|private-token)(?:=|(?<ss2>[ \t]{1,3}))["']?(?<v2>[A-Za-z0-9_+/=:.-]{16,200})` },
  { name: "phone", kind: "pii", reason: "phone number", caseSensitive: true, validate: "phone",
    pattern: re`(?<![\p{L}\p{N}_+-])(?<!\p{N}[.,/])(?:(?<ru>(?:\+[ \t]?7|8|7)${PG}(?:\([ \t]?[3-9]\d{2}[ \t]?\)|[3-9]\d{2})${PG}\d{3}${PG}(?:\d{2}${PG}\d{2}|\d{4}))`
      + re`|(?<ruf>\+[ \t]?7(?:[ \t().-]{0,3}\d){10})`
      + re`|(?<city>\(\d{3,5}\)[ \t]?\d{1,3}(?:[ \t]?-[ \t]?|[ \t])\d{2}(?:[ \t]?-[ \t]?|[ \t])\d{2})`
      + re`|(?<intl>\+(?!7)[1-9](?:\d{9,14}|\d{0,2}(?:[ \t]?\([ \t]?\d{1,5}[ \t]?\)[ \t]?\d{1,8})?(?:(?:[ \t]{1,2}|[ \t]?-[ \t]?)\d{1,8}|\.\d{2,4}){0,6}))`
      + re`|(?<bare>[3-9]\d{2}${PSEP}\d{3}${PSEP}\d{2}${PSEP}\d{2}|[3-9]\d{2}-\d{3}-\d{4}|9\d{9}))(?![\p{N}]|[.,-]\d)` },
  { name: "email_near_name", kind: "pii", reason: "e-mail address next to a full name", caseSensitive: true, validate: "email_near_name",
    pattern: re`(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,6}\.\p{L}{2,24}(?![\p{L}\p{N}-])` },
  { name: "passport", kind: "pii", reason: "passport details", validate: "passport",
    pattern: re`(?<![\p{L}])(?:паспорт|passport)\p{L}{0,6}(?<pl>[^\d]{0,60})\d{2}[ \t-]?\d{2}["']?[ \t,./|-]{0,4}(?:\r?\n[ \t|>*-]{0,4})?`
      + re`(?:(?:№|номер|no|n)(?:[ \t]{1,3}паспорта)?[ \t.:|-]{0,4})?["']?\d{3}[ \t]?\d{3}(?!\d)`
      + re`|(?<![\p{L}])сери[яи](?:[ \t]{1,3}паспорта)?[ \t|:.-]{0,6}\d{2}[ \t]?\d{2}[ \t,.|]{0,4}(?:\r?\n[ \t|]{0,3})?(?:№|номер)(?:[ \t]{1,3}паспорта)?[ \t|:.-]{0,6}\d{6}(?!\d)`
      + re`|(?<![\p{L}])сери[яи](?:[ \t]{1,3}паспорта)?[ \t]{0,3}\|[ \t]{0,3}(?:№|номер)(?:[ \t]{1,3}паспорта)?[ \t]{0,3}\|[^\n]{0,80}\r?\n[ \t|:-]{3,80}\r?\n`
      + re`(?:[^\n|]{0,60}\|){0,4}[ \t]{0,3}\d{2}[ \t]?\d{2}[ \t]{0,3}\|[ \t]{0,3}\d{6}(?!\d)`
      + re`|(?<![\p{L}])(?:загранпаспорт\p{L}{0,3}|заграничн\p{L}{0,3}[ \t]{1,3}паспорт\p{L}{0,3})[^\d\n]{0,40}\d{2}[ \t]{0,3}(?:№[ \t]{0,3})?\d{7}(?!\d)` },
  { name: "inn", kind: "pii", reason: "tax ID", validate: "inn", pattern: re`(?<![\p{L}])(?:инн|inn)(?![\p{L}])[^\d]{0,40}\d(?:[ \t]?\d){9,11}(?![ \t]?\d)` },
  { name: "snils", kind: "pii", reason: "SNILS", validate: "snils",
    pattern: re`(?<![\p{N}.,-])\d{3}-\d{3}-\d{3}[ -]\d{2}(?![\p{N}]|[.,-]\d)|(?<![\p{L}])(?:снилс|snils)(?![\p{L}])[^\d]{0,40}\d{3}[ -]?\d{3}[ -]?\d{3}[ -]?\d{2}(?!\d)` },
  { name: "card", kind: "pii", reason: "bank card number", caseSensitive: true, validate: "luhn",
    pattern: re`(?<![\p{N}.,-])(?:[2-6]\d{3}(?<cs>[ .-]{0,2})\d{4}\k<cs>\d{4}\k<cs>\d{4}(?:\k<cs>\d{1,3})?|3[47]\d{2}(?<as>[ -]?)\d{6}\k<as>\d{5})(?![\p{N}]|[.,-]\d)` },
  { name: "amount", kind: "money", reason: "price or amount", validate: "amount",
    pattern: re`(?<![\p{L}\p{N}.,$])${NUM}(?:[*_]{1,2})?[ \t]?${MULT}${CURRENCY}`
      + re`|(?<![\p{L}\p{N}$\\"'\x60/])\$[ \t]?(?:\d{1,3}(?:[ \t,]\d{3}){1,5}(?:\.\d{1,2})?|\d{3,15}(?:\.\d{1,2})?|\d{1,2}\.\d{2}`
      + re`|\d{1,3}(?:[.,]\d{1,2})?[ \t]?(?:k|к|m|млн|млрд|тыс|bn)\.?(?![\p{L}]))(?![\p{N}$]|[.,]\d)|[€₽£¥₸₴][ \t]?\d`
      + re`|(?<![\p{L}])(?:usd|eur|rub|rur|kzt|byn|gbp|cny|chf|uah)[ \t](?<iso>\d{1,15})(?![\p{N}])`
      + re`|(?<![\p{L}\p{N}.,$])${NUM}[ \t]?\((?:[^()\n]{1,120}\)[ \t]?(?:руб(?:л\p{L}{0,3}|\.)?|₽|долл\p{L}{0,4}|евро|usd|eur)(?![\p{L}])`
      + re`|[^()\n]{0,100}?(?:рубл\p{L}{0,3}|долл\p{L}{0,4}|евро|копе\p{L}{0,3})(?![\p{L}]))`
      + re`|(?<lw>стоимост\p{L}{0,2}|цен[аы]|сумм[аы]|бюджет|итого|price|cost|amount|total)(?![\p{L}])(?=[ \t]{0,3}[,(][ \t]{0,3}`
      + re`(?:руб\.?|р\.|₽|rub|usd|eur|\$|€|(?:тыс|млн)\.?[ \t]?руб\.?)\)?[ \t*_]{0,3}[:|][ \t*_|]{0,4}(?<ln>${NUM}))`
      + re`|(?<nw>${NUM_WORD}(?:[ \t]{1,3}${NUM_WORD}){0,3})[ \t]{1,3}(?:тысяч\p{L}{0,2}|миллион\p{L}{0,3}|миллиард\p{L}{0,3})[ \t]{1,3}(?:рубл\p{L}{0,3}|долл\p{L}{0,4}|евро)(?![\p{L}])`
      + re`|(?<mw>${MONEY_WORD})(?![\p{L}])(?=(?<mws>(?:[ \t]{1,3}${WIN_WORD}(?:-${WIN_WORD})?\.?){0,4}(?:[ \t]{1,3}${MONEY_PERIOD}(?:[ \t]{1,3}${PERIOD_VERB})?)?)`
      + re`(?:(?<mr>[*_\x60"'»]{0,3}[ \t]{0,3}(?:[:=|-][ \t]{0,3})?[*_\x60"'«]{0,3}[ \t]{0,3}${MONEY_QUAL}(?<mn>${NUM_MONEY}))|(?<=(?<mx>[^]))))`
      + re`(?:\k<mx>|(?=(?<mc>(?:[ \t]{0,3}[,(][ \t]{0,3}${HEAD_CUR}\)?)?[*_\x60"' \t]{0,4}(?:[|,;\t]|\r?\n|$))))` },
  { name: "contract_number", kind: "contract", reason: "contract number", validate: "contract",
    pattern: re`${DOGOVOR}(?:${CSEP}(?:#|номер)[ \t]{0,3}[:.]?[ \t]{0,3}${CTOKEN}|${CWORDS}(?:${CSEP}${CNO}[ \t]{0,3}[:.]?[ \t*_]{0,3}${CTOKEN}`
      + re`|[ \t]{1,3}(?:от[ \t]{1,3})?${CDATE}[ \t]{0,3}${CNO}[ \t]{0,3}${CTOKEN}`
      + re`|[ \t]{1,3}(?=[\p{L}\p{N}/.-]{0,40}\d)[\p{L}\p{N}/.-]{1,40}[ \t]{1,3}от[ \t]{1,3}${CDATE}`
      + re`|[ \t]{1,3}(?:(?<sn>\d{1,10})(?:/(?<sm>[\p{L}\p{N}-]{1,15})|-(?<sl>\p{L}{1,6})(?:/[\p{L}\p{N}]{1,10})?)|(?<lp>\p{L}{1,5})-\d{1,10}(?:[/-][\p{L}\p{N}]{1,10})?`
      + re`|(?<yr>(?:19|20)\d{2})-(?<yn>\d{1,6})(?![-/.]\d))(?![\p{L}\p{N}])))`
      + re`|${KONTRAKT}(?:[ \t]{1,3}от[ \t]{1,3}${CDATE})?[ \t]{0,3}${CNO_STRICT}[ \t]{0,3}${CTOKEN}`
      + re`|${KONTRAKT}[ \t]{1,3}(?:на[ \t]{1,3})?(?!10{18})\d{19}(?![\p{N}])(?!${COIN_UNIT})`
      + re`|(?<![\p{L}])госконтракт\p{L}{0,2}[ \t]{1,3}\d{19}(?![\p{N}])|(?<![\p{L}])дс[ \t]{0,3}${CNO_STRICT}[ \t]{0,3}${CTOKEN}`
      + re`|(?<![\p{L}])(?:гк|госконтракт\p{L}{0,2}|(?:государственн|муниципальн)\p{L}{1,4}[ \t]{1,3}контракт\p{L}{0,2})(?:[ \t]{1,3}от[ \t]{1,3}${CDATE})?[ \t]{0,3}${CNO_STRICT}[ \t]{0,3}${CTOKEN}`
      + re`|(?<![\p{L}])(?:номер|№)[ \t]{0,3}(?:договора|контракта|соглашения)(?:[ \t*_\x60]{0,3}[:|-]){0,2}[ \t*_\x60]{0,4}${CTOKEN}`
      + re`|(?<![\p{L}])(?:contract|agreement)[ \t]{1,3}(?:n[oº°](?:\.|(?=[ \t]))|№|number)[ \t]{0,3}${CTOKEN}` },
  // cloud provider keys and random-looking secrets (pack core): open-check-core-extra.ts
  ...coreExtraRules({ valueOfNotSecretName }),
  // international personal data (pack intl): open-check-intl.ts
  ...intlRules(),
];

export const BUILTIN_RULE_NAMES: ReadonlySet<string> = new Set(BUILTIN_OPEN_CHECK_RULES.map((r) => r.name));

export function luhnOk(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function snilsOk(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (9 - i);
  const check = sum < 100 ? sum : sum === 100 || sum === 101 ? 0 : sum % 101 === 100 ? 0 : sum % 101;
  return check === Number(digits.slice(9));
}

function innOk(digits: string): boolean {
  const d = [...digits].map(Number);
  const check = (w: number[]) => (w.reduce((s, x, i) => s + x * d[i], 0) % 11) % 10;
  if (d.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  if (d.length === 12) return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  return false;
}

const TEST_CARDS: ReadonlySet<string> = new Set(("4242424242424242 4000056655665556 5555555555554444 5200828282828210 5105105105105100 "
  + "2223003122003222 378282246310005 371449635398431 6011111111111117 6011000990139424 3056930009020004 36227206271667 3566002020360505 "
  + "6200000000000005 5555555555554477 5555555555554592 4111111111111111 4000000000000002 4000000000000077 4793128161644804 "
  + "2200000000000004 4012888888881881 4000000000003220 4000002500003155 4242424242424241").split(" "));
const TEST_CONTEXT = /тестов|test|sandbox|песочниц|пример|example|демо|demo/iu;
const CARD_CONTEXT = /(?<![\p{L}])(?:карт\p{L}{0,3}|card|visa|mastercard|maestro|мир|amex|unionpay|jcb|pan|cvv|cvc)(?![\p{L}])/iu;
const CARD_NOT = /(?<![\p{L}])(?:id|build|сборк\p{L}{0,2}|лиценз\p{L}{0,4}|licen[cs]e|trace|span|request|order|заказ\p{L}{0,2}|serial|серийн\p{L}{0,3}|session|сесси\p{L}{0,2}|imei|iccid|uuid|ключ\p{L}{0,2}|key)(?![\p{L}])/iu;
function cardOk(m: RegExpExecArray, text: string): boolean {
  let d = digitsOf(m[0]);
  const before = text.slice(Math.max(0, m.index - 80), m.index);
  if (!luhnOk(d) && d.length > 16 && /\D/.test(m[0])) d = d.slice(0, 16);
  if (!luhnOk(d) || (TEST_CARDS.has(d) && TEST_CONTEXT.test(before))) return false;
  const near = before.slice(-40);
  if (CARD_CONTEXT.test(near)) return true;
  return !CARD_NOT.test(near) && /\D/.test(m[0]);
}

const digitsOf = (s: string): string => s.replace(/\D/g, "");
const letterBefore = (text: string, at: number): boolean => at > 0 && /\p{L}/u.test(text[at - 1]);

const PLACEHOLDER = /x{4,}|\*{3}|\.{3}|…|[<>]|\$\{|\{\{|%\(|:\/\/|^vault:|secretref|EXAMPLE|example/i;
const PLACEHOLDER_WORD = /^(?:your|my|example|sample|placeholder|changeme|change|replace|insert|here|redacted|dummy|fake|todo|fixme|none|null|undefined|empty|secret|token|key|password|passwd|pass|pwd|test|value)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function caseChanges(v: string): number {
  let n = 0, prev: boolean | null = null;
  for (const ch of v) {
    const lo = ch !== ch.toUpperCase(), up = ch !== ch.toLowerCase();
    if (!lo && !up) continue;
    if (prev !== null && prev !== lo) n++;
    prev = lo;
  }
  return n;
}

function notPlaceholder(raw: string): boolean {
  const v = raw.replace(/[.,:;]+$/, "");
  if (v.length < 16 || PLACEHOLDER.test(v) || UUID.test(v) || new Set(v).size < 6) return false;
  const parts = v.split(/[-_/.:+=]+/).filter(Boolean);
  if (parts.some((p) => PLACEHOLDER_WORD.test(p))) return false;
  return !(parts.length > 1 && parts.every((p) => /^\d{0,3}\p{L}{0,15}\d{0,10}$/u.test(p)));
}

const IDENT_PART = /^[a-z]{2,}(?:[A-Z][a-z]{2,})*(?:[A-Z]{1,2}|[A-Z]?\d{1,4})?$/;
const identLike = (v: string): boolean => v.split(/[./:_-]+/).filter(Boolean)
  .every((p) => IDENT_PART.test(p) && p.split(/(?=[A-Z])|\d+/).every((w) => w.length < 3 || /[aeiouy]/i.test(w)));

function secretLike(raw: string): boolean {
  const v = raw.replace(/[.,:;]+$/, "");
  if (!notPlaceholder(v)) return false;
  const digit = /\d/.test(v), lower = /[a-z]/.test(v), upper = /[A-Z]/.test(v);
  if (digit) return lower || upper;
  return lower && upper && caseChanges(v) * 3 >= v.length;
}

const NOT_SECRET_ANY = new Set("public pub fingerprint thumbprint kid gpg pgp".split(" "));
const SECRET_PART = /^(?:secret|secrets|password|passwd|credentials?|private)$/;
const NOT_SECRET_MEANING = new Set("idempotency idempotent dedup dedupe deduplication etag page next continuation pagination cursor checksum".split(" "));
const REQUEST_ID = new Set("request trace correlation span".split(" "));
const NOT_SECRET_KEY_MEANING = new Set("cache partition sort object site".split(" "));
const NOT_SECRET_TOKEN_MEANING = new Set("count max min input output prompt completion total num".split(" "));
const NOT_SECRET_KEY = new Set(("s3 routing route primary upload storage model map event group flag feature host file range hash index foreign unique "
  + "lookup row column i18n translation span path bucket message queue topic shard field entity record order dict redis lock ratelimit rate retry "
  + "counter metric metrics setting settings config trace correlation").split(" "));
const NOT_SECRET_TOKEN = new Set(["sync", "resume", "trace", "correlation"]);
const RU_NOT_SECRET = /(?<![\p{L}])(?:кэш|кеш|идемпотент|дедупл|продолжени|пагинац|контрольн|запис|объект|модел|сортиров|шард|партиц|раздел|индекс|поиск|словар|маршрут|очеред|событ|сообщен|файл|бакет|пут[иь]|страниц|курсор|строк|колонк|пол[еяю]|групп|публичн|открыт|отпечат|хост|перевод|локализац|идентификатор|настро[еий]|метрик|сч[её]тчик|блокиров|ретра|повтор|трассир|корреляц|redis|localstorage|sessionstorage|флаг|фич)/iu;
const RU_NOT_SECRET_MEANING = /(?<![\p{L}])(?:кэш|кеш|идемпотент|дедупл|объект|сортиров|партиц|страниц|курсор|продолжени|пагинац|контрольн|публичн|открыт|отпечат)/iu;
const RU_TOKEN_MEANING = /(?<![\p{L}])(?:идемпотент|дедупл|страниц|курсор|продолжени|пагинац|контрольн|сч[её]тчик)/iu;
const RU_SECRET = /(?<![\p{L}])(?:доступ\p{L}{0,3}|api|авторизац\p{L}{0,3}|секрет\p{L}{0,3}|приватн\p{L}{0,3}|закрыт\p{L}{0,3}|шифр\p{L}{0,6}|подпис\p{L}{0,6}|мастер\p{L}{0,3}|access|secret|private|hmac|signing|encryption)(?![\p{L}])/iu;
const RU_LB = re`(?<![\p{L}])`;
const RU_KEY_WORD = new RegExp(`${RU_LB}(?:(${RU_SECRET.source.slice(RU_LB.length)})|${RU_NOT_SECRET.source.slice(RU_LB.length)})`, "giu");
const ruHashStemAt = [0, 0, 0, 0];
let ruHashStemN = 0, ruHashAny = false;
function ruHashSeen(id: string): boolean {
  if (ruHashAny) return true;
  for (let i = 0; i < ruHashStemN; i++) if (ruHashAt(id, ruHashStemAt[i])) return true;
  return false;
}
const RU_HASH_GEN = /(?:запис(?:и|ей)|блокиров(?:ки|ок|ани[яй])|кэш(?:а|ей|ировани[яй])|кеш(?:а|ей|ировани[яй])|объект(?:а|ов)|строки?|индекс(?:а|ов|аци[ий]|ировани[яй])|шард(?:а|ов|ировани[яй])|очеред(?:и|ей)|сообщени(?:я|й)|бакет(?:а|ов))(?![\p{L}])/iuy;
const RU_HASH_IN = /(?:запис(?:и|ях)|блокировк(?:е|ах)|кэш(?:е|ах)|кеш(?:е|ах)|объект(?:е|ах)|строк(?:е|ах)|индекс(?:е|ах)|шард(?:е|ах)|очеред(?:и|ях)|сообщени(?:и|ях)|бакет(?:е|ах))(?![\p{L}])/iuy;
const RU_HASH_GAP_ADJ = /^\p{L}{3,}(?:ой|ей|ого|его|ых|их)$/iu;
const RU_HASH_GAP_NOUN = /^(?:хэш|хеш)(?:а|ей)?$/iu;
const RU_HASH_GAP_LAT = /^[A-Za-z][A-Za-z0-9._-]{0,30}$/;
const RU_HASH_GAP_CRYPTO = /^(?:aes|des|rsa|dsa|ecdsa|ecdh|ed25519|x25519|gpg|pgp|gnupg|ssh|tls|ssl|x509|pem|pkcs\d{0,2}|kms|hsm|vault|totp|hotp|otp|mfa|sso|saml|ldap|kerberos|ntlm|jwk|jwe|jws|mac|cmac|gmac|chacha\d{0,2}|salsa\d{0,2}|pbkdf2|bcrypt|scrypt|argon2|pepper|salt|cipher|crypt\w*|sign\w*|auth\w*|webhooks?|secrets?|creds?|credentials?|passw\w*|pass|pwd|admin|root|write|read|rw|ro|wo|publish|send|push|upload|download)$/i;
const RU_HASH_GAP_ID = /^(?:уникальност(?:и|ей)|сопоставлени[яй]|верси[ий]|ревизи[ий]|идентификаци[ий]|чанк(?:а|ов)|документ(?:а|ов)|эмбеддинг(?:а|ов)|вектор(?:а|ов)|фрагмент(?:а|ов)|сущност(?:и|ей)|элемент(?:а|ов))$/iu;
const RU_HASH_ANYWHERE = new Set(["блокиров", "шард"]);
const RU_HASH_GAP_GEN = /^[а-яё]{3,}(?:а|я|и|ы|ов|ев|ей|ий)$/iu;
const RU_HASH_GAP_ACCESS = new RegExp("^(?:отправ|публикац|чтени|прочтени|загрузк|выгрузк|скачивани|удалени|изменени|редактировани|управлени"
  + "|администрир|вход|проверк|верификац|подтвержд|расшифров|дешифр|создани|обновлени|рассыл|доставк|передач|при[её]м|получ|записывани"
  + "|добавлени|импорт|экспорт|синхрониз|интеграц|подключени|соединени|вызов|запуск|сервис|клиент|пользовател|приложени|бот|аккаунт"
  + "|уч[её]тн|партн[её]р|провайдер|шлюз|брокер|сервер|агент|владел|подписчик|издател|продюсер|потребител|участник|абонент|оператор"
  + "|хэш|хеш|внутри|среди|вблизи|около|возле|ради)", "iu");
function secondWord(id: string): number {
  let k = 0;
  while (k < id.length && id[k] !== " " && id[k] !== "\t") k++;
  while (k < id.length && (id[k] === " " || id[k] === "\t")) k++;
  return k;
}
const RU_HASH_IN_ADJ = /^[а-яё]{3,}(?:ом|ем|ой|ей|ых|их)$/iu;
const RU_HASH_GAP_INDECL = /^(?:аудио|видео|фото|превью)$/iu;
function ruHashAt(id: string, at: number): boolean {
  let k = secondWord(id), prep = false, adj = false;
  for (let n = 0; k < at; n++) {
    let e = k;
    while (e < id.length && id[e] !== " " && id[e] !== "\t") e++;
    const w = id.slice(k, e);
    if (prep) {
      if (adj || !RU_HASH_IN_ADJ.test(w)) return false;
      adj = true;
    } else if (n === 2) return false;
    else if (/^во?$/iu.test(w)) prep = true;
    else if (!((RU_HASH_GAP_ADJ.test(w) && !/^(?:хэш|хеш)/iu.test(w)) || RU_NOT_SECRET.test(w) || RU_HASH_GAP_NOUN.test(w)
      || RU_HASH_GAP_INDECL.test(w)
      || (/^(?:хэш|хеш)ировани[яй]$/iu.test(w) && !/^сообщен/iu.test(id.slice(at))) || RU_HASH_GAP_ID.test(w)
      || (RU_HASH_GAP_LAT.test(w) && !RU_HASH_GAP_CRYPTO.test(w))
      || (RU_HASH_GAP_GEN.test(w) && !RU_HASH_GAP_ACCESS.test(w)))) return false;
    k = e;
    while (k < id.length && (id[k] === " " || id[k] === "\t")) k++;
  }
  if (k !== at) return false;
  const re = prep ? RU_HASH_IN : RU_HASH_GEN;
  re.lastIndex = at;
  return re.test(id);
}
function ruKeyMeaning(id: string, token: boolean): -1 | 0 | 1 | 2 {
  const meaning = token ? RU_TOKEN_MEANING : RU_NOT_SECRET_MEANING;
  let found: 0 | 1 | 2 = 0;
  ruHashStemN = 0;
  ruHashAny = false;
  RU_KEY_WORD.lastIndex = 0;
  for (let m = RU_KEY_WORD.exec(id); m; m = RU_KEY_WORD.exec(id)) {
    if (m[1] !== undefined) return -1;
    if (found < 2) found = meaning.test(m[0]) ? 2 : 1;
    if (RU_HASH_STEMS.has(m[0])) {
      if (RU_HASH_ANYWHERE.has(m[0])) ruHashAny = true;
      else if (ruHashStemN < 4) ruHashStemAt[ruHashStemN++] = m.index;
    }
  }
  return found;
}
const RU_KEY_NAME = /(?<![\p{L}])(?:имя|имени|назван\p{L}{1,3}|name)[ \t]{1,3}$/iu;

function strongSecret(v: string): boolean {
  if (v.length < 20 || /[^A-Za-z0-9+/_=-]/.test(v)) return false;
  if (/^[0-9a-f]{32,}$/i.test(v)) return /\d/.test(v) && /[a-f]/i.test(v);
  if (/^[A-Za-z0-9+/_-]{20,}={1,2}$/.test(v)) return true;
  return v.length >= 20 && /^[A-Za-z0-9+/_-]+$/.test(v) && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v)
    && !v.split("/").some((p) => /^(?:[a-z]{2,}|\d+)$/.test(p)) && !wordyIdent(v);
}

function wordyIdent(v: string): boolean {
  let letters = 0, wordy = 0;
  for (const m of v.matchAll(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g)) {
    letters += m[0].length;
    if (m[0].length >= 3 && /[aeiouy]/i.test(m[0])) wordy += m[0].length;
  }
  return letters > 0 && wordy >= letters * 0.6;
}

const HASH_HEX_NAME = new Set("hash content object row lock index lookup shard queue record message bucket".split(" "));
const HASH_HEX_SECRET = new Set("access signing sign signature hmac encryption encrypt master".split(" "));
const HASH_HEX_SECRET_PART = /session|cookie|token|jwt|csrf|xsrf|bearer|oauth/;
const RU_HASH_SECRET = /(?<![\p{L}])(?:аутентифик|сесси|куки|cookie|session|jwt|csrf|xsrf|токен|token|bearer|oauth)/iu;
const RU_KEY_PREFIX = /(?:[\p{L}\p{N}]+(?:[ \t]{1,3}|-)){1,2}$/u;
const RU_HASH_NAME = new RegExp("(?<![\\p{L}])(?:(?:хэш|хеш)(?:а|у|ем|е|и|ей|ам|ами|ах)?(?![\\p{L}])|содержим|(?:консистентн|согласованн)\\p{L}{0,4}"
  + "[ \\t]{1,3}(?:хэш|хеш)|(?:хэш|хеш)сумм|(?:хэш|хеш)ировани[яй][ \\t]{1,3}(?:документ|чанк|фрагмент|эмбеддинг|вектор|элемент|сущност))", "iu");
const RU_HASH_BEFORE = /(?<![\p{L}])(?:хэш|хеш)(?:а|у|ем|е|и|ей|ам|ами|ах)?[ \t]{1,3}$/iu;
const RU_KEY_GEN = /^ключ(?:а|ей)$/iu;
const RU_HASH_STEMS = new Set("запис блокиров кэш кеш объект строк индекс шард очеред сообщен бакет".split(" "));
const hashHex = (v: string): boolean => (v.length === 32 || v.length === 40 || v.length === 64 || v.length === 128)
  && (/^[0-9a-f]+$/.test(v) || /^[0-9A-F]+$/.test(v));
function ruHashSecret(text: string, at: number, id: string): boolean {
  if (RU_HASH_SECRET.test(id)) return true;
  const pre = RU_KEY_PREFIX.exec(text.slice(Math.max(0, at - 40), at))?.[0];
  return pre !== undefined && (RU_SECRET.test(pre) || RU_HASH_SECRET.test(pre));
}

function keyNameSecret(id: string, v: string): boolean {
  return keyPartsSecret(id.toLowerCase().split(/[_. -]+/).filter(Boolean), v);
}
/** keyNameSecret over the parts of the name, in lower case (read once for high_entropy_secret). */
function keyPartsSecret(parts: readonly string[], v: string): boolean {
  if (parts.some((p) => SECRET_PART.test(p))) return true;
  if (parts.some((p) => NOT_SECRET_ANY.has(p))) return false;
  if (parts.some((p) => p === "api" || p === "auth")) return true;
  const last = parts[parts.length - 1] ?? "", q = parts[parts.length - 2], token = /token/.test(last);
  if (q === undefined) return true;
  if (q === "id" && REQUEST_ID.has(parts[parts.length - 3] ?? "")) return false;
  if (NOT_SECRET_MEANING.has(q) || (token ? NOT_SECRET_TOKEN_MEANING : NOT_SECRET_KEY_MEANING).has(q)) return false;
  if (!token && q === "websocket" && parts[parts.length - 3] === "sec") return false;
  if (!token && HASH_HEX_NAME.has(q) && hashHex(v) && !parts.some((p) => HASH_HEX_SECRET.has(p) || HASH_HEX_SECRET_PART.test(p))) return false;
  if (!token && q === "host" && parts.includes("ssh")) return false;
  return !(token ? NOT_SECRET_TOKEN : NOT_SECRET_KEY).has(q) || strongSecret(v);
}

// the name before a value for the rule high_entropy_secret, read with the lists of token_assignment above. A compound
// word of the name is split before key / token / id when its first part is on those lists: sitekey, publickey, pagetoken, requestid.
const NAME_LISTS = new Set([...NOT_SECRET_ANY, ...NOT_SECRET_MEANING, ...REQUEST_ID, ...NOT_SECRET_KEY_MEANING, ...NOT_SECRET_TOKEN_MEANING, "api", "auth"]);
const NAME_PARTS = new Map<string, readonly string[]>();
/** Parts of a name in lower case: split at "_", ".", " ", "-" and before an upper-case letter after a lower one or a digit. */
function nameParts(id: string): readonly string[] {
  const known = NAME_PARTS.get(id);
  if (known) return known;
  const out: string[] = [];
  let cur = "", prevLowDigit = false;
  const push = () => {
    if (!cur) return;
    const m = cur.length > 4 && /(?:keys?|tokens?|id)$/.test(cur) ? /^([a-z]{2,20}?)(keys?|tokens?|id)$/.exec(cur) : null;
    if (m && NAME_LISTS.has(m[1])) out.push(m[1], m[2]); else out.push(cur);
    cur = "";
  };
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c === 0x5f || c === 0x2e || c === 0x20 || c === 0x2d || c === 0x09) { push(); prevLowDigit = false; continue; }
    const upper = c >= 0x41 && c <= 0x5a;
    if (upper && prevLowDigit) push();
    cur += upper ? String.fromCharCode(c | 0x20) : id[i];
    prevLowDigit = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
  }
  push();
  if (NAME_PARTS.size >= 512) NAME_PARTS.clear();
  NAME_PARTS.set(id, out);
  return out;
}
/** The Latin name holds its value for no secret by meaning (the lists of token_assignment). */
function latinNameNotSecret(id: string, v: string): boolean {
  const parts = nameParts(id);
  if (!parts.length || parts.some((p) => SECRET_PART.test(p))) return false;
  if (parts.some((p) => NOT_SECRET_ANY.has(p))) return true;
  const last = parts[parts.length - 1], prev = parts[parts.length - 2] ?? "";
  if (last === "key" || last === "keys" || last === "token" || last === "tokens") return !keyPartsSecret(parts, v);
  if (parts.some((p) => p === "api" || p === "auth")) return false;
  return NOT_SECRET_MEANING.has(last) || (last === "id" && REQUEST_ID.has(prev));
}
const RU_LABEL_CHAR = /[\p{L}\p{N}]/u;
/** A character of a Russian name: letters and digits of any script, space, tab, "_", "-"; ASCII and Cyrillic without a regular expression. */
const ruLabelCode = (text: string, i: number): boolean => {
  const c = text.charCodeAt(i);
  if (c < 0x80) return (nameCode(c) && c !== 0x2e) || c === 0x20 || c === 0x09;
  return (c >= 0x410 && c <= 0x44f) || c === 0x401 || c === 0x451 || RU_LABEL_CHAR.test(text[i]);
};
const JWK_KTY = /"kty"[ \t]{0,3}:/;

export function valueOfNotSecretName(text: string, at: number, v: string): boolean {
  let i = at;
  const quote = () => { if (i > 0 && (text[i - 1] === '"' || text[i - 1] === "'")) { i--; if (i > 0 && text[i - 1] === "\\") i--; } };
  const space = () => { for (let k = 0; k < 3 && i > 0 && (text[i - 1] === " " || text[i - 1] === "\t"); k++) i--; };
  quote(); space();
  if (text[i - 1] === ":" || text[i - 1] === "=") i--;
  else if (text[i - 1] === ">" && text[i - 2] === "=") i -= 2;
  else return false;
  space(); quote();
  const id = keyNameBefore(text, i);
  if (id) {
    if (/^[xy]$/.test(id)) return JWK_KTY.test(text.slice(Math.max(0, i - 300), Math.min(text.length, i + 300)));
    return latinNameNotSecret(id, v);
  }
  let s = i;
  while (s > 0 && i - s < 40 && ruLabelCode(text, s - 1)) s--;
  const label = text.slice(s, i).trim();
  return /[а-яё]/iu.test(label) && ruKeyMeaning(label, /токен/iu.test(label)) === 2;
}
const API_KEY_NAME = /api|secret|credential|account[_-]?key|access[_ -]?key|ключ|секрет/iu;
const HASH_LABEL = /^(?:[A-Za-z][a-z]{0,15}\d{0,3}[-_.:]){2,7}[0-9a-f]{7,64}$/;
const HASH_LABEL_CACHE = /(?<![a-z])(?:cache|caches|deps|dependencies|node|modules|npm|yarn|pnpm|pip|pipenv|poetry|venv|conda|gradle|maven|m2|cargo|gomod|bundler?|gems|composer|nuget|packages?|lockfile|build|buildx|ccache|sccache|linux|windows|macos|ubuntu|darwin)(?![a-z])/i;
const HASH_LABEL_SECRET = new RegExp("secret|api|auth|access|private|credential|passw|bearer|session|token|hmac|encrypt|signing|signature"
  + "|(?<![a-z])(?:key|sk|pk|rk|live|sign|root|prod|production|master|release|releases|publish|license|licence|deploy|deployment|registry)(?![a-z])", "i");

/** A character of a name: [A-Za-z0-9_.-], by its code — no regular expression on every character (names are read often). */
const nameCode = (c: number): boolean => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2e || c === 0x2d;
function keyNameBefore(text: string, at: number): string {
  let start = at;
  while (start > 0 && at - start < 40 && nameCode(text.charCodeAt(start - 1))) start--;
  for (let words = 0; words < 2 && start > 1 && (text[start - 1] === " " || text[start - 1] === "\t"); words++) {
    let k = start - 1;
    while (k > 0 && start - 1 - k < 30 && nameCode(text.charCodeAt(k - 1))) k--;
    if (k === start - 1 || text[start - 2] === "." || /^[-.]+$/.test(text.slice(k, start - 1))) break;
    start = k;
  }
  return text.slice(start, at);
}

function assignmentOk(m: RegExpExecArray, text: string): boolean {
  const g = m.groups ?? {}, soft = g.ss !== undefined || g.ss2 !== undefined;
  let v = g.v ?? g.v2 ?? "", id = "";
  if (/^\$|^[\w.$]*\w\(/.test(v)) return false;                                               // $SECRET_KEY, os.getenv(…), getToken()
  v = v.replace(/[.,:;)]+$/, "");
  if (g.ru !== undefined) {
    if (letterBefore(text, m.index) || RU_KEY_NAME.test(text.slice(Math.max(0, m.index - 20), m.index))) return false;
    id = g.key!;
    const token = /^токен/iu.test(g.ru), meaning = ruKeyMeaning(id, token);
    if (meaning === 2) return false;
    if (meaning >= 0 && !token && hashHex(v) && (ruHashSeen(id) || (meaning === 0 && RU_HASH_NAME.test(id))
      || (RU_KEY_GEN.test(g.ru) && RU_HASH_BEFORE.test(text.slice(Math.max(0, m.index - 12), m.index)))) && !ruHashSecret(text, m.index, id)) return false;
    if (meaning === 1 && !strongSecret(v)) return false;
  } else if (g.key !== undefined) {
    id = keyNameBefore(text, m.index) + g.key;
    if (!keyNameSecret(id, v)) return false;
  }
  if (/подпис|sign|gpg|pgp/iu.test(id) && /^(?:0x)?(?:[0-9A-F]{8}|[0-9A-F]{16}|[0-9A-F]{40})$/i.test(v)) return false;
  const cut = v.indexOf("...");
  if (cut >= 32 && !v.startsWith("eyJ")) v = v.slice(0, cut);
  if (/^(?:sha\d{1,3}|md5)[:-]/i.test(v) || /^AAAA[A-Z0-9]{2}NzaC1/.test(v)) return false;
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d|$)/.test(v)) return false;
  if (v.includes("/") && v.split("/").every((p) => /^[a-z0-9._-]*$/.test(p) || identLike(p))) return false;
  if (identLike(v)) return false;
  if (/^(?:[a-z]{2,15}-){1,6}[a-z0-9]{4,12}$/.test(v)) return false;
  if (/^key$/i.test(id) && HASH_LABEL.test(v)) {
    const label = v.replace(/[0-9a-f]+$/, "");
    if (HASH_LABEL_CACHE.test(label) && !HASH_LABEL_SECRET.test(label)) return false;
  }
  if (UUID.test(v)) return !soft && API_KEY_NAME.test(id);
  if (!secretLike(v)) return false;
  return !soft || (v.length >= 20 && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v));
}

const NOT_PASSWORD = [
  /^[/~$%{<@]|\(|:\/\/|=.|[[\]{}]/,
  /^(?:argon2|bcrypt|scrypt|yescrypt|pbkdf2|sha-?\d|md5|base64|utf-?8|rsa-?\d|ed25519|aes-?\d|hmac|blake2)/i,
  /^\d{4}-\d{2}-\d{2}|^\d{1,2}[./]\d{1,2}[./]\d{2,4}$|^\d{1,2}:\d{2}/,
  /\.(?:json|ya?ml|env|txt|conf|cfg|ini|toml|md|py|ts|js|sh|pem|key)$/i,
  /^[\w.-]+(?:\/[\w.-]+){2,}$/,
  /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+[!?]?$/,
  /^[A-Z][a-z]+(?:[A-Z][a-z]+)+[!?]$/,
  /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?$/i,
  /^[a-z][a-z0-9_.-]{1,31}@(?:[a-z][a-z0-9.-]{0,62}|\d{1,3}(?:\.\d{1,3}){3})$/,
  /^(?:1password|keepass(?:xc)?|lastpass|bitwarden|vaultwarden|passbolt|dashlane|enpass|vault|office|microsoft|[om]|oauth|mysql|mariadb|postgres(?:ql)?|python|java|node|php|windows|win|ubuntu|debian|centos|rhel|redis|mongo(?:db)?|oracle|mssql|exchange|outlook|1[сc])\d{0,4}(?:[-:][\p{L}\p{N}-]*)?$/iu,
  /\\[nrt"]/,
  /^'?\*[0-9A-F]{40}'?$/,
];
const YAML_ALIAS = /^([&*])([A-Za-z_][\w.-]{0,62})$/;
const YAML_TAG = /^!!?[A-Za-z][A-Za-z_-]{0,40}$/;
const YAML_TAG_KNOWN = /^!!?(?:vault|secret|env|include|reference|unsafe|encrypted|sops|str|binary|null|ref|sub|getatt|importvalue|join|select|split|base64|findinmap|if|equals|and|or|not|getazs|cidr|transform)$/i;
const YAML_TAG_NEXT = /[ \t]{1,3}(?=[|>'"{[A-Za-z_$])/y;
const YAML_VALUE_NEXT = /[ \t]{1,3}(?=[^\s#])/y;
function yamlColon(text: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0 && i >= pos - 12; i--) {
    const c = text[i];
    if (c === ":") return true;
    if (!/[ \t\r\n*_`"']/.test(c)) return false;
  }
  return false;
}
function yamlNode(v: string, text: string, end: number): "ref" | number | null {
  const a = YAML_ALIAS.exec(v);
  if (a) {
    YAML_VALUE_NEXT.lastIndex = end;
    if (a[1] === "&" && YAML_VALUE_NEXT.test(text)) return YAML_VALUE_NEXT.lastIndex;
    return /^[a-z_][a-z0-9_.-]*$/.test(a[2]) && (/[_.-]/.test(a[2]) || !/\d/.test(a[2])) ? "ref" : null;
  }
  if (!YAML_TAG.test(v)) return null;
  YAML_TAG_NEXT.lastIndex = end;
  return YAML_TAG_NEXT.test(text) || YAML_TAG_KNOWN.test(v) ? "ref" : null;
}

function humps(v: string): boolean {
  const i = v.search(/\p{Ll}/u);
  return i >= 0 && /\p{Lu}/u.test(v.slice(i + 1));
}

const PW_PLAIN_NOT = new Set((
  "encrypted hashed salted unsalted generated autogenerated regenerated required optional mandatory rotating rotated masked hidden inherited "
  + "defaulted deprecated disabled enabled sensitive insensitive nullable writeonly readonly plaintext cleartext protected unchanged expired expiring "
  + "temporary redacted forgotten provisioned federated delegated obfuscated randomized templated hardcoded serialized configurable "
  + "configured ephemeral persistent interactive variable obsolete encoded incorrect mismatch accepted rejected verified "
  + "unverified validated confirmed specified unspecified supplied "
  + "decrypted urlencoded escaped quoted sanitized filtered scrubbed censored stripped tokenized truncated overridden invalidated modified "
  + "injected retrieved prompted prefilled autofilled whitelisted blacklisted writable readable hashable printable reversible irreversible editable "
  + "environment configuration parameter parameters attribute attributes integration validation password passphrase passwordless username "
  + "varchar varying string kubernetes secretsmanager credential credentials localhost keystore keychain keyring truststore omitempty "
  + "internal external personal standard security provided separate anonymous keycloak kerberos cyberark hashicorp freeipa openldap "
  + "activedirectory authentik "
  + "supported unsupported restricted initialized synchronized centralized externalized parameterized recommended prohibited allowed denied "
  + "blocked locked unlocked permanent invalid forbidden hardened authentication authorization fallback rotation autorotate provisioning "
  + "bootstrap onboarding selfservice migration recovery expiration lockout federation delegation inheritance").split(" "));
const PW_PLAIN_PREFIX = /^(?:un|re|pre|de|non|auto)(?=[a-z]{5})/;
const pwPlainNot = (l: string): boolean => PW_PLAIN_NOT.has(l) || (PW_PLAIN_PREFIX.test(l) && PW_PLAIN_NOT.has(l.replace(PW_PLAIN_PREFIX, "")));
const PW_PLAIN_DESC = new Set(["individual"]);
const PW_DESC_SUFFIX = /^[a-z]{3,}(?:ation|ization|ized|ised|ing)$/i;
const PW_DESC_NEXT = /^[ \t]{1,3}(?:\(|(?:через|в|во|на|при|раз|с|со|из)(?![\p{L}\p{N}]))/iu;
const PW_PLAIN_SUB = /secret|passw|pwd|credential|token|vault|hash|crypt/i;
const pwIdent = (w: string): boolean => PW_PLAIN_SUB.test(w) && /\p{Lu}/u.test(w.slice(1)) && /\p{Ll}/u.test(w);
const PW_PLAIN_CODE = /^(?:[a-z]+|[A-Z][a-z]+)(?:[A-Z][a-z]*)*(?:Field|Input|Str|Length|Type|Name|Value|Id|Key|Text|Char|Area|Box|Form|Prop|Attr|Config|Option|Flag|Mode|Ref|Env|Var|Hash|Salt|Policy|Schema|Widget|View|Handler|Provider|Service|Client|Store|List|Map|Set|Array|Object|Enum|Bool|Int|Number|From)$/;

function passwordLike(raw: string, quoted = false, explicit: "" | "sep" | "ru" = ""): boolean {
  const v = quoted ? raw : raw.replace(/[.,;:)\]]+$/, "");
  if (v.length < 6 || v.length > 64 || (!quoted && /\s/.test(v))) return false;
  if (PLACEHOLDER.test(v) || UUID.test(v) || NOT_PASSWORD.some((r) => r.test(v))) return false;
  const digit = /\d/.test(v), letter = /\p{L}/u.test(v);
  if (digit && letter) return !PLACEHOLDER_WORD.test(v.replace(/\d+$/, ""));
  if (digit) return /^\d{6,}$/.test(v) && !/^(\d)\1+$/.test(v);
  if (humps(v) && /[^\p{L}\p{N}]/u.test(v)) return true;
  if (!explicit || !letter) return false;
  const w = v.replace(/[!?]$/, "");
  if (/[^\p{L}\p{N}\s_.:/-]/u.test(w)) return true;
  return explicit === "ru" && /^[A-Za-z]{8,}$/.test(w) && !PLACEHOLDER_WORD.test(w) && !pwPlainNot(w.toLowerCase()) && !pwIdent(w)
    && !PW_PLAIN_CODE.test(w);
}

function strongPassword(raw: string): boolean {
  const v = raw.replace(/[.,;:)\]]+$/, "");
  return /\d/.test(v) && ((/\p{Lu}/u.test(v) && /\p{Ll}/u.test(v)) || /[^\p{L}\p{N}._/-]/u.test(v)) && !/^[a-z][a-z0-9._/-]*:v?\d[\w.-]*$/.test(v)
    && passwordLike(v);
}

const passwordRef = (v: string): boolean => /^(?:\$|<|\{|%)|^\*+$|^x{3,}$|^\.{3}$|^…$/i.test(v) || PLACEHOLDER_WORD.test(v)
  || /^[A-Z][A-Z_]*$/.test(v) || /^(?:your|my)[-_]/i.test(v);
const passwordStub = (v: string): boolean => passwordRef(v) || PLACEHOLDER.test(v) || (/^[a-z_-]+$/.test(v) && /pass|pwd|secret|token|key/.test(v));

function basicCredentials(b64: string): boolean {
  let s: string;
  try { s = atob(b64); } catch { return false; }
  return /^[\x20-\x7e]{0,64}:[\x21-\x7e]{1,64}$/.test(s) && !passwordRef(s.slice(s.indexOf(":") + 1));
}

function lineBefore(text: string, at: number): string {
  const s = text.slice(Math.max(0, at - 80), at), amp = s.lastIndexOf("&&");
  return s.slice(Math.max(s.lastIndexOf("\n"), s.lastIndexOf(";"), s.lastIndexOf("|"), amp < 0 ? -1 : amp + 1) + 1);
}
const DOCKER_CMD = /(?:^|[\s;&|(])(?:docker|podman|nerdctl|docker-compose|compose)(?:[ \t]|$)/;
const PASSWORD_P_CMD = /(?:(?:docker|podman|nerdctl|buildah|skopeo|helm(?:[ \t]+registry)?)[ \t]+login|(?<mysql>mysql\w*|mariadb\w*)|sshpass)(?![\p{L}])/u;
const PASSWORD_A_CMD = /(?<![\p{L}-])redis-cli(?![\p{L}])/u;

const PW_SEP = /[*_`"'\]]{0,3}[ \t]{0,3}(?::=|=>|[:=|]|(?<=[ \t])-{1,2}(?=[ \t]))[*_`]{0,3}[ \t]{0,3}(?:\r?\n[ \t]{0,3})?/y;
const PW_SEP_SHORT = /["']?[ \t]{0,3}(?::=|=>|[:=])[ \t]{0,3}/y;
const PW_ARG = /["'][ \t]{0,3},[ \t]{0,3}(?=["'])/y;
const PW_LABEL = /(?:[^\n\r:=.;!?|]|[.:](?![ \t\r\n]|$)){1,64}?:(?=[ \t\r\n*_`"'«]|$)[*_`]{0,3}[ \t]{0,3}(?:\r?\n[ \t]{0,3})?/y;
const PW_VALUE = /"([^"\n]{1,64})"|'([^'\n]{1,64})'|«([^»\n]{1,64})»|`([^`\n]{1,64})`|([^\s"'«»<>{}`|]{1,64})/y;
const PW_TOKEN = /[ \t]{1,3}(\S{1,64})/y;
const PW_XML = />([^<\n]{1,64})<\//y;
const PW_PAIR = /[^\s:/,]{1,64}[ \t]{0,3}(?::|[ \t]{0,3}[/,])[ \t]{0,3}([^\s]{1,64})/y;
const LOGIN_LABEL = /(?<![\p{L}])(?:логин|login|user(?:name)?|пользовател\p{L}{0,3}|учетн\p{L}{0,3}|имя)(?![\p{L}])[^\n]{0,24}$/iu;
const PW_POLICY = /(?<![\p{L}])(?:запрещ\p{L}{0,6}|слаб\p{L}{0,4}|част\p{L}{0,4}|популярн\p{L}{0,4}|распростран\p{L}{0,6}|утекш\p{L}{0,4}|утечк\p{L}{0,2}|словар\p{L}{0,2}|черн\p{L}{0,4}|banned|blacklist(?:ed)?|forbidden|common|weak|leaked|top[ -]?\d{1,6})(?![\p{L}])[^\n.;]{0,20}$/iu;
const PW_MEASURE = /^\d+(?:[.,]\d+)?(?:ms|мс|s|с|sec|сек|us|мкс|µs|ns|m|min|мин|h|ч|%|fps|x|rps|qps)?[,;.]?$/i;
const PW_CELL_END = /[*_`"' \t]{0,4}(?:[|,;\t]|\r?\n|$)/y;
const PREP = /^(?:в|во|на|от|для|к|ко|из|у|по|при|с|со|через|про|in|for|from|at|to|of|on|with|via|into)$/i;
const PW_WORD_KEY = /^(?:password|парол\p{L}{0,3})$/iu;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{3,}/;

const pwSingle = (v: string, rest: string): boolean => /[,;.]$/.test(v) || !/^ {1,3}[a-z]+(?![\p{L}\p{N}_:])/u.test(rest);

function pwValueAt(text: string, pos: number, explicit: "" | "sep" | "ru" = "", yaml = true): boolean {
  PW_VALUE.lastIndex = pos;
  const v = PW_VALUE.exec(text);
  if (!v) return false;
  const quoted = v[5] === undefined, end = PW_VALUE.lastIndex;
  if (!quoted && yaml && explicit !== "ru" && yamlColon(text, pos)) {
    const node = yamlNode(v[5], text, end);
    if (node === "ref") return false;
    if (node !== null) return pwValueAt(text, node, explicit, false);
  }
  if (!quoted && explicit === "ru" && !pwSingle(v[5], text.slice(end, end + 40))) explicit = "sep";
  if (!passwordLike(v[1] ?? v[2] ?? v[3] ?? v[4] ?? v[5], quoted, explicit)) return false;
  if (quoted || explicit !== "ru") return true;
  const after = text.slice(end, end + 12);
  return !(PW_PLAIN_DESC.has(v[5].toLowerCase()) && /^[ \t]{1,3}\p{L}/u.test(after)) && !(PW_DESC_SUFFIX.test(v[5]) && PW_DESC_NEXT.test(after));
}

function pairAt(text: string, at: number, pos: number): boolean {
  PW_PAIR.lastIndex = pos;
  const v = PW_PAIR.exec(text);
  return v !== null && passwordLike(v[1]) && LOGIN_LABEL.test(text.slice(Math.max(0, at - 40), at));
}

function lineAt(text: string, from: number): [string, number] | null {
  const chunk = text.slice(from, from + 301), nl = chunk.indexOf("\n");
  if (nl < 0) return chunk.length > 300 ? null : [chunk, text.length];
  return [chunk.slice(0, nl).replace(/\r$/, ""), from + nl + 1];
}

function columnValue(text: string, at: number, end: number, memo: Memo, ok: (cell: string, row: string[], col: number, names: string[]) => boolean): boolean {
  const back = text.slice(Math.max(0, at - 300), at), nl = back.lastIndexOf("\n");
  if (nl < 0 && at > 300) return false;
  const ls = at - back.length + nl + 1;
  if (memo.table === ls) return false;
  memo.table = ls;
  const head = lineAt(text, ls);
  if (!head || head[1] >= text.length) return false;
  const md = /^[ \t]*\|/.test(head[0]);
  if (md && !TABLE_RULE.test(lineAt(text, head[1])?.[0] ?? "")) return false;
  const delim = md ? "|" : [",", ";", "\t"].find((d) => head[0].includes(d));
  if (!delim) return false;
  const cells = (s: string) => (md ? s.trim().replace(/^\||\|$/g, "") : s).split(delim).map((c) => c.trim().replace(/^[*_`"']+|[*_`"']+$/g, ""));
  const names = cells(head[0]), key = text.slice(at, end).toLowerCase(), col = names.findIndex((c) => {
    const l = c.toLowerCase();
    return l === key || (l.startsWith(key) && HEAD_CUR_TAIL.test(l.slice(key.length)));
  });
  if (col < 0 || names.length < 2) return false;
  for (let p = head[1], row = 0; row < 4 && p < text.length; row++) {
    const line = lineAt(text, p);
    if (!line) return false;
    p = line[1];
    if (md && (row === 0 || TABLE_RULE.test(line[0]))) continue;
    const c = cells(line[0]);
    if (c.length !== names.length || c.some((x, i) => i !== col && x !== "" && x.toLowerCase() === names[i].toLowerCase())) return false;
    if (ok(c[col], c, col, names)) return true;
  }
  return false;
}
const columnPassword = (text: string, at: number, end: number, memo: Memo): boolean =>
  columnValue(text, at, end, memo, (v) => passwordLike(v) && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(v));

function wordsPassword(text: string, pos: number): boolean {
  let p = pos, copula = false, object = false;
  for (let i = 0; i < 8; i++) {
    PW_TOKEN.lastIndex = p;
    const t = PW_TOKEN.exec(text);
    if (!t) return false;
    p = PW_TOKEN.lastIndex;
    let w = t[1], stop = false;
    const esc = w.search(/\\[nrt]/);
    if (esc >= 0) { w = w.slice(0, esc); stop = true; }
    if (copula) return passwordLike(w);
    if (/^(?:is|это|-{1,2}|умолчанию|default)$/i.test(w)) { copula = true; continue; }
    if (PW_WORD_KEY.test(w)) return false;
    if (i < 4 && /^(?:на|to)$/i.test(w)) {
      PW_TOKEN.lastIndex = p;
      const v = PW_TOKEN.exec(text)?.[1];
      if (v !== undefined && (strongPassword(v) || /^\d{6,}[.,;!]?$/.test(v))) return passwordLike(v);
    }
    if (object) object = false;
    else if (i < 4 && (strongPassword(w) || (i === 0 && !/-/.test(w) && passwordLike(w)))) return true;
    if (i < 4 && /^\d{6,}[.,;!]?$/.test(w) && passwordLike(w)) return true;
    if (/парол|passw/iu.test(w)) return false;
    if (PREP.test(w)) object = true;
    if (stop || /[,;:!?.]$/.test(w)) return false;
  }
  return false;
}

function keyPassword(key: string, text: string, at: number, pos: number, memo: Memo): boolean {
  if (at > 0 && /\p{Ll}/u.test(text[at - 1]) && /^\p{Ll}/u.test(key)) return false;
  if ((text[pos] === "?" || (text[pos] === ":" && text[pos + 1] === "?")) && /\$\{[\w.-]{0,64}$/.test(text.slice(Math.max(0, at - 66), at))) return false;
  if (!keyValue(key, text, at, pos, memo)) return false;
  const before = text.slice(Math.max(0, at - 40), at);
  return !/(?:хэш|хеш|hash|соль|salt)\p{L}{0,2}[ \t]{1,3}$/iu.test(before) && !PW_POLICY.test(before);
}

function keyValue(key: string, text: string, at: number, pos: number, memo: Memo): boolean {
  if (/^(?:src|dest)?(?:store|key)pass$/i.test(key) && text[at - 1] !== "-") return false;
  if (/^(?:requirepass|masterauth|(?:src|dest)?(?:store|key)pass)$/i.test(key)) {
    PW_TOKEN.lastIndex = pos;
    const t = PW_TOKEN.exec(text);
    return t !== null && passwordLike(t[1].replace(/^(["'])(.*)\1$/, "$2"));
  }
  if (!/^(?:password|passphrase|passwd|парол)/i.test(key)) {
    if (key === "PASS" && /^[ \t]{0,3}:(?!=)/.test(text.slice(pos, pos + 5))) return false;
    PW_SEP_SHORT.lastIndex = pos;
    if (!PW_SEP_SHORT.test(text)) return false;
    PW_VALUE.lastIndex = PW_SEP_SHORT.lastIndex;
    const v = PW_VALUE.exec(text)?.[5];
    if (v !== undefined && (PW_MEASURE.test(v) && (/[^\d.,;]/.test(v) || /^pass$/i.test(key)))) return false;
    return pwValueAt(text, PW_SEP_SHORT.lastIndex, "sep");
  }
  const explicit = /^парол/i.test(key) ? "ru" : "sep";
  if (text[pos] === ">" && text[at - 1] === "<") {
    PW_XML.lastIndex = pos;
    const v = PW_XML.exec(text);
    return v !== null && passwordLike(v[1], false, "sep");
  }
  PW_ARG.lastIndex = pos;
  if (PW_ARG.test(text)) return pwValueAt(text, PW_ARG.lastIndex, "sep");
  PW_CELL_END.lastIndex = pos;
  const cell = PW_CELL_END.test(text);
  PW_SEP.lastIndex = pos;
  if (PW_SEP.test(text)) {
    const v = PW_SEP.lastIndex;
    return pwValueAt(text, v, explicit) || (cell && columnPassword(text, at, pos, memo)) || pairAt(text, at, v);
  }
  if (/^passwd$/i.test(key)) return false;
  if (cell && columnPassword(text, at, pos, memo)) return true;
  if (memo.colon === undefined || (memo.colon >= 0 && memo.colon < pos)) memo.colon = text.indexOf(":", pos);
  if (memo.colon >= 0 && memo.colon - pos <= 68) {
    PW_LABEL.lastIndex = pos;
    if (PW_LABEL.test(text)) return pwValueAt(text, PW_LABEL.lastIndex, explicit) || pairAt(text, at, PW_LABEL.lastIndex);
  }
  return wordsPassword(text, pos);
}

function passwordOk(m: RegExpExecArray, text: string, memo: Memo): boolean {
  const g = m.groups ?? {};
  if (g.b64 !== undefined) return basicCredentials(g.b64);
  if (g.up !== undefined) return !passwordStub(g.up) && g.up !== g.ul;
  if (g.cp !== undefined) {
    return (m[0] === "-u" || m[0].toLowerCase() === "--user") && !g.cp.startsWith("/") && !passwordRef(g.cp) && g.cp !== g.cl
      && !(/^\d+$/.test(g.cl) && /^\d+$/.test(g.cp)) && !DOCKER_CMD.test(lineBefore(text, m.index));
  }
  const fp = g.fp ?? g.fq ?? g.fq2;
  if (fp !== undefined) {
    const line = lineBefore(text, m.index);
    if (g.ff === "a" || g.ff === "A") return PASSWORD_A_CMD.test(line) && !passwordRef(fp) && passwordLike(fp, g.fp === undefined);
    const cmd = PASSWORD_P_CMD.exec(line);
    return cmd !== null && !(cmd.groups?.mysql && g.fs !== undefined) && !passwordRef(fp) && passwordLike(fp, g.fp === undefined);
  }
  const iq = g.iq ?? g.iq2 ?? g.ca ?? g.ca2;
  if (iq !== undefined) return !passwordRef(iq) && passwordLike(iq, true);
  const nu = g.nu ?? g.ep;
  if (nu !== undefined) return !passwordRef(nu) && passwordLike(nu);
  if (g.cr !== undefined) {
    if (letterBefore(text, m.index)) return false;
    if (g.cs !== undefined) return passwordLike(g.cr) && !/^\d{1,5}(?:[/?#]|$)/.test(g.cr);
    return !/^[A-Z0-9_-]+$/.test(g.cl2) && !g.cr.includes("/") && strongPassword(g.cr);
  }
  return keyPassword(g.k ?? "", text, m.index, m.index + m[0].length, memo);
}

const PHONE_CONTEXT = /(?<![\p{L}])(?:тел(?:ефон\p{L}{0,4}|\.)?|моб(?:ильн\p{L}{0,4}|\.)?|сот(?:ов\p{L}{0,3}|\.)|(?:по)?звон\p{L}{0,5}|связ\p{L}{0,4}|контакт\p{L}{0,3}|факс|phone|mobile|tel|cell|call|fax|whatsapp|viber|telegram|wa\.me|t\.me)(?![\p{L}])/giu;
const UPPER = /\p{Lu}/gu;

function nextHit(rx: RegExp, text: string, from: number, memo: Memo, key: "ctx" | "cap"): number {
  const c = memo[key];
  if (c && c[0] <= from && (c[1] < 0 || c[1] >= from)) return c[1];
  rx.lastIndex = from;
  const hit = rx.exec(text)?.index ?? -1;
  memo[key] = [from, hit];
  return hit;
}

function phoneContext(text: string, from: number, to: number, memo: Memo): boolean {
  const a = Math.max(0, from - 40), c = nextHit(PHONE_CONTEXT, text, a, memo, "ctx");
  if (c >= 0 && c < to + 40) return true;
  const u = nextHit(UPPER, text, a, memo, "cap");
  return u >= 0 && u < from && nameBefore(text.slice(u, from));
}
const PHONE_UNIT = /^[ \t]{0,3}(?:запис\p{L}{0,3}|строк\p{L}{0,2}|токен\p{L}{0,3}|байт\p{L}{0,2}|элемент\p{L}{0,3}|шт|раз|мс|ms|кб|мб|гб|kb|mb|gb|items?|rows?|records?|tokens?|bytes?)(?![\p{L}])/iu;

function nameBefore(s: string): boolean {
  let prev = 0;
  for (const w of s.match(/(?<![\p{L}])\p{Lu}[\p{Ll}ё]+(?![\p{L}])/gu) ?? []) {
    const f = marks(w);
    if (f & (W_FIRST | W_PATR) || isNamePair(prev, f)) return true;
    prev = f;
  }
  return false;
}

function phoneOk(m: RegExpExecArray, text: string, memo: Memo): boolean {
  const s = m[0], d = digitsOf(s), g = m.groups ?? {}, end = m.index + s.length;
  if (d.length < 10 || d.length > 15) return false;
  if (/^[78]?0+$/.test(d)) return false;
  if (PHONE_UNIT.test(text.slice(end, end + 16))) return false;
  const near = () => phoneContext(text, m.index, end, memo);
  const spaced = !/[+-]/.test(s) && /\d[ \t]+\d/.test(s);
  if (spaced && (/\d[ \t,]{1,3}$/.test(text.slice(Math.max(0, m.index - 4), m.index)) || /^[ \t,]{1,3}\d/.test(text.slice(end, end + 4)))) return false;
  if (g.city !== undefined) return !spaced || near();
  if (g.ruf !== undefined) return true;
  if (g.intl !== undefined) {
    if (/^\+\d+$/.test(s)) return near();
    if (/^\+\d{1,3}\.\d{4}/.test(s)) return false;
    const groups = s.slice(1).split(/\D+/);
    if (groups.every((x) => x.length <= 2)) return near();
    return !groups.slice(1).every((x) => x.length === 3);
  }
  if (g.ru !== undefined) {
    if (s.startsWith("+") || /[()-]/.test(s)) return true;
    if (/^[78][ \t]+[3-9]\d\d[ \t]+\d{3}[ \t]+\d{2}[ \t]+\d{2}$/.test(s) || /^[78][ \t]+9\d\d[ \t]+\d{3}[ \t]+\d{4}$/.test(s)) return true;
    return near();
  }
  if (/^\d{3}-\d{3}-\d{2}-\d{2}$/.test(s)) return true;                 // «NNN-NNN-NN-NN»
  return near();
}

const ROLE_WORDS: ReadonlySet<string> = new Set(("noreply donotreply admin administrator root support info help helpdesk office sales billing "
  + "report reports alert alerts alerting alertmanager order orders registry postmaster hostmaster webmaster git gitlab github jenkins ci cd "
  + "build builds release releases deploy deploys devops bot robot notification notifications notify notifier noc security abuse hr team teams "
  + "dev mail mailer contact contacts feedback service services svc system monitoring monitor backup backups news press marketing legal "
  + "accounting buh secretary reception it test qa digest oncall cron scheduler daemon logs log events audit "
  + "memory grafana zabbix sentry jira confluence prometheus kibana elastic nagios icinga teamcity youtrack redmine bitbucket nexus harbor sonar "
  + "sonarqube argocd vault keycloak ldap smtp postfix n8n airflow crm erp servicedesk portal gateway integration integrations "
  + "sync api hub teamhub uptime status pagerduty opsgenie slack mattermost data platform cloud ops devsecops sre infra search quality analytics "
  + "directors board dialogs kadry finance zakupki tender tenders procurement product design docs code careers jobs partners privacy "
  + "compliance").split(" "));
const GIT_TRAILER = /(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by)[ \t]*:[^\n]*$|--author=\S*$/i;
const GIT_HEADER = /(?:^|\n)(?:Author|Commit|Committer)[ \t]*:[^\n]*$/;
const FIRST_NAMES = new Set(("александр алексей анатолий андрей антон аркадий арсений артем артур богдан борис вадим валентин валерий "
  + "василий виктор виталий владимир владислав всеволод вячеслав геннадий георгий герман глеб григорий давид даниил данила денис "
  + "дмитрий евгений егор захар иван игорь илья иннокентий иосиф кирилл константин лев леонид макар максим марк матвей михаил назар "
  + "никита николай олег павел петр платон роберт родион роман ростислав руслан савва святослав семен сергей станислав степан тарас "
  + "тимофей тимур федор филипп эдуард эльдар юрий ян ярослав айдар азат ильдар ринат рустам марат камиль дамир тагир ренат ильнур "
  + "ефим яков альберт рамиль фарид азамат амир артемий вениамин гавриил данияр ислам исмаил мурат нурлан рафаэль рашид ришат салават "
  + "шамиль эмиль эрик адам али арслан булат ильяс инсаф радик айрат ильшат ирек феликс эдгар аркадий лука мирон тихон демид елисей "
  + "алена алина алиса алла альбина анастасия ангелина анна антонина арина валентина валерия варвара вера вероника виктория "
  + "виолетта галина дарья диана ева евгения екатерина елена елизавета жанна зинаида зоя инна ирина карина кира клавдия кристина "
  + "ксения лариса лидия лилия любовь людмила маргарита марина мария милана надежда наталья наталия нина оксана олеся ольга полина "
  + "раиса регина римма светлана софья софия таисия тамара татьяна ульяна элина эльвира юлия яна ярослава гульнара динара лейла "
  + "эмилия злата гульшат айгуль алсу альфия гузель зарина камила ляйсан наиля резеда эльмира василиса есения стефания эвелина "
  + "алия фатима мадина зарема снежана милена каролина амина сабина камилла асель айжан айгерим диляра зульфия лейсан малика марьям "
  + "зухра патимат аминат гульназ луиза инесса илона аделина ясмина сабрина мирослава владислава станислава майя эльнара "
  + "саша женя дима лена катя маша таня оля настя аня света юля ира наташа вова володя леша миша коля петя сережа паша толя витя "
  + "костя слава стас влад вика даша ксюша надя люда галя лиза ваня "
  + "игнат гордей рустем ильхам ахмед ашот магомед ильнар азиз юлиан").split(" "));
const NOT_SURNAME = new Set(("раздел приложение пункт подпункт глава часть таблица рисунок схема этап версия вариант тип класс группа "
  + "корпус строение литера блок секция серия том форма лист шаг уровень категория код пример модуль сервис проект отдел команда "
  + "итого примечание план фаза статья параграф абзац пояснение приказ позиция стенд среда контур кластер узел сервер служба совет "
  + "чат канал навык бот управление департамент дирекция комитет центр филиал офис представительство магазин склад "
  + "город улица проспект переулок бульвар площадь шоссе набережная район область край село деревня поселок станция вокзал аэропорт "
  + "жк дом кафе ресторан бар отель гостиница театр кинотеатр музей галерея библиотека школа лицей гимназия колледж институт "
  + "университет больница поликлиника клиника парк сквер стадион завод фабрика компания журнал газета салон студия агентство фонд "
  + "лаборатория храм собор дворец").split(" "));
const BRANDS = new Set(("яндекс сбер сбербанк битрикс тинькофф альфа газпром мтс мегафон билайн ростелеком авито озон гугл майкрософт "
  + "касперский телеграм вконтакте мойсклад").split(" "));
const COMMON_NOUNS = new Set(("договоров протоколов отчетов кадров тестов аналитиков документов проектов сотрудников клиентов партнеров "
  + "поставщиков заказов платежей счетов актов регламентов продуктов сервисов процессов ресурсов активов контрактов тендеров кандидатов "
  + "разработчиков тестировщиков менеджеров администраторов пользователей специалистов экспертов юристов бухгалтеров директоров "
  + "студентов работников товаров объектов запросов вопросов ответов инцидентов релизов логов файлов архивов шаблонов стандартов приказов "
  + "реестров отделов филиалов складов офисов курсов лидов рисков расходов доходов налогов сборов кредитов отзывов грантов бюджетов списков "
  + "скриптов серверов кластеров билдов тикетов багов дефектов алертов тарифов датасетов прогнозов "
  + "чемпионов фрилансеров депутатов дизайнеров инвесторов архитекторов").split(" "));
const COMMON_HEADS = new Set(("реестр архив рассылка почта поддержка база портал хранилище канцелярия приемная секретариат бухгалтерия касса "
  + "линия сектор штаб редакция витрина площадка список ящик лента каталог справочник сводка заявка отчет протокол документ доска "
  + "лига биржа дума гильдия ассоциация кухня клуб союз задача сообщество федерация палата коллегия академия партия альянс консорциум "
  + "форум конференция выставка ярмарка собрание объединение содружество кооператив товарищество бригада отряд сборная кружок "
  + "отдел служба группа центр чат бюро курс курсы опрос учет семинар сбор кафедра анкета встреча программа олимпиада премия смена карта "
  + "сессия анализ аудит обзор мониторинг контроль журнал регистр трекер график календарь обучение тренинг вебинар митап хакатон конкурс "
  + "турнир чемпионат рейтинг набор отбор подбор найм прием слет съезд совещание пул матрица реестры таблица перечень ведомость картотека "
  + "портфель банк "
  + "менеджмент управление департамент дирекция комитет совет команда направление дивизион блок").split(" "));
const LATIN_NOT_NAME = new Set(("gateway server service system bot robot team admin support notification notifications alert alerts "
  + "monitor monitoring build release deploy git gitlab github jenkins memory mail mailer daemon cron scheduler backup report reports "
  + "security test noreply reply info news update updates the and ci cd no doe roe example sample user software registry logs hub code "
  + "language platform data cloud ops search quality engine studio labs lab bank group").split(" "));
const PATRONYMIC = /^[А-ЯЁ](?:[а-яё]+(?:(?:ович|евич|ьич)(?:а|у|ем|е)?|(?:овн|евн|ичн|иничн)(?:а|ы|е|у|ой|ою))|[А-ЯЁ]+(?:ОВИЧ|ЕВИЧ|ЬИЧ|ОВНА|ЕВНА|ИЧНА|ИНИЧНА))$/;
const SURNAME = /(?:(?:ов|ев|ёв|ин|ын)(?:а|у|ым|ом|е|ой|ою|ых|ыми)?|их|ых|(?:ск|цк)(?:ий|ой|ая|ого|ому|им|ом|ую)|енко|ко|ук|юк|чук|ян|янц|швили|дзе|ич|ман|берг|штейн)$/i;
const CYR_WORD = /^[А-ЯЁ](?:[а-яё]+|[А-ЯЁ]+)(?:-[А-ЯЁ][а-яё]+)?$/;
const NAME_CASES: ReadonlyArray<readonly [string, readonly string[]]> = [["ой", ["а"]], ["ою", ["а"]], ["ей", ["я", "ь"]], ["ею", ["я"]],
  ["ом", [""]], ["ем", ["й", "ь"]], ["а", ["", "ь"]], ["я", ["й", "ь"]], ["у", ["", "а"]], ["ю", ["й", "ь", "я"]], ["е", ["а", "я", "й", ""]],
  ["и", ["а", "я", "й", "ь"]], ["ы", ["а"]]];
const NAME_FLEETING: Readonly<Record<string, string>> = { павл: "павел", льв: "лев" };
function firstName(l: string): boolean {
  return nameIn(FIRST_NAMES, l.replace(/ё/g, "е"));
}
function nameIn(names: ReadonlySet<string>, w: string): boolean {
  if (names.has(w)) return true;
  for (const [e, base] of NAME_CASES) {
    if (w.length < e.length + 3 || !w.endsWith(e)) continue;
    const s = w.slice(0, -e.length);
    for (const b of base) if (names.has(s + b)) return true;
    if (names.has(NAME_FLEETING[s] ?? "")) return true;
  }
  return false;
}
const LAT_WORD = /^[A-Z](?:[a-z]{1,20}|[A-Z]{1,20})$/;
const CAP_TOKEN = /(?<![\p{L}\p{N}])(?:\p{Lu}\.|\p{Lu}\p{L}{0,40}(?:-\p{L}{1,40})?)/gu;
const CAP_TOKEN_AT = /\p{Lu}\.|\p{Lu}\p{L}{0,40}(?:-\p{L}{1,40})?/uy;

const TR: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "z", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "c", ш: "s", щ: "s", ъ: "", ы: "i", ь: "", э: "e", ю: "u", я: "a" };
function skel(s: string): string {
  let t = "";
  for (const ch of s.toLowerCase()) t += TR[ch] ?? (ch >= "a" && ch <= "z" ? ch : "");
  return t.replace(/kh/g, "h").replace(/shch|sch|sh/g, "s").replace(/zh/g, "z").replace(/ts|tz|ch/g, "c").replace(/[yj]/g, "i")
    .replace(/iu/g, "u").replace(/ia/g, "a").replace(/ii+/g, "i").replace(/w/g, "v").replace(/q/g, "k").replace(/x/g, "ks");
}
const skelKeys = new Map<string, string>();
function skelKey(w: string): string {
  let k = skelKeys.get(w);
  if (k !== undefined) return k;
  const s = skel(w);
  k = s.length >= 5 ? s.slice(0, 4) : s.length >= 3 ? s.slice(0, 3) : "";
  if (skelKeys.size > 20000) skelKeys.clear();
  skelKeys.set(w, k);
  return k;
}
const LATIN_FIRST = new Set([...[...FIRST_NAMES].map(skel), ...("john james robert michael william david richard joseph thomas charles "
  + "mary patricia jennifer linda elizabeth barbara susan jessica sarah karen alex alexander peter paul mark daniel george kate kevin "
  + "brian andrew eric max anna maria julia helen olga nick jack tom chris steve martin").split(" ").map(skel)]);

const W_CYR = 1, W_WORD = 2, W_FIRST = 4, W_PATR = 8, W_SURN = 16, W_INIT = 32, W_LAT = 64, W_TITLE = 128, W_LATNOT = 256, W_NOUN = 512,
  W_BRAND = 1024, W_HEAD = 2048;
const wordMarks = new Map<string, number>();
function marks(w: string): number {
  let f = wordMarks.get(w);
  if (f !== undefined) return f;
  const l = w.toLowerCase(), cyr = CYR_WORD.test(w), head = COMMON_HEADS.has(l), noun = head || COMMON_NOUNS.has(l);
  const word = cyr && !NOT_SURNAME.has(l) && !BRANDS.has(l) && !head;
  f = (cyr ? W_CYR : 0) | (word ? W_WORD : 0) | (word && firstName(l) ? W_FIRST : 0) | (PATRONYMIC.test(w) ? W_PATR : 0)
    | (word && SURNAME.test(w) ? W_SURN : 0) | (/^[А-ЯЁ]\.$/.test(w) ? W_INIT : 0) | (LAT_WORD.test(w) ? W_LAT : 0)
    | (NOT_SURNAME.has(l) ? W_TITLE : 0) | (LATIN_NOT_NAME.has(l) ? W_LATNOT : 0) | (noun ? W_NOUN : 0) | (BRANDS.has(l) ? W_BRAND : 0)
    | (head ? W_HEAD : 0);
  if (wordMarks.size > 20000) wordMarks.clear();
  wordMarks.set(w, f);
  return f;
}

function isNamePair(a: number, b: number): boolean {
  return (a & W_WORD && b & W_PATR) !== 0
    || (a & W_FIRST && b & W_WORD) !== 0 || (a & W_WORD && b & W_FIRST) !== 0
    || (a & W_SURN && b & W_INIT) !== 0 || (a & W_INIT && b & W_SURN) !== 0
    || (a & W_FIRST && b & W_INIT) !== 0;
}

interface CapTok { w: string; f: number; start: number; end: number; tainted: boolean }
interface NamePair { start: number; end: number; a: string; b: string; name: boolean; latin: boolean; keys?: string[]; sur?: number }
interface NameWord { start: number; end: number; w: string; key?: string }
interface NameScan { pos: number; prev: CapTok | null; pairs: NamePair[]; head: number; words: NameWord[]; wHead: number }
const NAME_BEFORE = 60, NAME_AFTER = 40, NAME_WIDE_BEFORE = 200, NAME_WIDE_AFTER = 100;

function adjacent(text: string, from: number, to: number): boolean {
  if (to - from < 1 || to - from > 3) return false;
  if (to - from === 1 && (text[from] === "," || text[from] === ";")) return true;
  for (let i = from; i < to; i++) if (text[i] !== " " && text[i] !== "\t") return false;
  return true;
}

const PRODUCT_WORDS: ReadonlySet<string> = new Set(["навык", "бот", "чат-бот"]);
function pushCapToken(text: string, scan: NameScan, w: string, start: number): void {
  const a = scan.prev, f = marks(w), b: CapTok = { w, f, start, end: start + w.length, tainted: false };
  scan.prev = b;
  const near = a !== null && adjacent(text, a.end, start);
  if (f & W_CYR && f & W_FIRST && w.length >= 4 && !(near && (a.f & W_BRAND || PRODUCT_WORDS.has(a.w.toLowerCase())))) scan.words.push({ start, end: b.end, w });
  if (!a || !near) return;
  b.tainted = (a.f & W_TITLE) !== 0;
  if (a.tainted) return;
  const pair = (name: boolean, latin: boolean) => scan.pairs.push({ start: a.start, end: b.end, a: a.w, b: w, name, latin });
  if (isNamePair(a.f, f)) pair(true, false);
  else if (a.f & f & W_CYR && !b.tainted && !(f & W_TITLE) && nounPair(a, b)) pair(false, false);
  else if (a.f & f & W_LAT && !((a.f | f) & W_LATNOT)) pair(false, true);
}

function nounPair(a: CapTok, b: CapTok): boolean {
  const all = a.f | b.f;
  if (!(all & W_NOUN)) return true;
  if (all & W_HEAD || a.f & b.f & W_NOUN) return false;
  const [x, n] = a.f & W_NOUN ? [b, a] : [a, b];
  return (x.f & W_WORD) !== 0 && (nameShape(x.w) & (S_CONS | S_MSHORT)) !== 0 && givenNameLike(x.w, n.w);
}

function scanNames(text: string, scan: NameScan, to: number): void {
  to = Math.min(to, text.length);
  if (to <= scan.pos) return;
  const from = scan.pos > 0 ? scan.pos - 1 : 0, s = text.slice(from, to);
  let end = to;
  CAP_TOKEN.lastIndex = scan.pos - from;
  for (let m = CAP_TOKEN.exec(s); m; m = CAP_TOKEN.exec(s)) {
    const start = from + m.index;
    let w = m[0];
    if (start + w.length === to && to < text.length) {
      CAP_TOKEN_AT.lastIndex = start;
      w = CAP_TOKEN_AT.exec(text)![0];
      end = Math.max(end, start + w.length);
    }
    pushCapToken(text, scan, w, start);
  }
  scan.pos = end;
}

const NOUN_OBLIQUE = /(?:ки|ке|ку|кой|ии|ию|ией|ние|нии|ость|ости|ство|ства)$/iu;
const ADJ_FORM = /(?:ый|ой|ое|ые|ого|ому|ыми)$/iu;
const SURNAME_MASC = /(?:(?:ов|ев|ёв|ин|ын)(?:у|ым|ом|е)?|(?:ск|цк)(?:ий|ой|ого|ому|им|ом))$/iu;
const MALE_SHORT = new Set(("юра гриша рома федя гена саня вася кузьма фома фока леха тема никита илья савва лука данила гаврила женя саша "
  + "паша миша коля толя витя дима костя слава степа сема лева леня тима жора боря митя петя ваня сережа алеша вова володя серега леша "
  + "гоша кеша сеня даня стася мустафа муса иса хамза абдулла шота гоча яхья "
  + "валера яша андрюша андрюха антоша тоша тоха илюша илюха кирюша кирюха сева шура гера кузя фима ванюша никола тимоша тимоха жека "
  + "олежа вадя веня миха филя проша мотя ерема гаврюша аркаша валя "
  + "мирза гия гела коба зия ата ага таха сосо лаша нико").split(" "));
const knownShort = (l: string): boolean => FIRST_NAMES.has(l) || MALE_SHORT.has(l);
function maleShortName(o: string): boolean {
  const l = o.toLowerCase().replace(/ё/g, "е");
  if (knownShort(l)) return true;
  if (l.length < 4 || !l.endsWith("ка")) return false;
  const stem = l.slice(0, -2);
  return stem.endsWith("ь") ? knownShort(stem.slice(0, -1) + "я")
    : knownShort(stem + "а") || knownShort(stem + "я") || FIRST_NAMES.has(stem + "ий") || FIRST_NAMES.has(stem);
}
const S_GIVEN = 1, S_AYA = 2, S_MSHORT = 4, S_MASC = 8, S_CONS = 16;
const NOT_GIVEN = new Set([...[...COMMON_NOUNS].map((n) => n.replace(/(?:ов|ев|ей)$/, "")), ...("менеджер инженер диспетчер дизайнер лидер "
  + "тимлид брокер дилер провайдер девелопер мастер тренер стажер волонтер офицер репортер продюсер спикер юзер хакер блогер ритейлер "
  + "инспектор ревизор доктор ректор лектор тьютор ментор автор спонсор донор нотариус вектор фактор сектор мотор ассистент агент пациент "
  + "абонент респондент резидент президент претендент конкурент оппонент рецензент бухгалтер кассир курьер техник механик электрик "
  + "сантехник практик критик гид парсер сканер конвертер компилятор роутер контроллер компьютер принтер фильтр монитор детектор таймер "
  + "логгер раннер воркер экспортер импортер бот робот шлюз портал хаб мост импорт экспорт перенос вывод ввод перевод обмен обход поиск "
  + "запуск выпуск пропуск просмотр пересмотр осмотр досмотр расчет подсчет пересчет учет отчет синтез прогноз разбор выбор перебор надзор "
  + "совет штаб пул результат итог статус прогресс лимит порог пакет комплект прогон формат экран процессор движок поток объем размер "
  + "срок индекс номер вид грейд разряд ранг балл процент коэффициент кэш кеш буфер стек массив компонент контейнер инстанс хост домен "
  + "адрес логин аккаунт кабинет доступ вход выход маршрут трек сайт виджет дашборд дайджест вестник альманах бланк реквизит макет "
  + "прототип эскиз чертеж прайс бренд бонус купон промокод абонемент бейдж сертификат ключ токен секрет кейс фикс патч коммит апрув "
  + "бэкап дамп снапшот образ артефакт дистрибутив апдейт тираж маркет голос портрет сегмент опыт резерв приток отток рост трафик охват "
  + "спрос приход уход возврат "
  + "владелец руководитель координатор куратор дежурный").split(" ")]);
const NOUN_SUFFIX = /(?:щик|чик|ник|инг|изм|ист|лог|граф|бор|зор|ант|щий|ший|чий|жий|кий|гий|хий|ний|арий|орий)$|^.{4,}тор$/u;
const GIVEN_CONS = /[бвгджзклмнпрстфхцчшщй]$/u;
const nounLike = (l: string): boolean => NOT_GIVEN.has(l) || NOUN_SUFFIX.test(l);
const nameShapes = new Map<string, number>();
function nameShape(w: string): number {
  let f = nameShapes.get(w);
  if (f !== undefined) return f;
  const aya = /[ая]$/iu.test(w), l = w.toLowerCase().replace(/ё/g, "е");
  f = (!NOUN_OBLIQUE.test(w) && !ADJ_FORM.test(w) ? S_GIVEN : 0) | (aya ? S_AYA : 0) | (aya && maleShortName(w) ? S_MSHORT : 0)
    | (SURNAME_MASC.test(w) ? S_MASC : 0) | (GIVEN_CONS.test(l) && !nounLike(l) ? S_CONS : 0);
  if (nameShapes.size > 20000) nameShapes.clear();
  nameShapes.set(w, f);
  return f;
}
function givenNameLike(o: string, s: string): boolean {
  const f = nameShape(o);
  return (f & S_GIVEN) !== 0 && !((f & S_AYA) !== 0 && (f & S_MSHORT) === 0 && (nameShape(s) & S_MASC) !== 0);
}
function pairMatches(p: NamePair, local: string, localSkel: string): boolean {
  if (!p.latin) {
    const sur = (p.sur ??= (SURNAME.test(p.a) ? 1 : 0) | (SURNAME.test(p.b) ? 2 : 0)), sa = (sur & 1) !== 0, sb = (sur & 2) !== 0;
    if (!sur) return false;
    const [ka, kb] = (p.keys ??= [skelKey(p.a), skelKey(p.b)]);
    const inA = ka !== "" && localSkel.includes(ka), inB = kb !== "" && localSkel.includes(kb);
    const surA = sa && (inA || (!sb && inB)), surB = sb && (inB || (!sa && inA));
    if (!surA && !surB) return false;
    if (local.split(/[._+-]+/).filter((x) => /\p{L}/u.test(x)).length > 1) return true;
    return (surA && givenNameLike(p.b, p.a)) || (surB && givenNameLike(p.a, p.b));
  }
  const a = p.a.toLowerCase(), b = p.b.toLowerCase();
  const hasA = a.length >= 3 && local.includes(a), hasB = b.length >= 3 && local.includes(b);
  return (hasA && hasB) || ((hasA || hasB) && (LATIN_FIRST.has(skel(a)) || LATIN_FIRST.has(skel(b))));
}

const nameInAddress = (p: NamePair, localSkel: string): boolean => (p.keys ??= [skelKey(p.a), skelKey(p.b)]).some((x) => x !== "" && localSkel.includes(x));

const LOCAL_INITIAL = /^([a-z])[._-][a-z]{3,}\d{0,4}$/;
const INITIAL_LAT: Readonly<Record<string, string>> = { ю: "yuj", я: "yaj", е: "ey", ё: "ey", х: "hk", ж: "zjg", ц: "ct", й: "iyj", ч: "c", ш: "s", щ: "s" };
const initialOf = (w: string): string => { const c = w[0].toLowerCase(); return INITIAL_LAT[c] ?? TR[c] ?? ""; };

function mailboxKind(local: string): "role" | "mixed" | "person" {
  if (/no-?reply|do-?not-?reply|mailer-daemon/.test(local) || /(?:^|[._-])bot$/.test(local)) return "role";
  const parts = local.split(/[._+-]+/).filter((x) => x && !/^\d+$/.test(x));
  const roles = parts.filter((x) => ROLE_WORDS.has(x)).length;
  return !parts.length || !roles ? "person" : roles === parts.length ? "role" : "mixed";
}

interface Memo { scan?: NameScan; colon?: number; table?: number; signoffs?: number[]; signoff?: number; ctx?: [number, number]; cap?: [number, number]; issued?: boolean }

const SIGN_OFF = /(?<![\p{L}])(?:с уважением|с наилучшими пожеланиями|всего доброго|best regards|kind regards|regards|sincerely)[ \t]*[,!.]?[ \t]*\r?\n[ \t]*([^\n]{3,80})/giu;
const SIGN_OFF_SPAN = 300;

function signoffNames(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(SIGN_OFF)) {
    const words = m[1].match(/[\p{L}.-]+/gu) ?? [];
    if (words.some((w, i) => i > 0 && isNamePair(marks(words[i - 1]), marks(w)))) out.push(m.index + m[0].length);
  }
  return out;
}

function underSignoff(text: string, at: number, memo: Memo): boolean {
  const list = (memo.signoffs ??= signoffNames(text));
  let i = memo.signoff ?? 0;
  while (i < list.length && list[i] <= at - SIGN_OFF_SPAN) i++;
  memo.signoff = i;
  return i < list.length && list[i] <= at;
}

function emailNearName(m: RegExpExecArray, text: string, memo: Memo): boolean {
  const at = m.index, end = at + m[0].length, local = m[0].slice(0, m[0].indexOf("@")).toLowerCase();
  const kind = mailboxKind(local);
  if (kind === "role") return false;
  const line = text.slice(Math.max(0, at - 80), at);
  if (GIT_TRAILER.test(line) || GIT_HEADER.test(line)) return false;
  const scan = (memo.scan ??= { pos: 0, prev: null, pairs: [], head: 0, words: [], wHead: 0 }), from = at - NAME_WIDE_BEFORE, to = end + NAME_WIDE_AFTER;
  if (scan.pos < from) { scan.pos = from; scan.prev = null; scan.pairs.length = 0; scan.head = 0; scan.words.length = 0; scan.wHead = 0; }
  scanNames(text, scan, to);
  const pairs = scan.pairs;
  while (scan.head < pairs.length && pairs[scan.head].end <= from) scan.head++;
  if (scan.head > 64) { pairs.splice(0, scan.head); scan.head = 0; }
  let localSkel: string | null = null;
  for (let i = scan.head; i < pairs.length && pairs[i].start < to; i++) {
    const p = pairs[i], near = p.end > at - NAME_BEFORE && p.start < end + NAME_AFTER;
    if (p.name && near && kind === "person") return true;
    if (!p.name && (!near || kind !== "person")) continue;
    localSkel ??= skel(local);
    if (p.name ? nameInAddress(p, localSkel) : pairMatches(p, local, localSkel)) return true;
  }
  const words = scan.words;
  while (scan.wHead < words.length && words[scan.wHead].end <= at - NAME_BEFORE) scan.wHead++;
  if (scan.wHead > 64) { words.splice(0, scan.wHead); scan.wHead = 0; }
  if (kind === "person") {
    const ini = LOCAL_INITIAL.exec(local)?.[1];
    for (let i = scan.wHead; i < words.length && words[i].start < end + NAME_AFTER; i++) {
      const x = words[i];
      localSkel ??= skel(local);
      if ((x.key ??= skelKey(x.w)) !== "" && localSkel.includes(x.key)) return true;
      if (ini !== undefined && initialOf(x.w).includes(ini)) return true;
    }
  }
  return kind === "person" && underSignoff(text, at, memo);
}

const PASSPORT_OBJ = new RegExp("^(?:" + [
  re`инв\.?|инвентарн\p{L}{0,3}|сервер(?:а|у|ом|е|ы|ов|ам|ами|ах)?|оборудовани[еяюи]|оборудованием|издели(?:е|я|ю|ем|и|й|ям|ями|ях)`,
  re`объект(?:а|у|ом|е|ы|ов|ам|ами|ах)?|стойк(?:а|и|е|у|ой)|продукт(?:а|у|ом|е|ы|ов)?|продукци(?:я|и|ю|ей)|систем(?:а|ы|е|у|ой|ам|ами|ах)?`,
  re`качеств(?:о|а|у|ом|е)|безопасност(?:ь|и|ью)|проект(?:а|у|ом|е|ы|ов)?|прибор(?:а|у|ом|е|ы|ов)?|устройств(?:о|а|у|ом|е)?`,
  re`сертификат(?:а|у|ом|е|ы|ов)?|здани(?:е|я|ю|ем|и|й)|сооружени(?:е|я|ю|ем|и|й)|судн(?:о|а|у|ом|е)|судов|вагон(?:а|у|ом|е|ы|ов)?`,
  re`двигател(?:ь|я|ю|ем|е|и|ей)|модул(?:ь|я|ю|ем|е|и|ей)|программ(?:а|ы|е|у|ой)?|модел(?:ь|и|ью|ей)|датасет(?:а|у|ом|е|ы|ов)?`,
  re`набор(?:а|у|ом|е)?|сервис(?:а|у|ом|е|ы|ов)?|стенд(?:а|у|ом|е|ы|ов)?|вм|кластер(?:а|у|ом|е|ы|ов)?|узел|узл(?:а|у|ом|е|ы|ов)`,
  re`приложени(?:е|я|ю|ем|и|й)|компонент(?:а|у|ом|е|ы|ов)?|api|бд|инфраструктур(?:а|ы|е|у|ой)|станк(?:а|у|ом|е|и|ов)|станок|техник(?:и|е|у|ой)`,
  re`материал(?:а|у|ом|е|ы|ов)?|сырь(?:е|я|ю|ем)|веществ(?:о|а|у|ом|е)?|смес(?:ь|и)|агрегат(?:а|у|ом|е|ы|ов)?|трансформатор(?:а|у|ом|е|ы|ов)?`,
  re`насос(?:а|у|ом|е|ы|ов)?|котл(?:а|у|ом|е|ы|ов)|кот[её]л|лифт(?:а|у|ом|е|ы|ов)?|механизм(?:а|у|ом|е|ы|ов)?|машин(?:а|ы|е|у|ой)`,
  re`баз(?:а|ы|е|у|ой)`,
  re`обеспечени(?:е|я|ю|ем|и)|комплекс(?:а|у|ом|е|ы|ов|ам|ами|ах)?|средств(?:о|а|у|ом|е|ам|ами|ах)?|ресурс(?:а|у|ом|е|ы|ов)?`,
  re`решени(?:е|я|ю|ем|и|й)|платформ(?:а|ы|е|у|ой)?|установк(?:а|и|е|у|ой)|комплект(?:а|у|ом|е|ы|ов)?|состояни(?:е|я|ю|ем|и)`,
  re`процесс(?:а|у|ом|е|ы|ов)?|услуг(?:а|и|е|у|ой)?`,
].join("|") + ")$", "iu");
const PASSPORT_ABBR = /^(?:ПО|ИС|АИС|ГИС|АСУ|СУБД|ЦОД|ПАК|ПК|АРМ|СХД|ОС)$/u;
const PASSPORT_KIND = /^(?:техническ|программн|информационн|аппаратн|транспортн|энергетическ|санитарн|экологическ|пожарн|строительн|заводск|технологическ|ветеринарн)\p{L}{1,4}$/iu;
const PASSPORT_ADJ = /(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ым|им|ую|юю|ых|их|ыми|ими)$|^\p{Lu}{2,4}$/u;
const PASSPORT_SKIP = /^(?:для|на|по|к|ко|о|об|обо|наш\p{L}{0,3}|ваш\p{L}{0,3}|эт(?:от|а|о|и|ого|ой|ому|им|ом|у|их|ими)|данн(?:ый|ая|ое|ого|ой|ому|ым|ом|ую)|его|ее|их|тот|того|той|том|сво(?:й|я|е|ю|ей|его|ему|им|ем|и|их)|вс(?:е|ех|ем|еми))$/iu;
const PASSPORT_USE = /^(?:систем|программ|баз|проект|приложени|сервис|платформ|портал|учет)\p{L}{0,3}$/iu;
const PASSPORT_LEAD = /^[ \t\r\n:.,;«"'*_-]{0,6}\p{L}+(?:(?:[ \t]{1,3}|-)\p{L}+){0,4}/u;
const PASSPORT_BEFORE = /(?<![\p{L}])(\p{L}+)[ \t]{1,3}$/u;
const PASSPORT_NAME = /(?<![\p{L}\p{N}])(?:[А-ЯЁ][а-яё]{2,}(?:(?:ов|ев|ёв|ин|ын)(?:а|ой)?|енко|ук|юк|чук|швили|дзе|ян)(?![\p{L}])|[А-ЯЁ]\.[ \t]?[А-ЯЁ]\.)/gu;
const PLACE_ABBR = new Set(["г", "гор", "пос", "ул", "пр", "с", "д"]);
const PLACE_WORD = /^(?:в|во|из|город\p{L}{0,2}|улиц\p{L}{0,2}|район\p{L}{0,2})$/u;
function isLetter(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c < 0x80) return (c | 32) >= 97 && (c | 32) <= 122;
  return (c >= 0x400 && c <= 0x4ff) || /\p{L}/u.test(s[i]);
}
function wordBefore(s: string, e: number, from: number): string {
  let k = e;
  while (k > from && isLetter(s, k - 1)) k--;
  return s.slice(k, e);
}
function placeBefore(pl: string, i: number): boolean {
  const from = Math.max(0, i - 12), c = pl[i - 1];
  if (i <= from) return false;
  if (c === '"' || c === "«" || c === "„" || c === "“" || c === "'") return true;
  let k = i;
  if (c === " " || c === "\t") k--;
  if (k > from && pl[k - 1] === ".") return PLACE_ABBR.has(wordBefore(pl, k - 1, from).toLowerCase());
  if (k === i) return false;
  if (k > from && (pl[k - 1] === " " || pl[k - 1] === "\t")) k--;
  const w = wordBefore(pl, k, from);
  return w !== "" && PLACE_WORD.test(w.toLowerCase());
}
const PASSPORT_TITLE_GAP = /^(?:[ \t]{1,3}\p{Ll}+){0,2}[ \t]{1,3}$/u;
const PASSPORT_TITLE_WORD = /(?:ов|ев|ёв|ин|ын|енко|ук|юк|чук|швили|дзе|ян)$|^[А-ЯЁ]\.[ \t]?[А-ЯЁ]\.$/u;
const PASSPORT_NEXT = /^[ \t]{1,3}([А-ЯЁ][а-яё]*)(\.)?/u;
const PASSPORT_GIVEN = /^[А-ЯЁ][а-яё]{2,11}[бвгджзклмнпрстфхцчшщй]$/u;
const PASSPORT_TITLE_TAIL = new Set(("холдинг молл порт терминал групп инвест капитал трейд маркет строй моторс экспресс консалт девелопмент "
  + "логистик телеком софт тех лаб хаб плюс лайт макс мини онлайн инфо энерго нефтегаз агро транс сервис тауэр холл двор квартал мост берег "
  + "остров бор лес луг сад град кремль вал север юг запад восток "
  + "рынок пассаж пруд залив округ тракт проезд тупик мыс полуостров хребет перевал замок рудник карьер прииск комбинат причал элеватор "
  + "аэродром космодром полигон").split(" "));
function passportTitle(pl: string, obj: number, m: RegExpExecArray): boolean {
  if (!PASSPORT_TITLE_GAP.test(pl.slice(obj, m.index)) || !PASSPORT_TITLE_WORD.test(m[0])) return false;
  const next = PASSPORT_NEXT.exec(pl.slice(m.index + m[0].length));
  if (next === null || (next[1].length === 1 && next[2] === undefined)) return true;
  const w = next[1], l = w.toLowerCase(), noun = NOT_SURNAME.has(l) || COMMON_HEADS.has(l) || BRANDS.has(l);
  return !(next[2] !== undefined || firstName(l) || PATRONYMIC.test(w) || (/^[А-ЯЁ][а-яё]{1,6}[ая]$/u.test(w) && !noun)
    || (PASSPORT_GIVEN.test(w) && !noun && !/(?:ий|ый|ой)$/u.test(w) && !PASSPORT_TITLE_TAIL.has(l) && !PASSPORT_OBJ.test(w)));
}
const passportTitleNoun = (w: string, l: string): boolean => NOT_SURNAME.has(l) || COMMON_HEADS.has(l) || BRANDS.has(l)
  || PASSPORT_TITLE_TAIL.has(l) || PASSPORT_OBJ.test(w);
const CAP_CYR = /^[А-ЯЁ][а-яё]+$/u;
const skiyNeighbours = new Map<string, number>();
function skiyNeighbour(w: string): number {
  let k = skiyNeighbours.get(w);
  if (k !== undefined) return k;
  k = 0;
  if (CAP_CYR.test(w)) {
    const l = w.toLowerCase(), noun = passportTitleNoun(w, l), first = passportName(l);
    if (!noun && (first || /^[А-ЯЁ][а-яё]{1,6}[ая]$/u.test(w))) k |= 3;
    else if (!noun && l.endsWith("ь")) k |= 2;
    if (first || MALE_SHORT.has(l.replace(/ё/g, "е"))) k |= 4;
    if (!noun && !first && PASSPORT_GIVEN.test(w) && !/(?:ий|ый|ой)$/u.test(w)) k |= 8;
    if (PATRONYMIC.test(w) && !/(?:ой|ою)$/u.test(w)) k |= 16;
  }
  if (skiyNeighbours.size > 20000) skiyNeighbours.clear();
  skiyNeighbours.set(w, k);
  return k;
}
const isUpperCyr = (c: number): boolean => (c >= 0x410 && c <= 0x42f) || c === 0x401;
const isLowerCyr = (c: number): boolean => (c >= 0x430 && c <= 0x44f) || c === 0x451;
function skiyWord(pl: string, at: number, back: boolean): string {
  let k = at, n = 0;
  if (back) {
    while (k > 0 && n < 4 && (pl[k - 1] === " " || pl[k - 1] === "\t")) { k--; n++; }
    if (n === 0 || n > 3) return "";
    const e = k;
    while (k > 0 && isLowerCyr(pl.charCodeAt(k - 1))) k--;
    return k > 0 && k < e && isUpperCyr(pl.charCodeAt(k - 1)) && !(k > 1 && isLetter(pl, k - 2)) ? pl.slice(k - 1, e) : "";
  }
  while (k < pl.length && n < 4 && (pl[k] === " " || pl[k] === "\t")) { k++; n++; }
  if (n === 0 || n > 3 || !isUpperCyr(pl.charCodeAt(k)) || !isLowerCyr(pl.charCodeAt(k + 1))) return "";
  const s = k;
  while (k < pl.length && isLetter(pl, k)) k++;
  return pl.slice(s, k);
}
function passportSkiy(pl: string): boolean {
  for (let i = pl.indexOf("к", 3); i > 0; i = pl.indexOf("к", i + 1)) {
    const c = pl[i - 1], fem = pl[i + 1] === "а" && pl[i + 2] === "я";
    if ((c !== "с" && c !== "ц") || !(fem || (pl[i + 1] === "и" && pl[i + 2] === "й"))) continue;
    const end = i + 3;
    if (end < pl.length && isLetter(pl, end)) continue;
    let st = i - 1;
    while (st > 0 && isLowerCyr(pl.charCodeAt(st - 1))) st--;
    if (st === 0 || end - st < 6 || !isUpperCyr(pl.charCodeAt(st - 1))) continue;
    st--;
    if (st > 0 && (isLetter(pl, st - 1) || (pl.charCodeAt(st - 1) >= 48 && pl.charCodeAt(st - 1) <= 57))) continue;
    const next = skiyWord(pl, end, false), prev = skiyWord(pl, st, true);
    const nk = next !== "" ? skiyNeighbour(next) : 0, pk = prev !== "" ? skiyNeighbour(prev) : 0;
    if ((nk & (fem ? 2 : 1) || pk & 20 || (nk & 8 && skiyPatronymic(pl, end, next))) && !placeBefore(pl, st)) return true;
  }
  return false;
}
function skiyPatronymic(pl: string, end: number, next: string): boolean {
  let k = end;
  while (k < pl.length && (pl[k] === " " || pl[k] === "\t")) k++;
  const p = skiyWord(pl, k + next.length, false);
  return p !== "" && PATRONYMIC.test(p);
}
const PASSPORT_ROLE_ANY = /ственн|ладел|ржател|явител|лучател/;
const PASSPORT_ROLE = /(?<![\p{L}])(?:[Сс]обственни(?:к|ца)|[Вв]ладел(?:ец|ица)|[Оо]тветственн(?:ый|ая)|[Дд]ержател(?:ь|ьница)|[Зз]аявител(?:ь|ьница)|[Пп]олучател(?:ь|ьница))[ \t]{0,3}[:—–-]?[ \t]{1,3}([А-ЯЁ][а-яё]+)[ \t]{1,3}([А-ЯЁ][а-яё]+)(?:[ \t]{1,3}([А-ЯЁ][а-яё]+))?[ \t]{0,3}[),.;:№—–-]{0,4}[ \t]{0,3}$/u;
const PASSPORT_ROLE_SURNAME = /^[А-ЯЁ][а-яё]{2,}(?:[сц]к(?:ий|ая)|(?:ов|ев|ёв|ин|ын)а?|енко|ук|юк|чук|швили|дзе|ян)$/u;
const PASSPORT_ROLE_ORG = /(?:завод|парк|канал|маркет|флот|порт|банк|центр|комбинат|театр|музей|вокзал|суд|фонд|тех|сервис|строй|трест|союз|клуб|отдел|филиал|институт|колледж|лицей|район|совет|комитет|надзор|хоз|никель|уголь|хлеб|текстиль|ситец|разрез|гараж|цирк|монастырь|приход|госпиталь|лагерь|рудник|карьер|прииск|кооператив|холдинг|концерн|альянс|рынок|двор|собор|храм|цемент|металл|нефть|газ|лес|мех|пром|снаб|сбыт|торг)$/u;
function passportRoleName(w: string): boolean {
  if (PASSPORT_ROLE_ORG.test(w.toLowerCase())) return false;
  const k = skiyNeighbour(w);
  return (k & 23) !== 0 || ((k & 8) !== 0 && w.length <= 8);
}
function passportRole(pl: string): boolean {
  if (!PASSPORT_ROLE_ANY.test(pl)) return false;
  const m = PASSPORT_ROLE.exec(pl);
  if (m === null) return false;
  for (let i = 1; i <= 3 && m[i] !== undefined; i++) {
    if (!PASSPORT_ROLE_SURNAME.test(m[i])) continue;
    for (let j = 1; j <= 3 && m[j] !== undefined; j++) if (j !== i && passportRoleName(m[j])) return true;
  }
  return false;
}
function passportPerson(pl: string, obj: number): boolean {
  PASSPORT_NAME.lastIndex = 0;
  for (let m = PASSPORT_NAME.exec(pl); m; m = PASSPORT_NAME.exec(pl)) {
    if (placeBefore(pl, m.index)) continue;
    const e = m[0].length > 4 ? m[0].charCodeAt(m[0].length - 1) : 0;
    if (e === 0x430 || e === 0x439) {
      const b = m[0].slice(0, e === 0x430 ? -1 : -2).toLowerCase();
      if (NOT_SURNAME.has(b) || PASSPORT_TITLE_TAIL.has(b)) continue;
    }
    if (obj >= 0 && m.index >= obj && passportTitle(pl, obj, m)) continue;
    return true;
  }
  return passportSkiy(pl)
    || passportRole(pl);
}
function wordEnd(s: string, w: string): number {
  for (let i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + 1)) {
    if (!(i > 0 && isLetter(s, i - 1)) && !(i + w.length < s.length && isLetter(s, i + w.length))) return i + w.length;
  }
  return s.length;
}
let passportWords: string[] = [], passportObjWord = "";
function passportObject(pl: string, noun: boolean): number {
  const words = PASSPORT_LEAD.exec(pl)?.[0].replace(/(?<=\p{L}[ое])-(?=\p{L})/gu, "").match(/\p{L}+/gu) ?? [];
  passportWords = words;
  passportObjWord = "";
  let i = 0, use = false;
  for (; i < 2 && i < words.length && PASSPORT_SKIP.test(words[i]) && !PASSPORT_ABBR.test(words[i]); i++) if (/^для$/iu.test(words[i])) use = true;
  for (let j = i; j < words.length && j < i + 3; j++) {
    const w = words[j];
    if (PASSPORT_ABBR.test(w)) return wordEnd(pl, w);
    if (PASSPORT_OBJ.test(w)) {
      if (use && PASSPORT_USE.test(w)) return -1;
      passportObjWord = w;
      return wordEnd(pl, w);
    }
    if (/^данных$/iu.test(w)) return (j === 0 ? noun : !/^(?:персональн|личн|паспортн)/iu.test(words[j - 1])) ? wordEnd(pl, w) : -1;
    if (!PASSPORT_ADJ.test(w) && !PASSPORT_ADJ.test(w.toLowerCase()) && !PASSPORT_KIND.test(w)) return -1;
  }
  return -1;
}
const PASSPORT_FIELD = /(?<![\p{L}])(?:инн|снилс|огрн(?:ип)?|кпп|тел(?:ефон\p{L}{0,3})?|моб(?:ильн\p{L}{0,3})?|inn|snils|phone|tel)[^\p{L}\d]{0,6}$/iu;
const PASSPORT_UNIT = /^[ \t]{0,3}(?:байт|bytes?|кб|мб|гб|строк|мс|ms|сек|unix|\(unix|записей|токенов|шт)/iu;
const PASSPORT_INV = /(?<![\p{L}])(?:инв\.?|инвентарн\p{L}{0,3}|серийн\p{L}{0,3}|заводск\p{L}{0,3}|s\/n)(?:[ \t]{1,3}(?:номер\p{L}{0,2}|№|no\.?|n|number))?[ \t.:№#-]{0,6}$/iu;
const PASSPORT_HOLDER = /(?<![\p{L}])(?:гражданин\p{L}{0,2}|граждан|сотрудник\p{L}{0,2}|работник\p{L}{0,2}|клиент\p{L}{0,2}|заявител\p{L}{1,2}|владельц\p{L}{1,2}|физ(?:\.|ическ\p{L}{1,3})[ \t]?лиц\p{L}{0,2}|рф)(?![\p{L}])/iu;
const PASSPORT_HOLDER_STEMS = re`водител\p{L}{1,3}|иностран(?:ец|ц\p{L}{1,3})`
  + re`|получател\p{L}{1,3}|пациент\p{L}{0,3}|студент\p{L}{0,3}|пассажир\p{L}{0,3}|учащ\p{L}{2,4}|ученик\p{L}{0,3}|школьник\p{L}{0,3}|абитуриент\p{L}{0,3}`
  + re`|заемщик\p{L}{0,3}|должник\p{L}{0,3}|арендатор\p{L}{0,3}|нанимател\p{L}{1,3}|покупател\p{L}{1,3}|продавц\p{L}{1,3}|собственник\p{L}{0,3}`
  + re`|участник\p{L}{0,3}|кандидат\p{L}{0,3}|соискател\p{L}{1,3}|пенсионер\p{L}{0,3}|ребенк\p{L}{1,3}|родител\p{L}{1,3}|опекун\p{L}{0,3}`
  + re`|супруг\p{L}{0,3}|наследник\p{L}{0,3}|представител\p{L}{1,3}|доверител\p{L}{1,3}|поручител\p{L}{1,3}|страховател\p{L}{1,3}`
  + re`|застрахованн\p{L}{2,4}|военнослужащ\p{L}{2,4}|мигрант\p{L}{0,3}|беженц\p{L}{1,3}|пользовател\p{L}{1,3}|человек\p{L}{0,2}`
  + re`|абонент\p{L}{0,3}|подписант\p{L}{0,3}|посетител\p{L}{1,3}`;
const PASSPORT_HOLDER_WORD = new RegExp(`^(?:${PASSPORT_HOLDER_STEMS})$`, "iu");
const PASSPORT_ADJ_GEN = /(?:ого|его|ой|ей|ых|их)$/iu;
const PASSPORT_ISSUED = /(?<![\p{L}])(?:выдан\p{L}{0,2}|дата[ \t]{1,3}выдачи|код[ \t]{1,3}подразделени\p{L}{0,2})(?![\p{L}])/iu;
const PASSPORT_OWNER = /^[А-ЯЁ][а-яё]{1,20}$/u;
const PASSPORT_THING = new Set(("коммутатор маршрутизатор роутер свитч хаб ноутбук нетбук компьютер моноблок планшет телефон смартфон "
  + "коммуникатор шкаф стеллаж стол стул кресло принтер сканер плоттер копир датчик контроллер монитор дисплей экран проектор телевизор "
  + "модем адаптер конвертер медиаконвертер трансивер кабель провод патчкорд щит щиток шлюз хранилище накопитель носитель диск массив блок "
  + "терминал киоск банкомат регистратор видеорегистратор аккумулятор генератор кондиционер вентилятор компрессор радиатор обогреватель "
  + "холодильник счетчик теплосчетчик электросчетчик водосчетчик расходомер пульт маяк бокс ящик контейнер сейф замок турникет шлагбаум "
  + "домофон микроскоп спектрометр анализатор хроматограф тепловизор осциллограф мультиметр источник преобразователь инвертор "
  + "стабилизатор выключатель рубильник автомат котел бойлер фильтр клапан кран резервуар бак баллон огнетушитель извещатель передатчик "
  + "приемник усилитель автомобиль автобус трактор погрузчик экскаватор прицеп фургон грузовик самолет вертолет дрон робот инструмент "
  + "мотор редуктор привод трубопровод газопровод водопровод теплообменник картридж ключ токен цех этаж кабинет зал участок "
  + "люк поле").split(" "));
function passportThing(l: string): boolean {
  const s = l.slice(0, -1).replace(/ё/g, "е");
  return /(?:атор|метр|скоп|граф)$/u.test(s) || PASSPORT_THING.has(s) || PASSPORT_THING.has(s + "ь") || PASSPORT_THING.has(s + "й")
    || PASSPORT_THING.has(s + "е") || PASSPORT_THING.has(s + "о") || (s.endsWith("к") && PASSPORT_THING.has(s.slice(0, -1) + "ок"));
}
const PASSPORT_OWNER_SURNAME = /(?:ов|ев|ёв|ин|ын|чук|ян|янц)а$|(?:ск|цк)ого$|(?:ов|ев|ёв)ича$|(?:берг|штейн|манн?)а$|^.{4,}(?:щук|чук|юк)а$/u;
const PASSPORT_MAN_NOUN = new Set("карман туман обман шаман дурман талисман".split(" "));
const PASSPORT_SKOGO = /(?:ск|цк)ого$/u;
const PASSPORT_NAMES = new Set(("остап арсен хасан нестор аслан алан зураб заур расул юсуф равиль анвар байрам вагиф джамал ильдус арман улугбек "
  + "фархад тигран карен джамшид армен самвел гурген левон мурад ибрагим султан мансур кайрат серик ержан прохор наум макс арам артак ваге "
  + "вазген геворг гагик нарек норайр рубен сурен ваган вардан ованес оганес акоп айк арутюн гайк мгер мкртич гиви гоги леван ираклий нодар "
  + "отар реваз тамаз теймураз вахтанг мераб автандил бадри гурам джемал заза ладо малхаз резо тенгиз шалва азер анар вугар гусейн кямран "
  + "мамед орхан рамиз рашад садых тофик фуад эльчин эльнур эмин ягуб фаик фикрет абдул мухаммад мухаммед магомет рамзан саид хусейн умар "
  + "сулейман харун зелимхан казбек алихан ахмад ахмат гаджи абубакар идрис муслим тамерлан хамзат ильгиз ильфат рафис фанис фаниль фарит "
  + "халил хамит наиль нияз раис ранис рифат ансар ильсур айнур ильмир ильназ ленар марсель шерзод бахтиер ботир жасур санжар акмал алишер "
  + "бахром дильшод жахонгир камол нодир равшан сардор шухрат умид хуршид отабек асхат бауыржан галым ерлан ербол жандос куаныш мейрам "
  + "нуржан олжас самат талгат ерболат ипполит аристарх игнатий исаак касьян клим кондрат лаврентий мартын никифор овсей панкрат пантелей "
  + "парамон потап савелий сидор спиридон трофим фадей фрол харитон эраст яким аким афанасий архип емельян епифан зиновий илларион исай "
  + "лазарь лукьян любомир мирослав модест мстислав никодим осип пахом порфирий самуил севастьян серафим сильвестр соломон филат велимир "
  + "ратмир радомир майкл генри джон джеймс джордж дэвид дэниел кевин мартин томас уильям фрэнк ричард питер стив карл курт отто ганс франц "
  + "фриц людвиг вальтер вильгельм генрих эрнст ханс алекс бен сэм тед билл боб пьер жан луи анри жак "
  + "эстер ирен кармен моника жаклин джессика кэтрин мэри линда сара эмма оливия софи изабелла хелен эльза грета ирма мадлен жанетт кристин "
  + "николь мишель натали ивонн эллен агата аглая ада аделаида аксинья алевтина анфиса ариадна белла берта бронислава ванда виталина "
  + "владлена гертруда глафира доминика дина ефросинья ираида капитолина клара лана леся лолита люся марфа мирра нонна пелагея прасковья "
  + "руслана серафима стелла сусанна тереза фаина элеонора ядвига ася нелли инга аида ануш гаяне лусине мариам сона седа нуне ани нино "
  + "тамар кетеван манана натела этери айгюн гюнай севиль нигяр гюльнара залина хадижат айшат наргиз нигора дилноза шахноза феруза севара "
  + "гульмира жанар жулдыз сауле асем "
  + "рамазан эрнест альфред рудольф гарик адриан эльмар эдвард арнольд густав оскар ефрем владлен руфат даурен бекзат бахтияр фаррух "
  + "даниэль натан рональд стефан ирэн хайдар давит бронислав герасим демьян евдоким ерофей филимон абрам вилен марлен мухтар моисей "
  + "евсей гурий влас тит леон вольдемар бернард леонард жорж").split(" "));
const PASSPORT_SURNAMES = new Set(("мельник кравец бондарь ткач гончар кузнец коваль гоголь швец жук рыбак козак боднар кучер олейник кушнир "
  + "пономарь стельмах мороз литвин лях лебедь соловей воробей кац коган шапиро горовиц ландау мюллер шмидт шнайдер фишер вебер майер мейер "
  + "вагнер беккер шульц келлер рихтер клейн вольф шредер крюгер вернер кох бауэр шуберт штраус смит джонсон уильямс браун джонс миллер "
  + "дэвис уилсон андерсон тейлор томпсон робинсон кларк льюис уокер аллен кинг райт скотт грин адамс бейкер нельсон хилл кэмпбелл митчелл "
  + "робертс картер паркер коллинз эванс тернер").split(" "));
const PASSPORT_SHORT_SURNAMES = new Set("ким пак ли цой тен хан ан юн чен ван лим нам ву хо тан сун кан чан дин лин лю ма хе".split(" "));
const PASSPORT_ALL_NAMES: ReadonlySet<string> = new Set([...FIRST_NAMES, ...PASSPORT_NAMES]);
const passportName = (l: string): boolean => nameIn(PASSPORT_ALL_NAMES, l.replace(/ё/g, "е"));
function passportSurname(n: string): boolean {
  if (!/[ая]$/u.test(n)) return false;
  const s = n.slice(0, -1);
  return PASSPORT_SURNAMES.has(s) || (n.endsWith("я") && (PASSPORT_SURNAMES.has(s + "ь") || PASSPORT_SURNAMES.has(s.slice(0, -1) + "ей")))
    || (s.length > 3 && PASSPORT_SURNAMES.has(s.slice(0, -1) + "е" + s.slice(-1)));
}
const PASSPORT_SKOGO_ADJ = /(?:еск|ийск|тельск|нтск|ерск|торск)ого$/u;
const PASSPORT_SKOGO_PLACE = new Set(("московск кировск новосибирск краснодарск красноярск хабаровск омск томск курск брянск смоленск тверск "
  + "рязанск тульск калужск ярославск костромск владимирск нижегородск самарск саратовск волгоградск астраханск ростовск воронежск белгородск "
  + "тамбовск пензенск ульяновск казанск татарск башкирск удмуртск чувашск мордовск пермск свердловск челябинск тюменск курганск оренбургск "
  + "иркутск читинск якутск магаданск камчатск сахалинск амурск мурманск вологодск карельск псковск новгородск калининградск ленинградск "
  + "петербургск крымск кубанск донск дагестанск чеченск алтайск бурятск кавказск сибирск приморск советск ленинск калининск фрунзенск "
  + "пушкинск выборгск адмиралтейск красносельск кронштадтск петроградск василеостровск красногвардейск городск сельск морск детск женск "
  + "мужск российск европейск азиатск американск английск немецк французск китайск японск индийск турецк итальянск испанск финск шведск "
  + "норвежск датск белорусск украинск казахск узбекск таджикск киргизск армянск грузинск азербайджанск заводск уральск октябрьск "
  + "ставропольск архангельск кольск тобольск симферопольск севастопольск польск ноябрьск "
  + "складск банковск медицинск липецк ижорск касперск хозяйск крестьянск дворянск христианск армейск флотск царск монастырск депутатск "
  + "судейск адвокатск казначейск университетск институтск канцелярск секретарск солдатск генеральск адмиральск").split(" "));
const passportSkogoAdj = (n: string): boolean => PASSPORT_SKOGO_ADJ.test(n) || PASSPORT_SKOGO_PLACE.has(n.slice(0, -3));
const PASSPORT_SHORT_NOT = new Set(("из от при что без уже как или еще нет до то раз ни чем кто это за он где со под но две обе три кем был бы сам там так "
  + "вне во тем им той ней они ту нас мы ним вы них про оно над чей мог тут да ой мне ты вот нам ну уж та те же не ей ему мои всю "
  + "мой мое мою моя чья чье чью нее нем см ср др стр рис гл ст млн тыс руб мин сек год час мес дн шт кв").split(" "));
const passportNounWord = (w: string, l: string, n: string, s: string): boolean => NOT_SURNAME.has(l) || COMMON_HEADS.has(l) || BRANDS.has(l)
  || PASSPORT_THING.has(n) || PASSPORT_TITLE_TAIL.has(n) || NOT_SURNAME.has(s) || COMMON_HEADS.has(s) || PASSPORT_TITLE_TAIL.has(s)
  || PASSPORT_OBJ.test(w) || PASSPORT_KIND.test(w) || passportThing(l);
const PASSPORT_SHORT_HOMONYM = new Set("тема гена саня сеня даня".split(" "));
const passportMaleShort = (b: string): boolean => MALE_SHORT.has(b) && !PASSPORT_SHORT_HOMONYM.has(b);
function passportOwner(w: string): boolean {
  if (!PASSPORT_OWNER.test(w)) return false;
  const l = w.toLowerCase();
  if (PASSPORT_SKOGO.test(l)) return !PASSPORT_KIND.test(w);
  if (passportName(l)) return !PASSPORT_TITLE_TAIL.has(l);
  const n = l.replace(/ё/g, "е"), s = n.slice(0, -1), e = n.charCodeAt(n.length - 1), e2 = n.charCodeAt(n.length - 2);
  if (e === 0x44f && (e2 === 0x438 || e2 === 0x435)) return false;
  if ((e === 0x438 || e === 0x44b) && (passportMaleShort(s + "а") || passportMaleShort(s + "я"))) return true;
  if ((e === 0x430 || e === 0x44f) && passportSurname(n)) return true;
  if (w.length > 4 ? e !== 0x430 || !PASSPORT_OWNER_SURNAME.test(l) || PASSPORT_MAN_NOUN.has(s) : w.length === 4 ? !/[ая]$/u.test(l) || /(?:ия|ья|ея|ая|яя)$/u.test(l)
    : PASSPORT_SHORT_NOT.has(n) || PASSPORT_SKIP.test(w) || (!/[ая]$/u.test(l) && !PASSPORT_SHORT_SURNAMES.has(n))) return false;
  return !passportNounWord(w, l, n, s);
}
const passportOwners = new Map<string, number>();
function passportFirstKind(w: string): number {
  let owner = 0;
  if (isUpperCyr(w.charCodeAt(0))) {
    const r = passportOwners.get(w);
    if (r !== undefined) owner = r;
    else {
      owner = passportOwner(w) ? (PASSPORT_SKOGO.test(w) ? (passportSkogoAdj(w.toLowerCase().replace(/ё/g, "е")) ? 28 : 12) : 4) : 0;
      if (passportOwners.size > 20000) passportOwners.clear();
      passportOwners.set(w, owner);
    }
  }
  return (PASSPORT_HOLDER_WORD.test(w) ? 1 : 0) | (PASSPORT_ADJ_GEN.test(w) ? 2 : 0) | owner;
}
const PASSPORT_NAME_HEADS: ReadonlySet<string> = new Set([...PASSPORT_ALL_NAMES, ...Object.keys(NAME_FLEETING)].map((n) => n.slice(0, 2)));
function passportPatronymicGen(w: string): boolean {
  const e = w.charCodeAt(w.length - 1), e2 = w.charCodeAt(w.length - 2);
  return ((e === 0x430 && e2 === 0x447) || (e === 0x44b && e2 === 0x43d)) && PATRONYMIC.test(w);
}
let pairLastWord = "", pairLastName = false;
function passportPairName(w: string): boolean {
  if (w === pairLastWord) return pairLastName;
  pairLastWord = w;
  return (pairLastName = passportPairNameOf(w));
}
function passportPairNameOf(w: string): boolean {
  if (passportPatronymicGen(w)) return true;
  const e = w.charCodeAt(w.length - 1);
  if (w.length < 4 || !(e === 0x430 || e === 0x44f || e === 0x44b || e === 0x438 || e === 0x443 || e === 0x44e || e === 0x435 || e === 0x439
    || e === 0x43c) || !PASSPORT_NAME_HEADS.has(w[0].toLowerCase() + (w[1] === "ё" ? "е" : w[1])) || !PASSPORT_OWNER.test(w)) return false;
  const n = w[0].toLowerCase() + w.slice(1);
  return passportNameOblique(n.includes("ё") ? n.replace(/ё/g, "е") : n);
}
function passportPairSurname(w: string): boolean {
  if (w.length < 4 || !PASSPORT_OWNER.test(w)) return false;
  const l = w.toLowerCase(), n = l.replace(/ё/g, "е");
  return !passportName(l) && !passportNounWord(w, l, n, n.slice(0, -1));
}
function passportPair(w: string, words: string[]): boolean {
  const e = w.charCodeAt(w.length - 1);
  if (e === 0x438 || e === 0x44b) {
    if (!(words.length > 2 && passportPatronymicGen(words[2]) && passportPairName(words[1]))) return false;
  } else if (!passportPairName(words[1])) return false;
  return passportPairSurname(w);
}
const skogoOwner = (next: string | undefined, adj: boolean): boolean => next === undefined ? !adj : isUpperCyr(next.charCodeAt(0))
  && (next.length === 1 || passportName(next.toLowerCase()));
const PASSPORT_SKOGO_GAP = /[ \t\r\n([*_]+|<br[ \t]*\/?>/iy;
const PASSPORT_SKOGO_MARK = /^(?:инв|серийн|заводск)/iu;
function skogoNext(pl: string, a: number): string | undefined {
  let k = a;
  while (k < pl.length && (isLetter(pl, k) || pl[k] === "-")) k++;
  const from = k;
  for (PASSPORT_SKOGO_GAP.lastIndex = k; PASSPORT_SKOGO_GAP.test(pl); PASSPORT_SKOGO_GAP.lastIndex = k) k = PASSPORT_SKOGO_GAP.lastIndex;
  if (k === from) return undefined;
  const s = k;
  while (k < pl.length && isLetter(pl, k)) k++;
  const w = pl.slice(s, k);
  return w === "" || PASSPORT_SKOGO_MARK.test(w) ? undefined : w;
}
function passportNameOblique(n: string): boolean {
  for (const [e, base] of NAME_CASES) {
    if (n.length < e.length + 3 || !n.endsWith(e)) continue;
    const s = n.slice(0, -e.length);
    for (const b of base) if (PASSPORT_ALL_NAMES.has(s + b)) return true;
    if (PASSPORT_ALL_NAMES.has(NAME_FLEETING[s] ?? "")) return true;
  }
  return false;
}
function passportFirst(pl: string, words: string[]): boolean {
  let a = 0;
  while (a < 4 && (pl[a] === " " || pl[a] === "\t")) a++;
  const w = words[0];
  if (w === undefined || a === 0 || a > 3 || pl[a] !== w[0]) return false;
  for (let i = 0, k = passportFirstKind(w); ; k = passportFirstKind(words[i])) {
    if (k & 1 || (i === 0 && k & 4 && (!(k & 8) || skogoOwner(words.length > 1 ? words[1] : skogoNext(pl, a), (k & 16) !== 0)))) return true;
    if (i === 0 && !(k & 4) && words.length > 1 && isUpperCyr(words[1].charCodeAt(0)) && passportPair(w, words)) return true;
    if (!(k & 2) || ++i > 2 || i >= words.length) return false;
  }
}
const PASSPORT_COPY = /(?<![\p{L}])(?:копи[яиюей]|ксерокопи[яиюей]|скан\p{L}{0,4}|фото\p{L}{0,6})[ \t]{1,3}$/iu;
const PASSPORT_ISSUED_ANY = /выда|подразд/i;
function passportIssued(m: RegExpExecArray, text: string, pl: string, memo: Memo): boolean {
  if (!(memo.issued ??= PASSPORT_ISSUED_ANY.test(text))) return false;
  return passportIssuedNear(m, text, pl);
}
function passportIssuedNear(m: RegExpExecArray, text: string, pl: string): boolean {
  const end = m.index + m[0].length, near = text.slice(end, end + 60);
  return (PASSPORT_ISSUED_ANY.test(pl) && PASSPORT_ISSUED.test(pl)) || (PASSPORT_ISSUED_ANY.test(near) && PASSPORT_ISSUED.test(near));
}
const PASSPORT_INNER_SEP = String.raw`\p{L}{0,6}[ \t\r\n:.,;«"'*_-]{1,6}`, PASSPORT_INNER_THING = String.raw`(?:${PASSPORT_OBJ.source.slice(4, -2)})(?![\p{L}])`;
const PASSPORT_INNER_ADJ = String.raw`(?:(?!данн)\p{L}{2,}(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ым|им|ую|юю|ых|их|ыми|ими)[ \t]{1,3}){0,2}`;
const PASSPORT_INNER_OBJ = String.raw`(?!${PASSPORT_INNER_SEP}(?:(?:(?:${PASSPORT_SKIP.source.slice(4, -2).replace(/^для\|/u, "")})[ \t]{1,3}){0,2}${PASSPORT_INNER_ADJ}`
  + String.raw`(?!инв)${PASSPORT_INNER_THING}|для[ \t]{1,3}${PASSPORT_INNER_ADJ}`
  + String.raw`(?!инв|${PASSPORT_USE.source.slice(4, PASSPORT_USE.source.indexOf(")"))})${PASSPORT_INNER_THING}))`;
const PASSPORT_INNER = new RegExp(String.raw`(?:паспорт|passport)(?<![\p{L}](?:паспорт|passport))${PASSPORT_INNER_OBJ}`, "iu");
const PASSPORT_HOLDER_AT = PASSPORT_HOLDER.source.slice(PASSPORT_HOLDER.source.indexOf("(?:"));
const PASSPORT_KIND_HOLDER = new RegExp(String.raw`^[ \t]{1,3}${PASSPORT_HOLDER_AT}`, "iu");
const PASSPORT_INNER_K = new RegExp(String.raw`(?:паспорт|passport)(?<![\p{L}](?:паспорт|passport))(?:(?<!(?<![\p{L}])`
  + String.raw`(?:${PASSPORT_KIND.source.slice(4, PASSPORT_KIND.source.indexOf(")"))}|электронн)\p{L}{1,4}[ \t]{1,3}(?:паспорт|passport))`
  + String.raw`|(?=\p{L}{0,6}[ \t]{1,3}${PASSPORT_HOLDER_AT}))${PASSPORT_INNER_OBJ}`, "iu");
const PASSPORT_UNIT_AT = new RegExp(PASSPORT_UNIT.source.slice(1), "iuy");
let passportInnerRe: RegExp | undefined, passportInnerSkip = "", passportInnerSkipAll = false, passportInvReject = false;
function passportOk(m: RegExpExecArray, text: string, memo: Memo): boolean {
  if (passportOkOne(m, text, memo)) return true;
  const pl = m.groups?.pl, inv = passportInvReject;
  if (pl === undefined || pl.length < 9 || (pl === passportInnerSkip && (passportInnerSkipAll || !inv))) return false;
  const rx = inv ? PASSPORT_INNER : PASSPORT_INNER_K;
  let k = pl.search(rx);
  if (k < 0) {
    passportInnerSkip = pl;
    passportInnerSkipAll = inv;
    return false;
  }
  PASSPORT_UNIT_AT.lastIndex = m.index + m[0].length;
  if (PASSPORT_UNIT_AT.test(text) || PASSPORT_FIELD.test(pl)) return false;
  const from = m.index + m[0].search(/\d/) - pl.length;
  const re = (passportInnerRe ??= new RegExp(BUILTIN_OPEN_CHECK_RULES.find((r) => r.name === "passport")!.pattern, "iuy"));
  while (k >= 0) {
    re.lastIndex = from + k;
    const inner = re.exec(text);
    if (inner !== null && passportOk(inner, text, memo)) {
      m.index = inner.index;
      return true;
    }
    const next = pl.slice(k + 7).search(rx);
    k = next < 0 ? -1 : k + 7 + next;
  }
  return false;
}
function passportOkOne(m: RegExpExecArray, text: string, memo: Memo): boolean {
  const pl = m.groups?.pl;
  if (pl !== undefined) {
    let obj = passportObject(pl, /^паспорт(?:а|у|ом|е)?(?![\p{L}])/iu.test(m[0]));
    passportInvReject = /^п/iu.test(m[0]) && PASSPORT_INV.test(pl.slice(-32));
    if (passportInvReject) {
      if (obj >= 0) {
        if (!(memo.issued ??= PASSPORT_ISSUED_ANY.test(text)) || !/^инв/iu.test(passportObjWord) || !passportIssuedNear(m, text, pl)) return false;
        obj = -1;
      } else if (!(PASSPORT_HOLDER.test(pl) || PASSPORT_COPY.test(text.slice(Math.max(0, m.index - 24), m.index)) || passportPerson(pl, obj)
        || passportFirst(pl, passportWords) || passportIssued(m, text, pl, memo))) return false;
      passportInvReject = false;
    }
    const person = passportPerson(pl, obj);
    if (!person && obj >= 0) return false;
    if (PASSPORT_FIELD.test(pl)) return false;
    const before = PASSPORT_BEFORE.exec(text.slice(Math.max(0, m.index - 30), m.index))?.[1];
    if (!person && before !== undefined && PASSPORT_KIND.test(before) && !PASSPORT_KIND_HOLDER.test(pl)) return false;
  }
  return !PASSPORT_UNIT.test(text.slice(m.index + m[0].length, m.index + m[0].length + 12));
}

const ISO_NUMERIC = new Set(["643", "810", "840", "978", "398", "933", "826", "156", "756", "980", "392"]);
const AMOUNT_UNIT = /^[ \t]?(?:знак|разряд|цифр|digit|decimal|год|г\.|year|кв\.|квартал)/iu;
const SIGN_UNIT = /^\d*(?:[.,]\d+)?[ \t]?(?:знак|разряд|цифр|символ|px|пикс|pt|em|rem|%)/iu;
const M_END = "(?:а|у|ом|е|ы|и|ов|ам|ами|ах)?";
const HYPHEN_BIZ = re`-(?:поддержк|обслуживан|сопровожден|услуг|сервис|сервер|консалтинг|консультац|аудит|договор|контракт|соглашен|лицензи|подписк|тариф|пакет|support|service|server|contract|licen|subscription)`;
const STRONG_RU = re`(?:токен|символ|байт|контекст)${M_END}|запрос${M_END}(?![ \t]{1,3}(?:котировок|предложени\p{L}{0,3}|цен(?![\p{L}])|на[ \t]{1,3}грант))`
  + re`|(?<!товарн\p{L}{0,4}[ \t]{1,3})знак${M_END}|(?:токенн|токениз|символьн|байтов)\p{L}{0,5}`
  + re`|контекстн\p{L}{0,5}(?![\p{L}]|[ \t]{1,3}реклам)|(?:рассуждени|размышлени)(?:е|я|ю|ем|и|й|ям|ями|ях)|доступност(?:ь|и|ью)|ретра(?:й|я|ю|ем|е|и|ев|ям|ями|ях)`
  + re`|повторн(?:ых|ые|ым|ыми)[ \t]{1,3}попыт(?:ок|ки|кам|ками|ках)|минут\p{L}{0,2}[ \t]{1,3}ci|прогон\p{L}{0,2}[ \t]{1,3}тест\p{L}{0,3}`;
const STRONG_EN = re`ci[ \t-]{0,2}минут\p{L}{0,2}|tokens?|requests?|quer(?:y|ies)|chars?|characters?|bytes?|thinking|reasoning|retr(?:y|ies)|context|slos?|slas?`
  + re`|runs?|counters?`;
const SOFT_RU = re`страниц(?:а|ы|е|у|ей|ами|ам|ах)?|запис(?:ь|и|ью|ей|ям|ями|ях)`
  + re`|(?:событи|сообщени)(?:е|я|ю|ем|и|й|ям|ями|ях)|итераци(?:я|и|ю|ей|й|ям|ями|ях)|ошиб(?:ка|ки|ке|ку|кой|ок|кам|ками|ках)|узел|узл(?:а|у|ом|е|ы|ов|ам|ами|ах)`
  + re`|ответ${M_END}|(?:страничн|ошибочн|событийн|итерационн)\p{L}{0,5}`
  + re`|(?:вызов|эмбеддинг|чанк|граф|вес|файл|шаг|повтор)${M_END}|размер(?:а|у|ы|и|ов|ам|ами|ах)?|(?<!(?<![\p{L}])в[ \t]{1,3})размере`
  + re`|строк(?:а|и|е|у|ой|ам|ами|ах)?|длин(?:а|ы|е|у|ой|ам|ами|ах)?|памят(?:ь|и|ью)`
  + re`|слов(?:о|а|у|ом|е|ам|ами|ах)?|врем(?:я|ени|енем|ена|ен|енам|енами|енах)|эпох(?:а|и|е|у|ой|ам|ами|ах)?|батч(?:а|у|ем|е|и|ей|ам|ами|ах)?`
  + re`|вероятност(?:ь|и|ью|ей|ям|ями|ях)|ребр(?:о|а|у|ом|е|ам|ами|ах)|ребер|(?:строков|эмбеддингов|вероятностн|размерност|весов|графов|файлов)\p{L}{0,5}`
  + re`|(?:газ|прогон|шард|кластер|диск)${M_END}|реплик(?:а|и|е|у|ой|ам|ами|ах)?|пол(?:е|я|ю|ем|ей|ям|ями|ях)|попыт(?:ка|ки|ке|ку|кой|ок|кам|ками|ках)`
  + re`|(?:недоступност|латентност)(?:ь|и|ью)|задерж(?:ка|ки|ке|ку|кой|ек|кам|ками|ках)|сбо(?:й|я|ю|ем|е|и|ев|ям|ями|ях)|просто(?:я|ю|ем|ев)|даунтайм\p{L}{0,2}`;
const SOFT_EN = re`calls?|words?|lines?|rows?|lengths?|embeddings?|outputs?|inputs?|steps?|iterations?|explain|latency|downtime|uptime`
  + re`|gas|cpu|gpu|shards?|replicas?|clusters?|disks?|plans?|integer|numeric|bigint|smallint|int|decimal|float|double|default`;
const STRONG_END = re`(?![\p{L}]|${HYPHEN_BIZ})`, SOFT_END = re`(?![\p{L}]|-\p{L})`, WORD_START = re`(?<![a-zа-яё])(?<![\p{L}])`;
const TECH_STRONG = new RegExp(re`${WORD_START}(?:(?=[а-яё])(?:${STRONG_RU})|${STRONG_EN})${STRONG_END}`, "iu");
const TECH_SOFT = new RegExp(re`${WORD_START}(?:(?=[а-яё])(?:${SOFT_RU})|${SOFT_EN})${SOFT_END}`, "iu");
const TECH_ALL = new RegExp(re`${WORD_START}(?:(?=[а-яё])(?:(?:${STRONG_RU})${STRONG_END}|(?:${SOFT_RU})${SOFT_END})`
  + re`|(?:${STRONG_EN})${STRONG_END}|(?:${SOFT_EN})${SOFT_END})`, "iu");
const NOT_TECH = /(?<![\p{L}])(?:контекстн\p{L}{0,5}[ \t]{1,3}реклам|товарн\p{L}{0,4}[ \t]{1,3}знак|в[ \t]{1,3}размере(?![\p{L}])|размером(?![\p{L}]))/giu;
const techStrong = (s: string): boolean => TECH_STRONG.test(s);
const techSoft = (s: string): boolean => TECH_SOFT.test(s);
const techAny = (s: string, small: boolean): boolean => small ? TECH_ALL.test(s) : TECH_STRONG.test(s);
const PER_UNIT = /(?<![\p{L}])(?:на[ \t]{1,3}(?:(?:кажд(?:ый|ую|ое)|од(?:ин|ну|но))[ \t]{1,3})?(?:реплику|шард|под|прогон)|per[ \t]{1,3}(?:(?:each|one|a)[ \t]{1,3})?(?:replica|shard|pod|run))(?![\p{L}])/iu;
const PER_UNIT_SOFT = /(?<![\p{L}])(?:на[ \t]{1,3}(?:(?:кажд(?:ый|ую|ое)|од(?:ин|ну|но))[ \t]{1,3})?(?:задачу|узел)|per[ \t]{1,3}(?:(?:each|one|a)[ \t]{1,3})?(?:task|node))(?![\p{L}])/iu;
const TECH_MULT = /^[ \t]{1,3}(?:(?:на|for)[ \t]{1,3}(?:рассуждени|размышлени|thinking|reasoning)|ci[ \t-]{0,2}минут|минут\p{L}{0,2}[ \t]{1,3}ci(?![\p{L}])|запрос\p{L}{0,3}[ \t]{1,3}к[ \t]{1,3}(?:llm|api|модел|нейросет|gpt|бд|баз[еам]|субд|db|sql)|(?:[\p{L}\d]{1,15}-|[а-яё]{2,20}(?:ых|их|ого|его|ой|ей|ый|ий|ая|яя|ое|ее|ые|ие)[ \t]{1,3}|(?!(?:for|on|of|per|to|in|the)[ \t])[a-z]{2,15}[ \t]{1,3})?(?:токен|token|контекст|context|рассуждени|thinking|reasoning|(?:(?:символ|знак|байт)(?:ов|а|ы)?|bytes?|chars?|characters?|retr(?:y|ies)|ретра(?:ев|и|я|ям)?|runs?)(?![\p{L}])))/iu;
const TECH_FIRST = new RegExp(re`^[ \t]{1,3}(?:[\p{L}\d]{1,15}-)?(?:(?=[а-яё])(?:${STRONG_RU})|${STRONG_EN})${STRONG_END}`, "iu");
const K_MULT = /\d[ \t]?[kк]$/iu;
const MULT_TAIL = /[ \t]?(?:тыс(?:\.|яч\p{L}{0,2})?|млн\.?|млрд\.?|миллион\p{L}{0,3}|миллиард\p{L}{0,3})(?![\p{L}])/iuy;
function multTail(text: string, at: number): boolean {
  let c = text.charCodeAt(at);
  if (c === 32 || c === 9) c = text.charCodeAt(at + 1);
  if (c !== 1090 && c !== 1058 && c !== 1084 && c !== 1052) return false;
  MULT_TAIL.lastIndex = at;
  return MULT_TAIL.test(text);
}
const BUDGET_NA_VERBAL = /^[ \t]{1,3}на[ \t]{1,3}[а-яё]{2,20}(?:ние|тие|ку|цию|ту)(?![\p{L}])/iu;
const UNIT_WORD = /токен|token|контекст|context|рассужд|размышл|thinking|reasoning|символ|знак|байт|byte|char/iu;
const budgetWorks = (mw: string, mws: string, n: string): boolean => GROUPED.test(n) && BUDGET_WORD.test(mw) && BUDGET_NA_VERBAL.test(mws)
  && !UNIT_WORD.test(mws);
function roundPow2(digits: string, min: number): boolean {
  let d = digits, z = 0;
  while (d.length > 1 && d.charCodeAt(d.length - 1) === 48) { d = d.slice(0, -1); z++; }
  if (z < 3) return false;
  let x = Number(d);
  if (x < min) return false;
  while (x % 2 === 0) x /= 2;
  return x === 1;
}
const BUDGET_OF_TECH = re`модел\p{L}{0,3}|агент\p{L}{0,3}|инструмент\p{L}{0,3}|ответа|выполнени[яи]|обработки|генераци[ийя]|вывода|поиска|индексаци[ийя]`
  + re`|сервис\p{L}{0,2}|сервер\p{L}{0,2}|кластер\p{L}{0,2}|пода|воркер\p{L}{0,2}|процесс\p{L}{0,2}|функци[ийя]|пайплайн\p{L}{0,2}|к[эе]ша|кода`
  + re`|эндпоинт\p{L}{0,2}|ретривер\p{L}{0,2}|реранкер\p{L}{0,2}|эмбеддинг\p{L}{0,2}|запроса|вызова|шага|итерации|сессии|чанк\p{L}{0,2}|токен\p{L}{0,2}`
  + re`|контекст\p{L}{0,2}|llm|api|gpt|бд|db|sql|sla|slo`;
const BUDGET_OF = new RegExp(re`^[ \t]{1,3}(?:токенов|запросов|вызовов|шагов|чанков|памяти|времени|ошибок|ответа|контекста|рассуждений|повторов|попыток|итераций)`
  + re`(?:[ \t]{1,3}(?:${BUDGET_OF_TECH})){0,2}(?:[ \t]{1,3}(?:за|на|в)[ \t]{1,3}(?:(?:(?:кажд\p{L}{1,2}|од(?:ин|ну|но))[ \t]{1,3})?(?:месяц|квартал|год|неделю`
  + re`|сутки|день|час|минуту|секунду|запрос|вызов|шаг|сессию|ответ|задачу|агента|пользователя|ключ|узел|под|реплику|шард|инстанс|сервер|воркер|контейнер`
  + re`|процесс|запуск|прогон)(?:[ \t]{1,3}(?:кластера|агента|модели))?|${MONEY_PERIOD}(?:[ \t]{1,3}${PERIOD_VERB_W})?))?$`, "iu");
const BUDGET_WORD = /^(?:бюджет|budget)/iu;
function pow2(v: string): boolean {
  const z = v.charCodeAt(v.length - 1);
  if (z !== 50 && z !== 52 && z !== 54 && z !== 56) return false;
  const d = digitsOf(v);
  if (d.length < 3 || d.length > 13) return false;
  let x = Number(d);
  if (x < 256) return false;
  while (x % 2 === 0) x /= 2;
  return x === 1;
}
const COUNT_NOUN = re`(?:документ|вектор|объект|элемент|просмотр|показ|клик|визит|параметр|экземпляр|токен|запрос|вызов|символ|знак|байт`
  + re`|эмбеддинг|чанк|файл|шаг|прогон|ответ|граф|шард|кластер|диск|повтор|размер|вес)ов|байт|строк|слов|длин|эпох|попыток|реплик|полей|ребер`
  + re`|батчей|ретраев|вероятностей|страниц|событий|записей|ошибок|сообщений|итераций|узлов|пользователей|операций|транзакций|сессий`
  + re`|обращений|посещений|ячеек|точек|штук|единиц|шт\.?|ед\.|газа|gas`
  + re`|items|documents|docs|vectors|objects|records|elements|files|users|messages|events|pages|entries|views|clicks|sessions|transactions`
  + re`|operations|ops|params|parameters|units|pcs|tokens|requests|calls|chars|characters|bytes|words|lines|rows|embeddings|chunks|queries`
  + re`|iterations|steps|retries`
  + re`|(?:милли)?секунд|минут|часов|суток|дней|недель|мс|сек\.?|ms|(?:milli)?seconds|secs|minutes|mins|hours|hrs|days|weeks`;
const COUNT_NOUN_FEW = re`(?:(?:документ|вектор|объект|элемент|просмотр|показ|клик|визит|параметр|экземпляр|токен|запрос|вызов|символ|знак|байт`
  + re`|эмбеддинг|чанк|файл|шаг|прогон|ответ|граф|шард|кластер|диск|повтор|размер|вес|узл|час)а|(?:пользовател|ретра)я|дня`
  + re`|(?:строк|запис|ошибк|страниц|итераци|операци|транзакци|сесси|ячейк|точк|штук|единиц|реплик|попытк|эпох|(?:милли)?секунд|минут|недел)[иы]`
  + re`|(?:слов|пол|ребр|событи|сообщени|обращени|посещени)[ая])`;
const COUNT_MOD = re`(?:(?!(?:usd|eur|rub|rur|gbp|cny|kzt|byn|uah|jpy|chf)[ \t])[a-z]{2,15}[ \t]{1,3}|(?!условн)[а-яё]{2,20}(?:ых|их)[ \t]{1,3}|[\p{L}\d]{1,15}-)?`;
const COUNT_AFTER = new RegExp(re`^[ \t]{0,3}${COUNT_MOD}(?:${COUNT_NOUN})(?![\p{L}])`, "iu");
const COUNT_AFTER_FEW = new RegExp(re`^[ \t]{0,3}${COUNT_MOD}${COUNT_NOUN_FEW}(?![\p{L}])`, "iu");
const COUNT_AFTER_KOP = new RegExp(re`^[ \t]{0,3}${COUNT_MOD}(?:(?:токен|запрос|символ|знак)ов|байт(?:ов)?|tokens|requests|chars|characters|bytes)(?![\p{L}])`, "iu");
const FEW_END = /(?:^|[^1])[234]$/;
function countLen(after: string, kop: boolean, n: string): number {
  const c = kop ? COUNT_AFTER_KOP.exec(after) : COUNT_AFTER.exec(after) ?? (FEW_END.test(n) ? COUNT_AFTER_FEW.exec(after) : null);
  return c !== null && !(/^[ \t]{0,3}\p{Lu}/u.test(after) && /^[ \t]{0,2}:/.test(after.slice(c[0].length))) ? c[0].length : -1;
}
const countAfter = (after: string, kop: boolean, n: string): boolean => countLen(after, kop, n) >= 0;
const COUNT_FIRST = new RegExp(re`^[ \t]{1,3}${COUNT_MOD}(?:${COUNT_NOUN})(?![\p{L}])`, "iu");
const COUNT_FIRST_WORD = /^(?:итого|всего)$/iu;
const FIN_COUNT = /^[ \t]{1,3}(?:[а-яё]{2,20}(?:ых|их)[ \t]{1,3})?(?:операций|транзакций|платежей|единиц)(?![\p{L}])/iu;
const NDS_AFTER = /^[ \t]{0,3}\(?[ \t]{0,2}(?:с|без|вкл(?:ючая|\.)?)[ \t]{1,3}ндс(?![\p{L}])/iu;
const PO_END = /(?:^|[ \t])по$/iu;
const PO_COUNT = /^[ \t]{1,3}(?:[а-яё]{2,20}(?:ым|им)[ \t]{1,3})?(?!(?:рубл|доллар|евр|франк|фунт|юан|тенге|гривн|копе))[а-яё]{2,20}(?:ам|ям|ами|ями)(?![\p{L}])/iu;
const NEXT_VERB = re`(?:составля(?:ет|ют)|состав(?:ит|ят|ил[аои]?)|стои(?:т|ла?|ли|ло)|стоят|обойд(?:ётся|ется|утся)|обходится)(?![\p{L}])`;
const NEXT_HINT = /[:=—–-]|состав|стои|обо[йх]/iu;
const NEXT_NUM = new RegExp(re`(?:[ \t]{1,3}[a-zа-яё]{1,15}(?![\p{L}])){0,2}[*_\x60"'»]{0,3}[ \t]{0,3}(?:[:=—–-]|${NEXT_VERB})[ \t]{0,3}[*_\x60"'«]{0,3}`
  + re`[ \t]{0,3}${MONEY_QUAL}(${NUM_MONEY})`, "iuy");
const ALGO_UNIT = /^(?:строк|шагов|итераций|элементов|сравнений|узлов|вершин|р[её]бер|rows|steps|iterations|elements|nodes|comparisons)$/iu;
const ALGO_OP = /(?<![\p{L}])(?:чтени|сканировани|сортировк|обход|вычислени)\p{L}{0,2}(?![\p{L}])/iu;
function algoCount(unit: string, mws: string): boolean {
  let i = unit.length;
  while (i > 0) {
    const c = unit.charCodeAt(i - 1);
    if (c === 32 || c === 9 || c === 45) break;
    i--;
  }
  return ALGO_UNIT.test(unit.slice(i)) || (mws.length > 6 && ALGO_OP.test(mws));
}
const SUM_WORD = /^сумм/iu;
const UNIT_BRACKET = /^[ \t]?[([][ \t]?(?:[\p{L}\d]{1,10}-)?(?:мс|мкс|нс|ms|us|µs|ns|с|сек\.?|секунд\p{L}{0,2}|s|sec|secs|seconds?|мин\.?|минут\p{L}{0,2}|min|ч|час\p{L}{0,2}|h|байт\p{L}{0,2}|bytes?|[кмгт]б|[kmgt]i?b|такт\p{L}{0,2}|циклов|cycles?|flops?)[ \t]?[)\]]/iu;
const nextMoneyAfter = (after: string): boolean => (!/^[ \t]?\p{L}/u.test(after) && !UNIT_BRACKET.test(after)) || MONEY_AFTER.test(after) || NDS_AFTER.test(after);
const TECH_WEAK = /(?<![\p{L}])(?:вывод|выход|генераци)\p{L}{0,2}\.?$/iu;
const TECH_MODEL = /(?<![\p{L}])(?:вывод|выход|ответ|генераци|контекст)\p{L}{0,2}[ \t]{1,3}(?:модел|llm|нейросет|агент)\p{L}{0,2}(?![\p{L}])/iu;
const UNIT_PHRASE = /(?<![\p{L}])в[ \t]{1,3}(?:единиц|пиксел|байт|секунд|минут|миллисекунд|газ)\p{L}{0,3}(?![\p{L}])/iu;
const YEAR = /^(?:19|20)\d{2}$/;
const YEAR_PREP = /^(?:на|в|во|за|к|ко|с|со|по|из|после|in|on|for|since|until|by|of|after)$/iu;
const MONTH = /^(?:квартал\p{L}{0,2}|полугоди\p{L}{0,2}|январ\p{L}{0,2}|феврал\p{L}{0,2}|март\p{L}{0,2}|апрел\p{L}{0,2}|ма[йяе]|июн\p{L}{0,2}|июл\p{L}{0,2}|август\p{L}{0,2}|сентябр\p{L}{0,2}|октябр\p{L}{0,2}|ноябр\p{L}{0,2}|декабр\p{L}{0,2}|january|february|march|april|may|june|july|august|september|october|november|december)$/iu;
const YEAR_NEXT = new RegExp(re`(?:[-/](?:19|20)\d{2}(?!\d)|[./-]\d{1,2}(?!\d))?(?=(?<yw>(?:[ \t]{1,3}\p{L}{1,15}\.?){0,2}))\k<yw>`
  + re`(?<ys>[*_\x60"'»]{0,3}[ \t]{0,3}(?:[:=|-][ \t]{0,3})?[*_\x60"'«]{0,3}[ \t]{0,3}${MONEY_QUAL})(?<yn>${NUM_MONEY})`, "iuy");
const YEAR_WORD = /^(?:год\p{L}{0,2}|г)$/iu;
const PERIOD_VERB_END = new RegExp(re`[ \t]${PERIOD_VERB_W}$`, "iu");
const PERIOD_WS = new RegExp(re`(?:(?<![\p{L}])(?:за|на|в|во|по)[ \t]{1,3})?(?:${MONEY_PERIOD})`, "giu");
const PERIOD_PREP = /^(?:на|за)$/iu, PERIOD_NOUN = /^(?:год|месяц|квартал|полгода)$/iu, PLURAL_GEN = /(?:ов|ев|ок|ек|ей|ий)$/iu;
const EXPLAIN_AFTER = /^[ \t]{0,2}[,;]?[ \t]{0,2}(?:rows|width|loops)(?![\p{L}])/iu;
const TECH_BEFORE = /^(?:memory|time|token|tokens|error|latency|compute|gas|cpu|gpu|query|path|edge|node|thinking|reasoning|output|input|retry|retries|context|контрольн\p{L}{0,3}|вычислительн\p{L}{0,3})$/iu;
const TECH_BEFORE_BUDGET = /^(?:sla|slo)$/iu;
const SQL_DEFAULT = /(?<![\p{L}])(?:integer|int|bigint|smallint|numeric|decimal|float|double|real|money)(?:[ \t]{1,3}not[ \t]{1,3}null)?[ \t]{1,3}default$/iu;
const TECH_BEFORE_WEAK = /^(?:max|min)$/iu;
const CONTEXT_WINDOW = /context[ \t_-]{1,2}window[ \t_-]{1,2}$/iu;
function techWordBefore(text: string, at: number): string {
  let i = at;
  for (let k = 0; k < 2 && i > 0; k++) {
    const c = text.charCodeAt(i - 1);
    if (c !== 32 && c !== 9 && c !== 95 && c !== 45) break;
    i--;
  }
  if (i === at) return "";
  let j = i;
  while (j > 0 && i - j <= 16 && /\p{L}/u.test(text[j - 1])) j--;
  return i - j > 16 ? "" : text.slice(j, i);
}
const MONEY_AFTER = /^[ \t]?(?:тыс|млн|млрд|миллион|миллиард|руб|р\.|₽|\$|usd|eur|евро|долл|на[ \t]руки|в[ \t](?:месяц|год|час|день)|за[ \t]|\/|net|gross|до[ \t]вычета|условн\p{L}{0,3}[ \t]{1,3}единиц)/iu;
const UE_AFTER = /^[ \t]?условн\p{L}{0,3}[ \t]{1,3}единиц/iu;
const PG_COST = /(?<![\p{L}])(?:план(?:а|у|ом|е)?|узл\p{L}{0,2}|узел|сканировани\p{L}{0,2}|запрос\p{L}{0,3}(?![ \t]{1,3}(?:котировок|предложени|цен(?![\p{L}])))|соединени\p{L}{0,2}|сортировк\p{L}{0,2}|explain|seq_page_cost|cost)(?![\p{L}])/iu;
const PG_NODE = /(?<![\p{L}])(?:scan|loop|join|оптимизатор\p{L}{0,2}|планировщик\p{L}{0,2})(?![\p{L}])/iu;
const PG_EST = /(?<![\p{L}])(?:оценк[аиу]|оценил[аи]?)[ \t]{1,3}$/iu;
function pgCostBefore(text: string, at: number, mws: string): boolean {
  const b = text.slice(Math.max(0, at - 40), at);
  let s = b.lastIndexOf("\n");
  for (let i = b.length - 2; i > s; i--) if ((b[i] === "." || b[i] === "!" || b[i] === "?") && (b[i + 1] === " " || b[i + 1] === "\t")) { s = i; break; }
  const bw = b.slice(s + 1);
  return PG_NODE.test(bw) || PG_NODE.test(mws) || (PG_EST.test(bw) && /^(?:[ \t]{1,3}в)?$/iu.test(mws));
}
const WEAK_MONEY = /^(?:итого|всего|ндс|сч[её]т)/iu;
const MULT_MONEY = /^(?:сделк|кп|тендер|марж|прибыл|доход|оборот)/iu;
const MONEY_CELL = new RegExp(re`^(?:[$€£¥₽][ \t]?)?${NUM}(?:[ \t]?(?:₽|руб\.?|р\.?|\$|€|usd|eur))?$`, "iu");
const moneyCell = (v: string): boolean => MONEY_CELL.test(v) && (digitsOf(v).length >= 4 || /,\d{2}$/.test(v));
const AMBIG_HEAD = /^(?:бюджет\p{L}{0,2}|budget|cost)$/iu;
const AMBIG_COL = /^(?:бюджет\p{L}{0,2}|budget|cost|итого|amount)$/iu;
const UNAMBIG_COL = /^(?:цен\p{L}{0,2}|стоимост\p{L}{0,2}|сумм\p{L}{0,2}|оплат\p{L}{0,2}|предоплат\p{L}{0,2}|выручк\p{L}{0,2}|зарплат\p{L}{0,2}|зп|оклад\p{L}{0,2}|гонорар\p{L}{0,2}|аванс\p{L}{0,2}|нмцк?|ставк\p{L}{0,2}|price|salary)$/iu;
const WEAK_HEAD = /^(?:всего|ндс|сч[её]т\p{L}{0,2})$/iu;
const PRICE_HEAD = /^(?:цен|стоимост|оплат|price)/iu, RU_PRICE_HEAD = /^(?:цен|стоимост|оплат)/iu;
const HEAD_TECH = /(?<![\p{L}])(?:(?:токен|запрос|вызов|символ|байт|контекст|эмбеддинг|чанк|батч)\p{L}{0,3}|граф(?:а|у|ом|е|ы|ов)?|метрик\p{L}{0,3}|эпох\p{L}{0,3}|ребр\p{L}{0,3}|ребер|вероятност\p{L}{0,3}|рассуждени\p{L}{0,3}|задержк\p{L}{0,3}|ретра\p{L}{0,3}|tokens?|requests?|calls?|bytes?|rows?|context|thinking|reasoning|outputs?|inputs?|retr(?:y|ies)|edges?|quer(?:y|ies)|nodes?|vertex|vertices|metrics?|operations?|latency|модел\p{L}{0,2}|models?|режим\p{L}{0,2}|modes?|алгоритм\p{L}{0,2}|algorithms?|paths?|joins?|layers?|сло(?:й|я|ю|ем|е|и|ев)|index(?:es)?|индекс\p{L}{0,2}|opcodes?|агент\p{L}{0,2}|agents?|узел|узл\p{L}{0,2}|вершин\p{L}{0,2}|instructions?|ops?|operators?|plans?|gates?|heuristics?|functions?|methods?|gas|steps?|опкод\p{L}{0,2}|инструкци\p{L}{0,2}|пол(?:е|я|ей)|столб(?:ец|ц\p{L}{1,2})|fields?|columns?)(?![\p{L}])/iu;
const HEAD_TECH_PRICE = /(?<![\p{L}])(?:(?:токен|запрос|вызов|символ|байт|контекст|эмбеддинг|чанк|батч)\p{L}{0,3}|граф(?:а|у|ом|е|ы|ов)?|метрик\p{L}{0,3}|эпох\p{L}{0,3}|ребр\p{L}{0,3}|ребер|вероятност\p{L}{0,3}|рассуждени\p{L}{0,3}|задержк\p{L}{0,3}|ретра\p{L}{0,3}|сч[её]тчик\p{L}{0,2}|алгоритм\p{L}{0,2}|узел|узл\p{L}{0,2}|вершин\p{L}{0,2}|tokens?|requests?|bytes?|rows?|context|thinking|reasoning|retr(?:y|ies)|edges?|quer(?:y|ies)|vertex|vertices|metrics?|operations?|latency|algorithms?|opcodes?|instructions?|ops?|gates?|heuristics?|counters?|опкод\p{L}{0,2}|инструкци\p{L}{0,2}|пол(?:е|я|ей)|столб(?:ец|ц\p{L}{1,2})|fields?|columns?)(?![\p{L}])/iu;
const HEAD_MONEY = /(?<![\p{L}])(?:стать(?:я|и|ю|ей)|услуг\p{L}{0,2}|товар\p{L}{0,2}|позици\p{L}{0,2}|смет\p{L}{0,2}|расход\p{L}{0,3}|наименовани\p{L}{0,2}|items?|products?|services?|expenses?|goods)(?![\p{L}])/iu;
const HEAD_TECH_EN = /(?<![\p{L}])(?:calls?|gas|nodes?|functions?|methods?|operators?)(?![\p{L}])/iu;
const STEP_PLAN_EN = /(?<![\p{L}])(?:steps?|plans?)(?![\p{L}])/iu;
const LOOSE_TECH = /(?<![\p{L}])(?:метод\p{L}{0,2}|параметр\p{L}{0,2}|params?|parameters?|ключ\p{L}{0,2}|keys?|переменн\p{L}{0,3}|variables?|флаг\p{L}{0,2}|flags?|конфиг\p{L}{0,4}|config\p{L}{0,7}|endpoints?|эндпоинт\p{L}{0,2})(?![\p{L}])/iu;
const HEAD_GENERIC = /(?<![\p{L}])(?:показател\p{L}{0,3}|сч[её]тчик\p{L}{0,2}|лимит\p{L}{0,2}|тип|параметр\p{L}{0,2}|types?|parameters?|limits?|counters?)(?![\p{L}])/iu;
const GRAPH_LABEL = /^#?[A-Za-z0-9]{1,3}(?:[ \t]*(?:->|→|<-|-|\/|,)[ \t]*[A-Za-z0-9]{1,3})*$/;
const CODE_LABEL = /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*(?:[ \t][a-z][a-z0-9_]*){0,2}$/;
const CELL_CUR = /[$€£¥₽]|руб|usd|eur/iu;
const GROUPED = /\d[ \t.,]\d{3}/;
function rowLabelTech(label: string, short: boolean, small: boolean): boolean {
  const tech = (x: string): boolean => techAny(x, small);
  const w = label.replace(NOT_TECH, " ").match(/\p{L}+/gu) ?? [], [a = "", b = ""] = w;
  if (a === "") return false;
  if ((tech(a) || (b !== "" && PASSPORT_ADJ.test(a) && tech(b))) && (!short || w.length <= 2)) return true;
  return w.filter(tech).length >= 2 || TECH_MODEL.test(label) || (w.length === 1 && TECH_WEAK.test(a));
}
const techTableMoney = (v: string, label: string, price: boolean): boolean => label !== "" && /^[А-Яа-яЁё]/u.test(label)
  && !/\p{Ll}\p{Lu}/u.test(label) && !techAny(label, digitsOf(v).length <= 5 && !GROUPED.test(v)) && !TECH_MODEL.test(label)
  && (price ? !/[.,]\d{1,2}$/.test(v) || GROUPED.test(v) : digitsOf(v).length >= 6 && /\d[ \t.]\d{3}/.test(v) && !HEAD_TECH.test(label));
const TOTAL_COL = /^(?:итого|amount)$/iu, ROW_NO_HEAD = /^(?:№|#|n|no\.?|nn|№[ \t]?п\/п|п\/п|номер)$/iu;
const EXPLAIN_COL = /^(?:строк|rows|кол-?во[ \t]строк|число[ \t]строк|(?:est\.?|estimated|actual|plan)[ \t]rows)$/iu;
const PLAN_NODE = /^(?:->[ \t]*)?(?:(?:parallel|partial|finalize)[ \t]+)?(?:seq[ \t]+scan|index(?:[ \t]+only)?[ \t]+scan(?:[ \t]+backward)?|bitmap[ \t]+(?:heap|index)[ \t]+scan|bitmap(?:and|or)|(?:hash|merge)(?:[ \t]+(?:left|right|full|anti|semi))?[ \t]+join|nested[ \t]+loop(?:[ \t]+(?:left|right|anti|semi)[ \t]+join)?|(?:hash|group|mixed)?aggregate|(?:incremental[ \t]+)?sort|gather(?:[ \t]+merge)?|materialize|memoize|windowagg|lockrows|modifytable|projectset|(?:hash)?setop|merge[ \t]+append|recursive[ \t]+union|(?:cte|subquery|function|values|sample|tid(?:[ \t]+range)?|foreign|custom|table[ \t]+function|named[ \t]+tuplestore|worktable)[ \t]+scan|(?:insert|update|delete|merge)[ \t]+on[ \t]+\S.*)(?:[ \t]+(?:on|using)[ \t].*|[ \t]*\(.*)?$/iu;
const PLAN_NODE_WEAK = /^(?:->[ \t]*)?(?:limit|hash|(?:parallel[ \t]+)?append|unique|result|group)(?:[ \t]*\(.*)?$/iu;
const BUDGET_COL = /^(?:бюджет\p{L}{0,2}|budget)$/iu;
const STEP_HEAD = /^(?:шаг|шаги|steps?|параметр|параметры|parameters?|params?)$/iu, STAGE_HEAD = /^(?:этап|этапы|stages?)$/iu;
const TOKEN_HEAD = /(?<![\p{L}])(?:токен\p{L}{0,3}|tokens?)(?![\p{L}])/iu;
const AI_MODEL = /^(?:chat[ \t-]?)?(?:gpt|claude|llama|qwen|gigachat|гигачат|yandex[ \t-]?gpt|mistral|mixtral|gemini|deepseek)(?![a-zа-яё])/iu;
const STAGE_ABBR = /^(?:llm|api|rag|ocr|tts|asr|stt|etl|s3|cdn|ram)$/iu;
const DOC_HEAD = /^(?:документ[ыа]?|documents?)$/iu;
const QTY_HEAD = /^(?:кол-?во(?:[ \t].*)?|количеств\p{L}{0,2}|qty|quantity|шт\.?|seats?|лицензи\p{L}{0,2})$/iu;
const PRICE_BIZ = /^(?:тариф[ыа]?|tariffs?|plans?|услуг[аи]|работ[аы]|товар[ыа]?|items?|products?|продукт[ыа]?|пакет[ыа]?)$/iu;
const HEAD_SLO = /(?<![\p{L}])(?:sl[oa]s?|uptime|availability|доступност\p{L}{0,2})(?![\p{L}])/iu;
const PERIOD_HEAD = /^(?:quarters?|months?|квартал[ыа]?|месяц[ыа]?)$/iu;
function countsDiffer(v: string, row: string[], counts: number[]): boolean {
  const x = Number(digitsOf(v));
  let s = 0;
  for (const i of counts) {
    const y = Number(digitsOf(row[i] ?? ""));
    if (y === x) return false;
    s += y;
  }
  return s !== x;
}
const BIZ_HEAD = /^(?:тариф[ыа]?|plans?|услуг[аи]|работ[аы]|отдел[ыа]?|стать[яи]|канал[ыа]?|товар[ыа]?|items?|products?|departments?|projects?|teams?|clients?|customers?|regions?|quarters?|months?|проект[ыа]?|клиент[ыа]?|заказчик[иа]?|регион[ыа]?|квартал[ыа]?|месяц[ыа]?|продукт[ыа]?|подразделени[ея]|направлени[ея])$/iu;
const SNAKE_LABEL = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;
function moneyColumn(word: string, names: string[], col: number): (v: string, row: string[]) => boolean {
  const curHead = HEAD_CUR_TAIL.test(names[col].slice(word.length));
  const lc = col > 1 && ROW_NO_HEAD.test(names[0]) ? 1 : 0;
  const other = names.filter((_, i) => i !== col), money = other.some((c) => HEAD_MONEY.test(c)), total = TOTAL_COL.test(word);
  const ambig = AMBIG_COL.test(word), weakHead = WEAK_HEAD.test(word), budget = /^budget$/i.test(word), price = PRICE_HEAD.test(word);
  const ruPrice = RU_PRICE_HEAD.test(word), generic = other.some((c) => HEAD_GENERIC.test(c));
  const enPrice = /^price$/i.test(word);
  const tech = total ? other.some((c) => HEAD_TECH_PRICE.test(c)) : ambig || weakHead ? other.some((c) => HEAD_TECH.test(c))
    : enPrice ? other.some((c) => HEAD_TECH_PRICE.test(c) || HEAD_TECH_EN.test(c)) : col > lc && HEAD_TECH_PRICE.test(names[lc]);
  const explain = other.some((c) => EXPLAIN_COL.test(c)), budgetTab = names.some((c) => BUDGET_COL.test(c));
  const biz = col > lc && BIZ_HEAD.test(names[lc]), ruTotal = /^итого$/iu.test(word), budgetCol = BUDGET_COL.test(word);
  const bizFirst = biz || (col > lc && HEAD_MONEY.test(names[lc]));
  const stepTab = budgetTab && other.some((c) => STEP_HEAD.test(c) || (!bizFirst && TOKEN_HEAD.test(c))), stageTab = budgetTab && other.some((c) => STAGE_HEAD.test(c));
  const stepPlan = enPrice && !tech && other.some((c) => STEP_PLAN_EN.test(c));
  const stepHead = stepTab && other.some((c) => STEP_HEAD.test(c)), explainBiz = bizFirst || (col > lc && DOC_HEAD.test(names[lc]));
  const aiTab = budgetTab || names.some((c) => TOKEN_HEAD.test(c));
  const explainHead = col > lc && HEAD_TECH_PRICE.test(names[lc]), aiOff = biz || money || other.some((c) => QTY_HEAD.test(c));
  const slo = budgetCol && other.some((c) => HEAD_SLO.test(c)), bizCol = biz && !slo && (total || budgetCol);
  const counts: number[] = [];
  if (bizCol && total && tech) names.forEach((c, i) => { if (i !== col && HEAD_TECH_PRICE.test(c)) counts.push(i); });
  const pricing = counts.length > 0 && PRICE_BIZ.test(names[lc]);
  return (v: string, row: string[]): boolean => {
    if (!moneyCell(v)) return false;
    if (curHead || CELL_CUR.test(v)) return true;
    const label = col > lc ? row[lc] : "", frac = /[.,]\d{2}$/.test(v), grouped = GROUPED.test(v);
    const l0 = label.charCodeAt(0), latin = (l0 >= 65 && l0 <= 90) || (l0 >= 97 && l0 <= 122) || l0 === 45 || l0 === 1043 || l0 === 1075;
    if (latin && PLAN_NODE.test(label)) return false;
    const kop = frac && (grouped || v.includes(","));
    if (explain && !explainBiz && !(kop && !explainHead)) {
      return !ambig && !explainHead && (grouped || v.includes(",")) && /^[А-Яа-яЁё]/u.test(label) && !rowLabelTech(label, false, true);
    }
    if (stepTab && (kop || !stepHead || ambig || weakHead)) {
      if (kop || !stepHead || !grouped) return kop;
      const dg = digitsOf(v);
      return dg.length >= 6 && !pow2(v) && !roundPow2(dg, 16) && techTableMoney(v, label, false) && !rowLabelTech(label, false, true);
    }
    if (stageTab) {
      if (kop) return true;
      if (tech) return techTableMoney(v, label, false);
      const dg = digitsOf(v);
      return grouped && label !== "" && !pow2(v) && !roundPow2(dg, budget ? 1 : 16) && (!budget || (dg.length >= 6 && Number(dg) % 1440 !== 0))
        && !CODE_LABEL.test(label) && !SNAKE_LABEL.test(label) && !(latin && AI_MODEL.test(label)) && !rowLabelTech(label, false, true)
        && !(dg.length <= 5 && latin && STAGE_ABBR.test(label));
    }
    if (ambig && !frac && latin && !aiOff && (aiTab || !grouped) && AI_MODEL.test(label)) return false;
    const p0 = l0 | 32;
    if ((ambig || tech) && latin && (p0 === 108 || p0 === 104 || p0 === 112 || p0 === 97 || p0 === 117 || p0 === 114 || p0 === 103 || l0 === 45)
      && PLAN_NODE_WEAK.test(label)) return false;
    if (budgetCol || bizCol) {
      const dg = digitsOf(v), big = grouped && dg.length >= 6;
      if (slo && !frac && !big) return false;
      if (budgetCol && !frac && pow2(v)) return false;
      if (bizCol && label !== ""
        && (budget ? frac || (big && !roundPow2(dg, 1) && Number(dg) % 1440 !== 0)
          : total ? (grouped || frac || ruTotal) && (counts.length === 0 || (pricing && countsDiffer(v, row, counts)))
          : (grouped || frac) && (frac || (big && !roundPow2(dg, 1)) || !GRAPH_LABEL.test(label)))
        && !CODE_LABEL.test(label) && !SNAKE_LABEL.test(label)) return true;
    }
    if (stepPlan) return grouped || frac || techTableMoney(v, label, true);
    if (budget) return frac && (grouped || !tech);
    if (tech) return (frac && (grouped || ruPrice)) || techTableMoney(v, label, price);
    if (frac) return true;
    if (weakHead) return money;
    if (!ambig || money) return true;
    const small = digitsOf(v).length <= 5 && !grouped;
    if (label !== "" && (CODE_LABEL.test(label) || ((!total || small) && GRAPH_LABEL.test(label)))) return false;
    return label === "" || !rowLabelTech(label, !generic, small);
  };
}
const LOOSE_HEAD = /[ \t]*\|[^|\n]*\|[^|\n]*\S/y;
const LOOSE_ROW = /^[ \t]*(?:\|(?=([^|]*))\1){0,20}?\|[ \t]*[*_\x60"']*(?:[$€£¥₽][ \t]?)?\d(?:[ \t.,]?\d){3,}[ \t]*(?:(?:₽|руб\.?|р\.?|\$|€|usd|eur)[ \t]*)?[*_\x60"']*[ \t]*(?:\||$)/iu;
const LOOSE_AMOUNT = /\d[ \t.,]\d{3}|,\d{2}$/, LOOSE_AMOUNT_ANY = /\d[ \t.,]\d{3}|,\d{2}(?!\d)/;
const LOOSE_BIG = /\d[ \t.,]\d{3}[ \t.,]\d{3}|,\d{2}$/, LOOSE_BIG_ANY = /\d[ \t.,]\d{3}[ \t.,]\d{3}|,\d{2}(?!\d)/;
const LATE_ROW = /\d,\d{2}(?!\d)|\d[ \t]\d{3}\.\d{2}(?!\d)|[$€£¥₽]|руб|usd|eur/iu;
const markCh = (c: number): boolean => c === 42 || c === 95 || c === 96 || c === 34 || c === 39;
const wsCh = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || (c >= 0xa0 && (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
  || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff));
function mdCells(line: string): string[] {
  let a = 0, b = line.length;
  while (a < b && wsCh(line.charCodeAt(a))) a++;
  while (b > a && wsCh(line.charCodeAt(b - 1))) b--;
  if (a < b && line.charCodeAt(a) === 124) a++;
  if (b > a && line.charCodeAt(b - 1) === 124) b--;
  const out: string[] = [];
  for (let from = a; ;) {
    let e = line.indexOf("|", from);
    if (e < 0 || e > b) e = b;
    let x = from, y = e;
    while (x < y && wsCh(line.charCodeAt(x))) x++;
    while (y > x && wsCh(line.charCodeAt(y - 1))) y--;
    while (x < y && markCh(line.charCodeAt(x))) x++;
    while (y > x && markCh(line.charCodeAt(y - 1))) y--;
    out.push(line.slice(x, y));
    if (e >= b) return out;
    from = e + 1;
  }
}
function looseLine(text: string, from: number): [string, number] | null {
  const chunk = text.slice(from, from + 301), nl = chunk.indexOf("\n");
  if (nl < 0) return chunk.length > 300 ? null : [chunk, text.length];
  return [chunk.charCodeAt(nl - 1) === 13 ? chunk.slice(0, nl - 1) : chunk.slice(0, nl), from + nl + 1];
}
function csvCells(line: string, delim: string): string[] {
  const out: string[] = [], b = line.length;
  for (let from = 0; ;) {
    let e = line.indexOf(delim, from);
    if (e < 0) e = b;
    let x = from, y = e;
    while (x < y && wsCh(line.charCodeAt(x))) x++;
    while (y > x && wsCh(line.charCodeAt(y - 1))) y--;
    while (x < y && markCh(line.charCodeAt(x))) x++;
    while (y > x && markCh(line.charCodeAt(y - 1))) y--;
    out.push(line.slice(x, y));
    if (e >= b) return out;
    from = e + 1;
  }
}
type MoneyCol = [col: number, ok: (cell: string, row: string[]) => boolean, loose: 0 | 1 | 2 | 3];
const MONEY_HEAD_CELL = new RegExp(re`^(${MONEY_WORD})(?:[ \t]{0,3}[,(][ \t]{0,3}${HEAD_CUR}\)?)?$`, "iu");
function looseBiz(names: string[]): boolean {
  const h = names[names.length > 2 && ROW_NO_HEAD.test(names[0]) ? 1 : 0];
  return (BIZ_HEAD.test(h) && !PERIOD_HEAD.test(h)) || HEAD_MONEY.test(h);
}
function moneyCols(names: string[]): MoneyCol[] {
  const out: MoneyCol[] = [];
  for (let i = 0; i < names.length; i++) {
    const h = MONEY_HEAD_CELL.exec(names[i]);
    if (h === null || MULT_MONEY.test(h[1])) continue;
    const lz = UNAMBIG_COL.test(h[1]) || h[0].length > h[1].length ? 2 : AMBIG_COL.test(h[1]) && looseBiz(names) ? /^budget$/i.test(h[1]) ? 3 : 1 : 0;
    out.push([i, moneyColumn(h[1], names, i), lz]);
  }
  return out;
}
type LooseMemo = Memo & { headLine?: string; headCells?: string[]; headCols?: MoneyCol[]; headLower?: string[]; headTech?: boolean; rowLine?: string; rowCells?: string[] };
function headCells(memo: LooseMemo, line: string): string[] {
  if (memo.headLine !== line || memo.headCells === undefined) {
    memo.headLine = line;
    memo.headCells = memo.rowLine === line && memo.rowCells !== undefined ? memo.rowCells : mdCells(line);
    memo.headCols = undefined;
    memo.headLower = undefined;
    memo.headTech = undefined;
  }
  return memo.headCells;
}
function rowCells(memo: LooseMemo, line: string): string[] {
  if (memo.rowLine !== line || memo.rowCells === undefined) { memo.rowLine = line; memo.rowCells = mdCells(line); }
  return memo.rowCells;
}
const MD_LINE = /^[ \t]*\|/;
const SHORT_RULE = /^[ \t]*\|?(?:[ \t]*:?-{1,2}:?[ \t]*\|)+(?:[ \t]*:?-{1,2}:?[ \t]*)?$/;
function amountColumn(text: string, at: number, memo: LooseMemo): boolean {
  const back = text.slice(Math.max(0, at - 300), at), nl = back.lastIndexOf("\n");
  if (nl < 0 && at > 300) return false;
  const ls = at - back.length + nl + 1;
  if (memo.table === ls) return false;
  memo.table = ls;
  const head = looseLine(text, ls);
  if (!head || head[1] >= text.length) return false;
  const md = MD_LINE.test(head[0]);
  let p = head[1], loose = false, names: string[], cols: MoneyCol[], delim = "";
  if (md) {
    const next = looseLine(text, p);
    if (next === null) return false;
    if (TABLE_RULE.test(next[0]) || SHORT_RULE.test(next[0])) p = next[1];
    else {
      LOOSE_HEAD.lastIndex = ls;
      if (!LOOSE_HEAD.test(text) || !LOOSE_ROW.test(next[0])) return false;
      loose = true;
    }
    names = headCells(memo, head[0]);
    cols = memo.headCols ??= moneyCols(names);
  } else {
    delim = [",", ";", "\t"].find((d) => head[0].includes(d)) ?? "";
    if (delim === "") return false;
    if (memo.headLine !== head[0] || memo.headCells === undefined) {
      memo.headLine = head[0]; memo.headCells = csvCells(head[0], delim); memo.headCols = undefined; memo.headLower = undefined; memo.headTech = undefined;
    }
    names = memo.headCells;
    cols = memo.headCols ??= moneyCols(names);
  }
  if (names.length < 2) return false;
  if (loose && ((cols = cols.filter((c) => c[2] > 0)).length === 0 || (memo.headTech ??= names.some((c) => LOOSE_TECH.test(c))))) return false;
  if (cols.length === 0) return false;
  if (loose && cols.every((c) => c[2] === 1 || c[2] === 3)) {
    let e = p;
    for (let k = 0; k < 3 && e >= 0; k++) e = text.indexOf("\n", e + 1);
    if (!(cols.every((c) => c[2] === 3) ? LOOSE_BIG_ANY : LOOSE_AMOUNT_ANY).test(text.slice(p, e < 0 ? p + 903 : e))) return false;
  }
  const lower = memo.headLower ??= names.map((x) => x.toLowerCase());
  for (let row = 0; row < (md ? 20 : 4) && p < text.length; row++) {
    const line = looseLine(text, p);
    if (!line) return false;
    p = line[1];
    let c: string[];
    if (md && row >= 3 && !LATE_ROW.test(line[0])) {
      if (!MD_LINE.test(line[0]) || line[0] === head[0]) return false;
      continue;
    }
    if (md) {
      if (line[0] === head[0]) {
        if (names.filter((x) => x !== "").length > 1) return false;
        continue;
      }
      if (TABLE_RULE.test(line[0])) continue;
      c = rowCells(memo, line[0]);
    } else c = csvCells(line[0], delim);
    if (c.length !== names.length) return false;
    for (let i = 0; i < c.length; i++) {
      const x = c[i];
      if (x !== "" && x.length === lower[i].length && x.toLowerCase() === lower[i]) return false;
    }
    for (const [col, ok, lz] of cols) {
      if ((!loose || lz === 2 || ((lz === 3 ? LOOSE_BIG : LOOSE_AMOUNT).test(c[col]) && !looseCodeLabel(c, names, col))) && ok(c[col], c)) return true;
    }
  }
  return false;
}
function looseCodeLabel(c: string[], names: string[], col: number): boolean {
  const lc = col > 1 && ROW_NO_HEAD.test(names[0]) ? 1 : 0, label = col > lc ? c[lc] : "";
  if (label === "" || /,\d{2}$/.test(c[col])) return false;
  const ai = AI_MODEL.test(label) && !names.some((x) => QTY_HEAD.test(x))
    && (names.some((x) => BUDGET_COL.test(x) || TOKEN_HEAD.test(x)) || !/\d[ \t  ]\d{3}/.test(c[col]));
  return CODE_LABEL.test(label) || SNAKE_LABEL.test(label) || ai;
}

function techBetween(text: string, a: number, b: number): boolean {
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 0x400) return techSoft(text.slice(a, b));
  }
  return false;
}
function nextAmount(text: string, from: number, mws: string, budgetWord: boolean, ambig: boolean, multOnly: boolean, strict = false): boolean {
  NEXT_NUM.lastIndex = from;
  const x = NEXT_NUM.exec(text);
  if (x === null) return false;
  const n = x[1], stop = NEXT_NUM.lastIndex, after = text.slice(stop, stop + 40), c0 = n.charCodeAt(0), cz = n.charCodeAt(n.length - 1);
  const sign = c0 < 48 || c0 > 57, dz = cz >= 48 && cz <= 57, mult = !sign && (!dz || multTail(text, stop)), kop = dz && n.charCodeAt(n.length - 3) === 44;
  const grouped = GROUPED.test(n), d = digitsOf(n).length, big = d >= 6 && grouped;
  if (multOnly) return mult;
  if (!sign && !nextMoneyAfter(after)) return false;
  if (strict && !(kop || sign || mult)) return false;
  if (!(sign || mult) && YEAR.test(n)) return false;
  if (/^(?:[.,]\d+)?\.\.\d|^[ \t-]?\d/.test(after) || EXPLAIN_AFTER.test(after)) return false;
  if (!(kop || sign || mult) && ((budgetWord && pow2(n)) || (d <= 5 && !grouped && ambig) || (!big && (techSoft(mws) || techBetween(text, from, stop - n.length))))) return false;
  return true;
}
function amountOk(m: RegExpExecArray, text: string, memo: Memo): boolean {
  const g = m.groups ?? {}, s = m[0], end = m.index + s.length;
  if (g.mw === undefined) {
    if (g.iso !== undefined) return !ISO_NUMERIC.has(g.iso) && !AMOUNT_UNIT.test(text.slice(end, end + 12));
    if (g.ln !== undefined) return !letterBefore(text, m.index) && digitsOf(g.ln).length >= 3;
    if (g.nw !== undefined) return !letterBefore(text, m.index);
  } else {
    let mws = g.mws ?? "";
    let strong = false;
    const mn = g.mn;
    if (mws !== "" && mn !== undefined && !(mn.length === 4 && (mn.charCodeAt(0) === 49 || mn.charCodeAt(0) === 50) && YEAR.test(mn))) {
      const c0 = mn.charCodeAt(0);
      const cz = mn.charCodeAt(mn.length - 1);
      const tail = (): boolean => multTail(text, end + mws.length + g.mr!.length);
      if (mn.length <= 5 && /^\d+$/.test(mn)) {
        const ta = TECH_ALL.test(mws);
        if ((ta || (PERIOD_VERB_END.test(mws) && /\d/.test(mws))) && !tail()) return false;
        strong = ta && TECH_STRONG.test(mws);
      } else if ((strong = TECH_STRONG.test(mws)) && c0 >= 48 && c0 <= 57 && mn.charCodeAt(mn.length - 3) !== 44
        && ((cz >= 48 && cz <= 57 && !tail() && !budgetWorks(g.mw, mws, mn)) || (((cz | 32) === 107 || (cz | 32) === 1082) && K_MULT.test(mn) && TECH_FIRST.test(mws))
          || TECH_MULT.test(mws))) return false;
      else if (c0 >= 48 && c0 <= 57 && cz >= 48 && cz <= 57 && mn.charCodeAt(mn.length - 3) !== 44 && BUDGET_WORD.test(g.mw) && BUDGET_OF.test(mws)
        && !tail()) return false;
    }
    const ambig = AMBIG_HEAD.test(g.mw);
    if (letterBefore(text, m.index)) return false;
    const wb = techWordBefore(text, m.index);
    if (wb !== "" && (TECH_BEFORE.test(wb) || (/^window$/iu.test(wb) && CONTEXT_WINDOW.test(text.slice(Math.max(0, m.index - 20), m.index)))
      || (TECH_BEFORE_BUDGET.test(wb) && /^(?:бюджет|budget)/iu.test(g.mw)))) return false;
    const limit = ambig && wb !== "" && TECH_BEFORE_WEAK.test(wb);
    if (g.mc !== undefined) return !limit && !MULT_MONEY.test(g.mw) && amountColumn(text, m.index, memo);
    if (/^amount$/i.test(g.mw)) return false;
    let n = g.mn!, sep = g.mr!.slice(0, g.mr!.length - n.length), stop = end + mws.length + g.mr!.length;
    const pm = /\d/.test(mws) ? mws.replace(PERIOD_WS, "\u0000") : mws, ws = pm.match(/\p{L}+/gu) ?? [];
    let words = ws.length + (pm !== mws && ws.some((w) => PLURAL_GEN.test(w)) ? 2 : 0);
    for (let i = 1; i < ws.length; i++) {
      if (PERIOD_NOUN.test(ws[i]) && PERIOD_PREP.test(ws[i - 1]) && !ws.some((w, j) => j < i - 1 && PLURAL_GEN.test(w))) words -= 2;
    }
    if (YEAR.test(n)) {
      const a = ws.at(-1) ?? "", month = MONTH.test(a), prep = YEAR_PREP.test(a);
      if (((month || prep) && !mws.endsWith(".") && /^[ \t:*_]*$/.test(sep)) || /^[./-]\d/.test(text.slice(stop, stop + 2))) {
        words -= month ? (YEAR_PREP.test(ws.at(-2) ?? "") ? 2 : 1) : prep ? 1 : 0;
        YEAR_NEXT.lastIndex = stop;
        const y = YEAR_NEXT.exec(text)?.groups;
        if (!y || YEAR.test(y.yn)) return false;
        const yws = (y.yw.match(/\p{L}+/gu) ?? []).filter((w) => !YEAR_WORD.test(w));
        if (yws.length > 0 && !(/[\p{L}$€£¥₽]|,\d{2}$/u.test(y.yn) || GROUPED.test(y.yn))) return false;
        n = y.yn; mws += y.yw; sep = y.ys; stop = YEAR_NEXT.lastIndex; words += yws.length;
        strong = techStrong(mws);
      }
    }
    const sign = /^[$€£¥₽]/.test(n), mult = /\p{L}/u.test(n) || multTail(text, stop), kop = /,\d{2}$/.test(n), grouped = /\d[ \t.]\d{3}/.test(n), d = digitsOf(n).length;
    const big = d >= 6 && grouped, small = !(kop || sign || mult) && d <= 5 && !grouped;
    if (/^budget$/i.test(g.mw) && !(kop || sign) && !/\d[ \t]\d/.test(n) && (sep.includes("=") || /[-$_.]/.test(text[m.index - 1] ?? ""))) return false;
    if (!(kop || sign) && SQL_DEFAULT.test(mws)) return false;
    const budgetWord = BUDGET_WORD.test(g.mw);
    if (budgetWord && !(kop || sign || mult) && (pow2(n) || BUDGET_OF.test(mws))) return false;
    if (budgetWord && !(kop || sign || mult || grouped) && PER_UNIT_SOFT.test(mws)) return false;
    if (pm !== mws && !(kop || sign || mult || grouped) && PERIOD_VERB_END.test(mws)) return false;
    if (!(kop || sign) && ((strong && (!mult || (K_MULT.test(n) && TECH_FIRST.test(mws)) || TECH_MULT.test(mws)) && !budgetWorks(g.mw, mws, n))
      || (!mult && budgetWord && PER_UNIT.test(mws)))) return false;
    if (small && techSoft(mws)) return false;
    if (!(kop || sign || mult) && mws.length > 3 && UNIT_PHRASE.test(mws)) return false;
    if ((TECH_MODEL.test(mws) || (ambig && TECH_WEAK.test(mws))) && !(kop || sign || mult)) return false;
    if (limit && !(kop || sign || mult || big)) return false;
    if (words > 2 && !(kop || sign || mult) && !(big || (grouped && d >= 5 && /[:=|-]/.test(sep)))) return false;
    const after = text.slice(stop, stop + 40);
    const weak = WEAK_MONEY.test(g.mw) && !(/^сч[её]т/iu.test(g.mw) && /^[ \t]{1,3}на$/iu.test(mws));
    const u0 = after.charCodeAt(after.charCodeAt(0) === 32 ? 1 : 0);
    if (!sign && (u0 === 1091 || u0 === 1059) && UE_AFTER.test(after) && (PG_COST.test(g.mw) || PG_COST.test(mws) || PG_COST.test(text.slice(stop, stop + 60))
      || pgCostBefore(text, m.index, mws))) return false;
    if (weak && !(kop || sign) && COUNT_FIRST_WORD.test(g.mw) && COUNT_FIRST.test(mws) && !FIN_COUNT.test(mws) && !NDS_AFTER.test(after)
      && !(mult && /(?:^|[ \t])на$/iu.test(mws))) return false;
    const next = !weak && !/[:=|—–-]/.test(sep), multOnly = MULT_MONEY.test(g.mw);
    if ((weak || multOnly) && words > 2 && !(kop || sign)) return false;
    if (multOnly && !mult) {
      const cl = next ? countLen(after, kop, n) : -1;
      return cl >= 0 && nextAmount(text, stop + cl, mws, budgetWord, ambig, true);
    }
    if (weak && !(kop || big || mult || sign)) return false;
    if (/^(?:[.,]\d+)?\.\.\d|^[ \t-]?\d/.test(after) || EXPLAIN_AFTER.test(after)) return false;
    if (!sign && !kop && PO_END.test(mws)) {
      const pc = PO_COUNT.exec(after);
      if (pc !== null) return next && nextAmount(text, stop + pc[0].length, mws, budgetWord, ambig, multOnly);
    }
    if (kop || sign || (big && !weak)) {
      if (sign) return true;
      const cl = countLen(after, kop, n);
      return cl < 0 || (next && NEXT_HINT.test(text.slice(stop, stop + 80))
        && nextAmount(text, stop + cl, mws, budgetWord, ambig, multOnly, SUM_WORD.test(g.mw)) && !algoCount(after.slice(0, cl), mws));
    }
    if (!/^[ \t]?\p{L}/u.test(after) || MONEY_AFTER.test(after)) return true;
    if (!next || !NEXT_HINT.test(text.slice(stop, stop + 80))) return false;
    const cl = countLen(after, false, n);
    return cl >= 0 && nextAmount(text, stop + cl, mws, budgetWord, ambig, multOnly, SUM_WORD.test(g.mw)) && !algoCount(after.slice(0, cl), mws);
  }
  if (/^[€₽£¥₸₴]/.test(s) && SIGN_UNIT.test(text.slice(end, end + 16))) return false;
  const code = /^(\d{3})[ \t]?(?:rub|rur|usd|eur|kzt|byn|gbp|cny|chf|uah|jpy)$/i.exec(s);
  if (code && ISO_NUMERIC.has(code[1])) return false;
  return !(/(?<![\p{L}])р\.?$/u.test(s.toLowerCase()) && digitsOf(s).length < 3 && !/тыс|млн|млрд|миллион|миллиард|т\./iu.test(s));
}

const CONTRACT_NOT = /(?<![\p{L}])(?:пункт\p{L}{0,2}|п\.|раздел\p{L}{0,2}|стать\p{L}{0,2}|приложени\p{L}{0,2}|глав\p{L}{0,2}|част\p{L}{0,2}|таблиц\p{L}{0,2}|issue|задач\p{L}{0,2}|тикет\p{L}{0,2}|коммит\p{L}{0,2}|тест\p{L}{0,2}|верси\p{L}{0,2}|v\d+(?:\.\d+)*)(?![\p{L}\p{N}])|\d-(?:й|я|го|му|ой|ый|ий|ая|ое|ые)(?![\p{L}])|соглашени\p{L}{0,3}[ \t]{1,3}(?:о|об|по)[ \t]{1,3}(?:именовани|кодировани|стил|оформлени)/iu;
const API_CONTEXT = /(?<![\p{L}])(?:api|openapi|swagger|ya?ml|json|схем[аеуы]?|schema|endpoint|эндпоинт\p{L}{0,2}|событи\p{L}{0,2}|очеред\p{L}{0,2}|mcp|grpc|proto\p{L}{0,4}|rest|contracts)(?![\p{L}])|\/v\d/iu;
const NOT_PREFIX = /^(?:sla|iso|iec|гост|gost|rfc|adr|api|mr|pr|cve|tls|ssl|http|utf|тз|ту|ос|os|v)$/i;
const DS_DATASET = /^[ \t]{0,3}[-:(,][ \t]{0,3}(?:эт[оа][ \t]{1,3})?(?:датасет|dataset|набор\p{L}{0,2}[ \t]{1,3}данных|выборк|разметк|(?:csv|parquet|jsonl?)(?![\p{L}])|\d[\d \t]{0,12}(?:строк|записей|столбц\p{L}{0,2}|колон\p{L}{0,3}|rows|records)(?![\p{L}])|(?:строк|записей|столбцов|колонок|rows|records)[ \t]{0,3}[:=][ \t]{0,3}\d)/iu;
function contractOk(m: RegExpExecArray, text: string): boolean {
  const s = m[0], g = m.groups ?? {};
  if (CONTRACT_NOT.test(s)) return false;
  if (/^(?:контракт|(?:номер|№)[ \t]{0,3}контракт)/iu.test(s) && API_CONTEXT.test(text.slice(Math.max(0, m.index - 40), m.index + s.length + 80))) return false;
  if (/^дс/iu.test(s)) {
    return !DS_DATASET.test(text.slice(m.index + s.length, m.index + s.length + 60))
      || /договор|соглашени|(?<![\p{L}])дог\./iu.test(text.slice(Math.max(0, m.index - 60), m.index + s.length + 80));
  }
  if (g.lp !== undefined) return /^\p{Lu}{1,5}$/u.test(g.lp) && !NOT_PREFIX.test(g.lp);
  if (g.yr !== undefined) return !/^(?:19|20)\d{2}$/.test(g.yn!) && !/^(?:0[1-9]|1[0-2])$/.test(g.yn!);
  if (g.sn !== undefined) {
    if (g.sl !== undefined) return /\p{Lu}/u.test(g.sl);
    return /\p{Lu}/u.test(g.sm!) || (/^(?:19|20)\d{2}(?![\p{N}])/u.test(g.sm!) && !/^(?:19|20)\d{2}$/.test(g.sn));
  }
  return !(/^(?:договоров|соглашений)/iu.test(s) && !s.includes("№"));
}

function privateKeyOk(m: RegExpExecArray, text: string): boolean {
  const end = m.index + m[0].length;
  if (m[0].startsWith("-----") && text.length - end <= 8 && /^[ \t]*$/.test(text.slice(end))) {
    return /^[ \t>]*$/.test(text.slice(text.lastIndexOf("\n", m.index - 1) + 1, m.index));
  }
  if (!m[0].startsWith("LS0t")) return true;
  try { return /^-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY/.test(atob(m[0].slice(0, m[0].length - (m[0].length % 4)))); } catch { return false; }
}

function jwtOk(m: RegExpExecArray): boolean {
  const p = m[0].split(".")[1];
  try { return !/"name":"John Doe"/.test(atob(p.replace(/-/g, "+").replace(/_/g, "/").slice(0, p.length - (p.length % 4)))); } catch { return true; }
}

function memoryKeyOk(m: RegExpExecArray): boolean {
  const body = m[0].replace(/^mem_[a-z]+_/, "");
  return new Set(body).size >= 8;
}

type Validator = (m: RegExpExecArray, text: string, memo: Memo) => boolean;
const VALIDATORS: Record<OpenCheckValidator, Validator> = {
  luhn: cardOk,
  snils: (m) => snilsOk(digitsOf(m[0])),
  inn: (m) => innOk(digitsOf(m[0])),
  phone: phoneOk,
  token: (m) => notPlaceholder(m[0]),
  secret: (m) => secretLike(m.groups?.v ?? m[0]),
  assignment: assignmentOk,
  password: passwordOk,
  email_near_name: emailNearName,
  passport: passportOk,
  amount: amountOk,
  contract: contractOk,
  private_key: privateKeyOk,
  jwt: jwtOk,
  memory_key: memoryKeyOk,
};

const NDA_WORD_MAX = 255;
const NDA_WORD = re`\p{L}(?:[\p{L}\p{M}\u00ad\u200b-\u200d\u2060\ufeff]|['’ʼ\u0060](?=\p{L})){0,${NDA_WORD_MAX}}|\p{N}{1,${NDA_WORD_MAX}}`;
const NDA_TAIL_L = new RegExp(re`(?:[\p{L}\p{M}\u00ad\u200b-\u200d\u2060\ufeff]|['’ʼ\u0060](?=\p{L})){1,4096}`, "uy");
const NDA_TAIL_N = /\p{N}{1,4096}/uy;
const NDA_JOINER = /[\u00ad\u200b-\u200d\u2060\ufeff'’ʼ`]/;
const NDA_LINK = /^(?:[ \t\r\n"'«»“”„‘’`‹›&_-]|\.(?![ \t\r\n]))*$/;
const NDA_MAX_WORDS = 12;
const ENDINGS: ReadonlySet<string> = new Set(("а я о е и ы у ю ь й ой ей ою ею ом ем ам ям ах ях ов ев ью ья ье ьи ий ый ая яя ое ее ые ие "
  + "ия ии ию ами ями ого его ому ему ым им ую юю ых их ыми ими иям иях ией ием ьев ьям ьях ьми").split(" ").concat(""));
const NOMINATIVE = "ий ый ой ая яя ое ее ые ие ье ья ьи а я о е ь й и ы".split(" ");
const PARADIGMS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = ([
  ["ый", "ый ого ому ым ом"], ["ий", "ий ого его ому ему им ем ом ия ию ием ии"], ["ой", "ой ого ому ым ом"], ["ая", "ая ой ую ою"],
  ["яя", "яя ей юю ею"], ["ое", "ое ого ому ым ом"], ["ее", "ее его ему им ем"], ["ые", "ые ых ым ыми"],
  ["ие", "ие ия ию ием ии ий иям иями иях их им ими"], ["ье", "ье ья ью ьем ьи ий ьям ьями ьях"], ["а", "а ы и е у ой ою ам ами ах"],
  ["я", "я и е ю ей ею ям ями ях"], ["о", "о а у ом е"], ["ь", "ь и ью ей я ю ем е ям ями ях"], ["й", "й я ю ем е и ев ям ями ях"],
  ["ы", "ы ов ам ами ах"], ["и", "и ей ов ев ам ами ах ям ями ях"],
] as const).map(([e, f]) => [e, new Set(f.split(" "))] as const);
const NOUN_Y = PARADIGMS.find(([e]) => e === "й")![1];
const NOUN_SOFT = PARADIGMS.find(([e]) => e === "ь")![1];
const CONSONANT: ReadonlySet<string> = new Set(" а у ом е ы и ов ам ами ах ев ем".split(" "));
const FLEETING: ReadonlySet<string> = new Set([...CONSONANT].filter(Boolean));
const EXACT: ReadonlySet<string> = new Set([""]);
const LATIN: ReadonlySet<string> = new Set(["", "s", "а", "у", "ом", "е", "ы", "ов", "ам", "ами", "ах", "ой", "ою", "ю", "ем", "я", "и"]);
const ALL_ENDINGS: ReadonlySet<string> = new Set([...ENDINGS, ...PARADIGMS.flatMap(([, f]) => [...f]), ...CONSONANT, ...LATIN]);
const ABSORB: ReadonlySet<string> = new Set([...ALL_ENDINGS].flatMap((x) => [...x].map((_, i) => [x.slice(0, i + 1), x.slice(i + 1)] as const)
  .filter(([d, e]) => d.length <= 4 && ALL_ENDINGS.has(e)).map(([d]) => d)));
const LEGAL_SHORT = new Set(("ооо оао зао пао ао нао нко ано ип фгуп гуп муп фгбу фгбоу гбу мбу мку тоо чп гк нпо нпп нпф нии тд "
  + "llc ltd inc gmbh jsc pjsc ojsc cjsc plc corp co ag sa bv oy ab lp llp").split(" "));
const LEGAL_LONG = ["общество с ограниченной ответственностью", "непубличное акционерное общество", "публичное акционерное общество",
  "закрытое акционерное общество", "открытое акционерное общество", "акционерное общество", "индивидуальный предприниматель",
  "федеральное государственное унитарное предприятие", "государственное унитарное предприятие", "муниципальное унитарное предприятие",
  "автономная некоммерческая организация", "некоммерческая организация", "limited liability company", "joint stock company"].map((f) => f.split(" "));
const ORG_LEAD = ["группа компаний", "торговый дом", "научно производственное объединение", "научно производственное предприятие",
  "концерн", "холдинг", "корпорация", "компания", "group of companies"].map((f) => f.split(" "));

const LATIN_MARKED = /[\u00e0-\u024f]/g;

const LAT_CYR: Readonly<Record<string, string>> = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у" };
const CYR_LAT: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(LAT_CYR).map(([l, c]) => [c, l]));
function unmix(s: string): string {
  if (s.length < 2 || !/[a-z]/.test(s) || !/[а-я]/.test(s) || /^[a-z]{2,}[а-я]{1,3}$/.test(s)) return s;
  if (/^[^a-z]*$/.test(s.replace(/[abcehkmoptxy]/g, ""))) return s.replace(/[abcehkmoptxy]/g, (c) => LAT_CYR[c]);
  if (/^[^а-я]*$/.test(s.replace(/[авсенкмортху]/g, ""))) return s.replace(/[авсенкмортху]/g, (c) => CYR_LAT[c]);
  return s;
}

function ndaLow(w: string): string {
  let s = w.toLowerCase();
  if (/[\u0300-\u036f]/.test(s)) s = s.normalize("NFC").replace(/[\u0300-\u036f]/g, "");
  if (s.includes("ё")) s = s.replace(/ё/g, "е");
  if (NDA_JOINER.test(s)) s = s.replace(/[\u00ad\u200b-\u200d\u2060\ufeff'’ʼ`]/g, "");
  if (/[\u00e0-\u024f]/.test(s)) s = s.replace(LATIN_MARKED, (c) => c.normalize("NFD")[0]).replace(/[\u0300-\u036f]/g, "");
  return s;
}
const ndaNorm = (w: string): string => unmix(ndaLow(w));

function ndaSplit(name: string): { words: string[]; orig: string[] } {
  const orig = name.match(new RegExp(NDA_WORD, "gu")) ?? [], words = orig.map(ndaNorm);
  const startsWith = (f: string[], at: number) => at >= 0 && f.every((x, i) => words[at + i] === x);
  const cut = (at: number, n: number) => { words.splice(at, n); orig.splice(at, n); };
  for (let changed = true; changed && words.length;) {
    changed = false;
    if (LEGAL_SHORT.has(words[0])) { cut(0, 1); changed = true; }
    else if (LEGAL_SHORT.has(words[words.length - 1])) { cut(words.length - 1, 1); changed = true; }
    for (const f of LEGAL_LONG) {
      if (startsWith(f, 0)) { cut(0, f.length); changed = true; }
      else if (words.length > f.length && startsWith(f, words.length - f.length)) { cut(words.length - f.length, f.length); changed = true; }
    }
    for (const f of ORG_LEAD) if (words.length > f.length && startsWith(f, 0)) { cut(0, f.length); changed = true; }
  }
  return { words, orig };
}
const ndaWords = (name: string): string[] => ndaSplit(name).words;

const ndaShort = (words: string[]): boolean => { const s = words.join(""); return s.length === 2 && /\d/.test(s) && /\p{L}/u.test(s); };

function ndaNameProblem(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim() || v.length > 200) return "the name must be a non-empty string of up to 200 characters";
  const words = ndaWords(v);
  if (!words.length) return "a company legal form on its own, without a name";
  if (words.join("").length < 3 && !ndaShort(words)) return "shorter than three letters without a company legal form — such a name would match ordinary words and abbreviations, give the full name";
  if (words.length > NDA_MAX_WORDS) return "more than 12 words — give a shorter name";
  return null;
}

function ndaForms(w: string, single: boolean): Array<readonly [string, ReadonlySet<string>]> {
  if (!/^[а-я]+$/.test(w)) return [[w, /^[a-z]+$/.test(w) ? LATIN : EXACT]];
  if (w.length <= (single ? 3 : 2)) return [[w, EXACT]];
  const out: Array<readonly [string, ReadonlySet<string>]> = [];
  const fl = w.length >= 5 ? /^(.*[^аеиоуыэюя])[ое]([кц])$/.exec(w) : null;
  if (fl) for (const s of [fl[1] + fl[2], fl[1] + "ь" + fl[2]]) out.push([s, single ? FLEETING : ENDINGS]);
  const fr = /^(.+[^аеиоуыэюя])[ое]([лр])$/.exec(w);
  if (fr) out.push([fr[1] + fr[2], single ? FLEETING : ENDINGS]);
  const fn = /^(.+[^аеиоуыэюя])ень$/.exec(w);
  if (fn) out.push([fn[1] + "н", single ? NOUN_SOFT : ENDINGS]);
  if (!single) {
    const stems = NOMINATIVE.filter((e) => w.endsWith(e) && w.length - e.length >= 2).map((e) => w.slice(0, -e.length));
    for (const s of stems.length ? stems : [w]) out.push([s, ENDINGS]);
    return out;
  }
  const p = PARADIGMS.find(([e]) => w.endsWith(e) && w.length - e.length >= 2);
  if (!p) out.push([w, /[аеиоуыэюя]$/.test(w) ? EXACT : CONSONANT]);
  else {
    out.push([w.slice(0, -p[0].length), p[1]]);
    if (p[0] === "ой") out.push([w.slice(0, -1), NOUN_Y]);
  }
  return out;
}

interface NdaEdge {
  go: ReadonlySet<string> | null; node: NdaNode | null; fin: ReadonlySet<string> | null; finCap?: ReadonlySet<string> | null;
  finUp?: ReadonlySet<string> | null;
}
interface NdaNode { edges: Map<string, NdaEdge>; longer: Map<string, string[]> }
interface NdaIndex { root: NdaNode; heads: Set<string>; short: string[]; shortI: string[]; shortRx?: RegExp | null; shortRxI?: RegExp | null }
type NdaCase = 0 | 1 | 2;
const NDA_CAP = 1, NDA_UP = 2;
const NDA_FIN = ["fin", "finCap", "finUp"] as const;
const ndaNode = (): NdaNode => ({ edges: new Map(), longer: new Map() });
const union = (a: ReadonlySet<string> | null, b: ReadonlySet<string>): ReadonlySet<string> => (!a || a === b ? b : new Set([...a, ...b]));

function ndaEdge(node: NdaNode, key: string): NdaEdge {
  let e = node.edges.get(key);
  if (!e) node.edges.set(key, (e = { go: null, node: null, fin: null }));
  return e;
}

function ndaFin(node: NdaNode, key: string, endings: ReadonlySet<string>, cs: NdaCase): void {
  const e = ndaEdge(node, key), f = NDA_FIN[cs];
  e[f] = union(e[f] ?? null, endings);
}

function ndaGo(node: NdaNode, key: string, endings: ReadonlySet<string>, into?: NdaNode): NdaNode {
  const hits: NdaNode[] = into ? [into] : [];
  const add = (k: string) => { const n = node.edges.get(k)?.node; if (n && !hits.includes(n)) hits.push(n); };
  add(key);
  for (let j = 1; j <= 4 && j < key.length; j++) if (ABSORB.has(key.slice(-j))) add(key.slice(0, -j));
  for (const k of node.longer.get(key) ?? []) add(k);
  const target = hits[0] ?? ndaNode();
  for (const other of hits.slice(1)) {
    for (const e of node.edges.values()) if (e.node === other) e.node = target;
    ndaMerge(target, other);
  }
  const e = ndaEdge(node, key);
  if (!e.node) {
    for (let j = 1; j <= 4 && j < key.length; j++) if (ABSORB.has(key.slice(-j))) {
      const p = key.slice(0, -j), l = node.longer.get(p);
      if (l) l.push(key); else node.longer.set(p, [key]);
    }
  }
  e.go = union(e.go, endings);
  e.node = target;
  return target;
}

function ndaMerge(into: NdaNode, from: NdaNode): void {
  for (const [key, e] of from.edges) {
    NDA_FIN.forEach((f, cs) => { const s = e[f]; if (s) ndaFin(into, key, s, cs as NdaCase); });
    if (e.go && e.node) ndaGo(into, key, e.go, e.node);
  }
}

function ndaAdd(idx: NdaIndex, words: string[], cs: NdaCase): void {
  const single = words.length === 1;
  let node = idx.root;
  for (let i = 0; i < words.length; i++) {
    const forms = ndaForms(words[i], single);
    if (i === words.length - 1) {
      for (const [k, e] of forms) {
        ndaFin(node, k, e, cs);
        if (single) for (let j = 2; j < k.length; j++) idx.heads.add(k.slice(0, j));
      }
      return;
    }
    let next: NdaNode | undefined;
    for (const [k, e] of forms) next = ndaGo(node, k, e, next);
    node = next!;
  }
}

const NDA_TRAIL = new Set("банк bank холдинг holding group группа груп corporation компания company".split(" "));

function ndaBrand(orig: string[], words: string[]): boolean {
  const o = orig.join("");
  return /\d/.test(o) || (o.length >= 2 && o === o.toUpperCase()) || words.join("").length >= 7;
}

const NDA_CASE_LEAD: ReadonlySet<string> = new Set(["банк"]);
function ndaCase(orig: string[], words: string[]): NdaCase {
  const lead = orig.length > 1 && NDA_CASE_LEAD.has(words[0]) ? 1 : 0;
  const letters = orig.slice(lead).join("").replace(/[^\p{L}]/gu, ""), first = letters[0] ?? "";
  if (first === first.toLowerCase()) return 0;
  if (letters.length < 2 || letters !== letters.toUpperCase()) return 1;
  const w = words.slice(lead).find((x) => /\p{L}/u.test(x)) ?? "";
  if (/^[a-z]/.test(w)) return letters.length <= 3 ? 2 : 1;
  return /[аеиоуыэюя]/.test(w) ? 1 : 0;
}

function ndaPut(idx: NdaIndex, words: string[], orig: string[]): void {
  if (!ndaShort(words)) { ndaAdd(idx, words, ndaCase(orig, words)); return; }
  const esc = (ch: string) => ch.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
  const both = (ch: string) => {
    const u = ch.toUpperCase(), l = ch.toLowerCase();
    return u !== l && u.length === 1 && l.length === 1 ? `[${u}${l}]` : esc(ch);
  };
  const low = orig.join("") === orig.join("").toLowerCase();
  const at = (g: (ch: string) => string, sep: string) => orig.map((w) => [...w].map(g).join("")).join(sep);
  idx.short.push(low ? `(?:${at(both, "")}|${at(esc, "[ -]")})` : at(esc, "[ -]?"));
  idx.shortI.push(at((ch) => (low || /\p{Script=Cyrillic}/u.test(ch) ? both(ch) : esc(ch)), "[ -]?"));
}

export function ndaNameKey(name: unknown): string | null {
  if (ndaNameProblem(name) !== null) return null;
  const { words, orig } = ndaSplit(name as string);
  return `${ndaCase(orig, words)}:${words.join(" ")}`;
}

function ndaIndex(names: unknown[]): NdaIndex | null {
  const idx: NdaIndex = { root: ndaNode(), heads: new Set(), short: [], shortI: [] };
  let any = false;
  for (const n of new Set(names)) {
    if (ndaNameProblem(n) !== null) continue;
    const { words, orig } = ndaSplit(n as string), cs = ndaCase(orig, words);
    ndaPut(idx, words, orig);
    if (words.length >= 2 && NDA_TRAIL.has(words[words.length - 1]) && ndaBrand(orig.slice(0, -1), words.slice(0, -1))) {
      ndaPut(idx, words.slice(0, -1), orig.slice(0, -1));
    }
    if (words.length >= 2 && words.length <= 3 && words.every((w) => /^\p{L}+$/u.test(w))) ndaAdd(idx, [words.join("")], cs);
    if (words.length === 3 && /^[а-я]+$/.test(words.join("")) && /(?:ович|евич|ьич|овна|евна|ична|инична)$/.test(words[2])) {
      ndaAdd(idx, [words[0], words[1][0], words[2][0]], cs);
      ndaAdd(idx, [words[1][0], words[2][0], words[0]], cs);
    }
    any = true;
  }
  if (idx.short.length) {
    const src = (a: string[]) => re`(?<![\p{L}\p{N}])(?:${a.join("|")})(?![\p{L}\p{N}])`;
    idx.shortRx = new RegExp(src(idx.short), "gu");
    idx.shortRxI = new RegExp(src(idx.shortI), "gu");
  }
  return any ? idx : null;
}

function ndaKeys(t: string): string[] {
  const out: string[] = [];
  for (let j = 0; j <= 4 && j < t.length; j++) {
    const e = j ? t.slice(-j) : "";
    if (ALL_ENDINGS.has(e)) out.push(j ? t.slice(0, -j) : t, e);
  }
  return out;
}

function ndaStep(node: NdaNode, keys: string[], cs: (j: number) => number, j: number, fin = true): NdaNode | true | null {
  let next: NdaNode | null = null, c = -1;
  for (let i = 0; i < keys.length; i += 2) {
    const e = node.edges.get(keys[i]);
    if (!e) continue;
    const end = keys[i + 1];
    if (fin && (e.fin?.has(end) || ((e.finCap?.has(end) || e.finUp?.has(end))
      && ((c < 0 ? (c = cs(j)) : c) & ((e.finCap?.has(end) ? NDA_CAP : 0) | (e.finUp?.has(end) ? NDA_UP : 0))) !== 0))) return true;
    if (!next && e.go?.has(end)) next = e.node;
  }
  return next;
}

const ndaLead = (keys: string[]): boolean => keys.some((k, j) => j % 2 === 0 && NDA_CASE_LEAD.has(k));

function ndaCaseOf(w: string): number {
  const a = w[0], b = w[1];
  if (a !== a.toUpperCase()) return 0;
  return a === a.toLowerCase() || b === undefined || (b === b.toUpperCase() && b !== b.toLowerCase()) ? NDA_CAP | NDA_UP : NDA_CAP;
}

interface NdaTok {
  t: string; at: number; low: boolean; cs: number; adj: boolean; sent: boolean; link: boolean; join: string | null; keys: string[] | null;
  mix: boolean;
}
const NDA_BITS = /^(?:8|16|32|64|128)$/;

function ndaFind(idx: NdaIndex, text: string, anyCase = false): number | null {
  const tree = ndaTree(idx, text, anyCase), rx = anyCase ? idx.shortRxI : idx.shortRx;
  if (!rx) return tree;
  rx.lastIndex = 0;
  const short = rx.exec(text)?.index ?? null;
  return short === null ? tree : tree === null ? short : Math.min(tree, short);
}

function ndaTree(idx: NdaIndex, text: string, anyCase: boolean): number | null {
  const rx = new RegExp(NDA_WORD, "gu"), buf: NdaTok[] = [];
  let base = 0, prevEnd = -1, prevLen = 0, done = false;
  const tok = (i: number): NdaTok | null => {
    while (i - base >= buf.length) {
      const m = done ? null : rx.exec(text);
      if (!m) { done = true; return null; }
      const w = m[0], gap = prevEnd < 0 ? "\n" : text.slice(prevEnd, m.index), cs = ndaCaseOf(w);
      let end = m.index + w.length;
      const long = w.length >= NDA_WORD_MAX;
      if (long) {
        const tail = /^\p{N}/u.test(w) ? NDA_TAIL_N : NDA_TAIL_L;
        for (let t: RegExpExecArray | null = null; (tail.lastIndex = end, t = tail.exec(text)) !== null;) {
          end = tail.lastIndex;
          if (t[0].length < 4096) break;
        }
        rx.lastIndex = end;
      }
      const link = gap.length <= 6 && (NDA_LINK.test(gap) || (prevLen === 1 && /^\.[ \t]{0,2}$/.test(gap)));
      const low = long ? "" : ndaLow(w), t = long ? "" : unmix(low);
      buf.push({ t, at: m.index, low: cs === 0, cs: anyCase ? NDA_CAP | NDA_UP : cs, adj: gap === "", sent: /[.!?\n]/.test(gap), link,
                 join: gap === " " || gap === "-" ? gap : null, keys: long ? [] : null, mix: t !== low });
      prevEnd = end;
      prevLen = end - m.index;
    }
    return buf[i - base];
  };
  const keys = (x: NdaTok) => (x.keys ??= ndaKeys(x.t));
  const caseOf = (x: NdaTok, j: number): number => {
    const n = tok(j + 1);
    return n && n.adj && NDA_BITS.test(n.t) ? x.cs & ~NDA_UP : x.cs;
  };
  let ci = 0, cl = false;
  const csAt = (j: number): number => caseOf(tok(ci)!, j) | (cl ? caseOf(tok(ci + 1)!, j) : 0);
  for (let i = 0; ; i++) {
    const first = tok(i);
    if (!first) return null;
    if (i - base > 64) { buf.splice(0, i - base); base = i; }
    ci = i;
    cl = false;
    let letters = first.t.length, mix = first.mix;
    let node = ndaStep(idx.root, keys(first), csAt, i, !mix || letters >= 4);
    cl = node !== null && node !== true && ndaLead(keys(first));
    for (let d = 1; node !== null && node !== true && d < NDA_MAX_WORDS; d++) {
      const x = tok(i + d);
      if (!x || !x.link) { node = null; break; }
      letters += x.t.length;
      mix ||= x.mix;
      node = ndaStep(node, keys(x), csAt, i + d, !mix || letters >= 4);
    }
    if (node === true) return first.at;
    if (idx.heads.has(first.t)) {
      const x = tok(i + 1);
      if (x && x.join && (!x.low || x.join === "-" || (!first.low && !first.sent))) {
        const t = first.t + x.t;
        cl = false;
        if (ndaStep(idx.root, ndaKeys(t), csAt, i + 1, !(first.mix || x.mix) || t.length >= 4) === true) return first.at;
      }
    }
  }
}

const NESTED = "nested repetition such as (a+)+, (\\w+\\s?)+, (a{1,30}){1,30} or (a?){30}: on text with no match the backtracking grows exponentially, "
  + "and a {0,N} limit does not help — remove the outer or the inner repetition";
const ALTERNATION = "repetition of a group containing “|” such as (a|b)* or (a|b){1,40}: the alternatives are tried exponentially — move the alternation "
  + "out of the repetition or replace it with a character class ([ab])";
const EMPTY_STRING = "the pattern matches an empty string — an empty match is not a finding, make at least one part mandatory";
const EMPTY_ONLY = "the pattern finds an empty position (lookahead or lookbehind only, \\b, or an alternation with no mandatory characters): "
  + "an empty match is not a finding, and the rule would never fire — add the actual characters you are looking for";
const SLOW = "the pattern is slow on a long string without spaces (“aaaa…”, “0000…”, JSON without spaces): the time grows faster than the text "
  + "length, and a large record will not finish within timeout_sec — put a boundary before the repetition ((?<![\\w.-]) or \\b) and bound "
  + "the repetition ({1,64} instead of + and *); matching is case-insensitive: [A-Z] also matches lowercase";
const CHAIN = "the pattern is slow: adjacent repetitions of the same characters such as \\w*\\w*, a?a?…a{30} or (?:a|a)(?:a|a)… split the string "
  + "between them in many ways, and on text with no match the backtracking grows as a power of the length or exponentially — keep one "
  + "repetition or separate the repetitions with a character that is in neither of them";
const WIDE = "the pattern is slow: a long repetition with no boundary before it (for example, [^!]{0,440}) is scanned from every position in the "
  + "text — limit it to a hundred characters ({1,100}) or put a boundary before it (\\b, (?<![\\w.-]) or a word)";
const QUANT = /[*+?]|\{(\d+)(,(\d*))?\}/y;

type RxNode = { t: "char"; src: string } | { t: "edge"; tr: boolean } | { t: "look"; neg: boolean; body: RxAlt; back?: boolean } | { t: "ref" }
  | { t: "group"; body: RxAlt } | { t: "rep"; body: RxNode; min: number; max: number };
type RxAlt = RxNode[][];

const LINE_EDGE: RxNode = { t: "look", neg: true, body: [[{ t: "char", src: "[^\\n\\r\\u2028\\u2029]" }]] };
const RX_PAIR = /\\u[dD][89abAB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}/y;
function rxParse(p: string): RxAlt {
  let i = 0, dotAll = false, multi = false;
  const atom = (): RxNode => {
    const ch = p[i], s = i;
    if (ch === "(") {
      let look = false, neg = false, back = false;
      const outer = [dotAll, multi] as const;
      if (p[i + 1] !== "?") i++;
      else if (p[i + 2] === "=" || p[i + 2] === "!") { look = true; neg = p[i + 2] === "!"; i += 3; }
      else if (p[i + 2] === "<" && (p[i + 3] === "=" || p[i + 3] === "!")) { look = back = true; neg = p[i + 3] === "!"; i += 4; }
      else if (p[i + 2] === "<") i = p.indexOf(">", i) + 1;
      else {
        const e = p.indexOf(":", i), [on, off = ""] = p.slice(i + 2, e).split("-");
        if (on.includes("s") || off.includes("s")) dotAll = on.includes("s");
        if (on.includes("m") || off.includes("m")) multi = on.includes("m");
        i = e + 1;
      }
      const body = alt();
      i++;
      [dotAll, multi] = outer;
      return look ? { t: "look", neg, body, back } : { t: "group", body };
    }
    if (ch === "[") {
      for (i++; i < p.length && p[i] !== "]"; i++) if (p[i] === "\\") i++;
      i++;
      return { t: "char", src: p.slice(s, i) };
    }
    if (ch === "\\") {
      const c = p[i + 1];
      if (c === "b" || c === "B") { i += 2; return { t: "edge", tr: c === "B" }; }
      if (c === "k" || /[1-9]/.test(c)) { i = c === "k" ? p.indexOf(">", i) + 1 : i + 2 + (/^\d*/.exec(p.slice(i + 2))?.[0].length ?? 0); return { t: "ref" }; }
      RX_PAIR.lastIndex = i;
      i += c === "u" && RX_PAIR.test(p) ? 12
        : /[pPu]/.test(c) && p[i + 2] === "{" ? p.indexOf("}", i) - i + 1 : c === "u" ? 6 : c === "x" ? 4 : c === "c" ? 3 : 2;
      return { t: "char", src: p.slice(s, i) };
    }
    if (ch === "^" || ch === "$") { i++; return multi ? LINE_EDGE : { t: "edge", tr: false }; }
    if (ch === "." && dotAll) { i++; return { t: "char", src: "[\\s\\S]" }; }
    i += (p.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    return { t: "char", src: p.slice(s, i) };
  };
  const alt = (): RxAlt => {
    const out: RxAlt = [[]];
    while (i < p.length && p[i] !== ")") {
      if (p[i] === "|") { i++; out.push([]); continue; }
      let n = atom();
      QUANT.lastIndex = i;
      const q = QUANT.exec(p);
      if (q) {
        const min = q[0] === "+" ? 1 : q[0] === "*" || q[0] === "?" ? 0 : Number(q[1]);
        const max = q[0] === "?" ? 1 : q[0] === "*" || q[0] === "+" ? Infinity : q[2] === undefined ? Number(q[1]) : q[3] === "" ? Infinity : Number(q[3]);
        n = { t: "rep", body: n, min, max };
        i += q[0].length + (p[i + q[0].length] === "?" ? 1 : 0);
      }
      out[out.length - 1].push(n);
    }
    return out;
  };
  return alt();
}

const inner = (n: RxNode): RxAlt | null => (n.t === "group" || n.t === "look" ? n.body : n.t === "rep" ? inner(n.body) : null);
const anyNode = (n: RxNode, f: (x: RxNode) => boolean): boolean =>
  f(n) || (n.t === "rep" ? anyNode(n.body, f) : (inner(n) ?? []).some((s) => s.some((x) => anyNode(x, f))));

type CpText = { text: string; exact: boolean; from: number };
const cpString = (cps: number[]): string => {
  const parts: string[] = [];
  for (let i = 0; i < cps.length; i += 4096) parts.push(String.fromCodePoint(...cps.slice(i, i + 4096)));
  return parts.join("");
};
function astral(from: number, to: number, step = 1): string {
  const lo = Array.from({ length: 1024 / step }, (_, k) => String.fromCharCode(0xdc00 + k * step)), parts: string[] = [];
  for (let h = 0xd800 + ((from - 0x10000) >> 10); h <= 0xd800 + ((to - 0x10000) >> 10); h++) {
    const hc = String.fromCharCode(h);
    parts.push(hc + lo.join(hc));
  }
  return parts.join("");
}
function cpRange(from: number, to: number): string {
  if (from > 0xffff && from % 1024 === 0 && (to + 1) % 1024 === 0) return astral(from, to);
  if (from <= 0xffff && to > 0xffff) return cpRange(from, 0xffff) + cpRange(0x10000, to);
  const u = new Uint16Array((to - from + 1) * (to > 0xffff ? 2 : 1)), parts: string[] = [];
  let n = 0;
  for (let c = from; c <= to; c++) {
    if (c <= 0xffff) u[n++] = c;
    else { u[n++] = 0xd800 + ((c - 0x10000) >> 10); u[n++] = 0xdc00 + ((c - 0x10000) & 0x3ff); }
  }
  for (let i = 0; i < n; i += 8192) parts.push(String.fromCharCode.apply(null, u.subarray(i, Math.min(n, i + 8192)) as unknown as number[]));
  return parts.join("");
}
const cpAll = (from: number, to: number): CpText => ({ text: cpRange(from, to), exact: true, from });
const PROP_EXACT: ReadonlyArray<readonly [number, number]> = [[0x20000, 0x3ffff], [0xe0000, 0xe0fff]];
let codePoints: { base: CpText[]; prop: CpText[] } | null = null;
let highTexts: { gate: string; planes: CpText | null; tags: CpText } | null = null;
function codePointTexts(prop: boolean): CpText[] {
  if (codePoints === null) {
    const probes = (from: number, to: number): number[] => {
      const out: number[] = [];
      for (let c = from; c <= to; c += 0x100) out.push(c);
      for (let p = from >> 16; p <= to >> 16; p++) out.push(p * 0x10000 + 0xfffe, p * 0x10000 + 0xffff);
      return out.filter((c) => c >= from && c <= to).sort((a, b) => a - b);
    };
    const low = [cpAll(1, 0xd7ff), cpAll(0xd800, 0xdbff), cpAll(0xdc00, 0xdfff), cpAll(0xe000, 0x1ffff)];
    const up = { text: cpString(probes(0x40000, 0xdffff).concat(probes(0xe1000, 0x10ffff))), exact: false, from: 0x40000 };
    codePoints = { base: [...low, { text: cpString(probes(0x20000, 0x10ffff)), exact: false, from: 0x20000 }], prop: [...low, up] };
  }
  return prop ? codePoints.prop : codePoints.base;
}
const propMemo = new Map<string, number[]>();
function propBounds(p: string): number[] {
  const key = p.replace(/^\\p\{(?:Script_Extensions|scx)=/, "\\p{scx=").replace(/^\\p\{(?:Script|sc)=/, "\\p{sc=")
    .replace(/^\\p\{(?:General_Category|gc)=/, "\\p{gc=");
  let out = propMemo.get(key);
  if (out === undefined) {
    out = [];
    try {
      const rx = new RegExp(`(?:${p})+`, "giu");
      const high = (highTexts ??= {
        gate: astral(0x20000, 0x3ffff, 16) + String.fromCodePoint(0x2fffe, 0x2ffff, 0x3fffe, 0x3ffff),
        planes: null, tags: cpAll(0xe0000, 0xe0fff),
      });
      const texts = [high.tags];
      if (rx.test(high.gate)) texts.push(high.planes ??= cpAll(0x20000, 0x3ffff));
      for (const { text, from } of texts) {
        rx.lastIndex = 0;
        for (let m = rx.exec(text); m; m = rx.exec(text)) out.push(from + m.index / 2, from + (m.index + m[0].length) / 2);
      }
    } catch { }
    if (propMemo.size > 500) propMemo.clear();
    propMemo.set(key, out);
  }
  return out;
}
function highPoints(src: string): number[] {
  const out: number[] = [];
  const add = (c: number) => { for (const x of [c - 1, c, c + 1]) if (x > 0x1ffff && x <= 0x10ffff) out.push(x); };
  for (const m of src.matchAll(/\\u\{([0-9a-f]+)\}|\\u(d[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})/gi)) {
    add(m[1] !== undefined ? parseInt(m[1], 16) : 0x10000 + ((parseInt(m[2], 16) - 0xd800) << 10) + parseInt(m[3], 16) - 0xdc00);
  }
  for (const ch of src) if (ch.codePointAt(0)! > 0xffff) add(ch.codePointAt(0)!);
  return out;
}
interface ClassPoints { starts: number[]; bounds: number[]; runs: number[]; prop: boolean }
const exactAt = (prop: boolean, p: number): boolean => (p >= 1 && p <= 0x1ffff) || (prop && ((p > 0x1ffff && p <= 0x3ffff) || (p >= 0xe0000 && p <= 0xe0fff)));
const classMemo = new Map<string, ClassPoints | null>();
function classPoints(src: string): ClassPoints | null {
  let out = classMemo.get(src);
  if (out !== undefined) return out;
  try {
    const rx = new RegExp(`(?:${src})+`, "giu"), starts: number[] = [], bounds: number[] = [], runs: number[] = [], prop = /\\[pP]\{/.test(src);
    for (const { text: all, exact, from } of codePointTexts(prop)) {
      rx.lastIndex = 0;
      for (let m = rx.exec(all); m; m = rx.exec(all)) {
        const s = m[0], c = s.codePointAt(0)!, lo = s.charCodeAt(s.length - 1), hi = s.length > 1 ? s.charCodeAt(s.length - 2) : 0;
        const last = lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff ? s.codePointAt(s.length - 2)! : lo;
        if (!(exact && c === from && from > 1 && m.index === 0 && charHas(src, String.fromCodePoint(from - 1)))) starts.push(c);
        bounds.push(c, last + 1);
        if (exact) runs.push(c, last);
      }
    }
    if (prop) {
      const cand = new Set<number>(highPoints(src));
      for (const pm of src.matchAll(/\\[pP]\{[^}]*\}/g)) for (const c of propBounds(`\\p${pm[0].slice(2)}`)) cand.add(c);
      for (const [a, b] of PROP_EXACT) {
        const cs = [a, ...[...cand].filter((c) => c > a && c <= b).sort((x, y) => x - y)];
        for (let k = 0, open = -1; k <= cs.length; k++) {
          const has = k < cs.length && ((rx.lastIndex = 0), rx.test(String.fromCodePoint(cs[k])));
          if (has && open < 0) open = cs[k];
          else if (!has && open >= 0) {
            const end = k < cs.length ? cs[k] : b + 1;
            starts.push(open);
            bounds.push(open, end);
            runs.push(open, end - 1);
            open = -1;
          }
        }
      }
    }
    for (const c of highPoints(src)) {
      bounds.push(c);
      if (!starts.includes(c) && charHas(src, String.fromCodePoint(c))) starts.push(c);
    }
    out = { starts, bounds, runs, prop };
  } catch { out = null; }
  if (classMemo.size > 2000) classMemo.clear();
  classMemo.set(src, out);
  return out;
}
const classStarts = (src: string): number[] | null => classPoints(src)?.starts ?? null;
function charsDisjoint(a: string, b: string): boolean {
  const sa = classStarts(a), sb = classStarts(b);
  return sa !== null && sb !== null && !sa.some((c) => charHas(b, String.fromCodePoint(c))) && !sb.some((c) => charHas(a, String.fromCodePoint(c)));
}

function fixedSafe(n: RxNode): boolean {
  if (n.t !== "rep" || n.min !== n.max || n.min > 100) return false;
  const alts = n.body.t === "group" ? n.body.body : [[n.body]];
  if (alts.length !== 1 || !alts[0].length) return false;
  const seq = alts[0], src = (x: RxNode): string | null => (x.t === "char" ? x.src : x.t === "rep" && x.body.t === "char" ? x.body.src : null);
  if (seq.some((x) => src(x) === null)) return false;
  return seq.every((x, i) => {
    if (x.t !== "rep" || x.min === x.max) return true;
    const next = seq[(i + 1) % seq.length];
    return !(next.t === "rep" && next.min < 1) && charsDisjoint(src(x)!, src(next)!);
  });
}

function nestedRisk(root: RxAlt): string | null {
  let out: string | null = null;
  const visit = (n: RxNode): void => {
    if (out) return;
    if (n.t === "rep" && n.max > 1 && !fixedSafe(n)) {
      if (anyNode(n.body, (x) => (x.t === "rep" && x.max !== x.min) || x.t === "ref")) { out = NESTED; return; }
      if (anyNode(n.body, (x) => (x.t === "group" || x.t === "look") && x.body.length > 1)) { out = ALTERNATION; return; }
    }
    if (n.t === "rep") visit(n.body);
    else (inner(n) ?? []).forEach((s) => s.forEach(visit));
  };
  root.forEach((s) => s.forEach(visit));
  return out;
}

const minLen = (n: RxNode): number => (n.t === "char" ? 1 : n.t === "group" ? minAlt(n.body) : n.t === "rep" ? Math.min(1e6, n.min * minLen(n.body)) : 0);
const minAlt = (a: RxAlt): number => Math.min(...a.map((s) => s.reduce((x, n) => x + minLen(n), 0)));
const bare = (n: RxNode): boolean => (n.t === "rep" ? n.min === 0 || bare(n.body) : n.t === "group" ? bareAlt(n.body) : n.t === "ref");
const bareAlt = (a: RxAlt): boolean => a.some((s) => s.every(bare));

const RUN_CHARS = [..."aZ0 \t\n_-.@/:,;\"'{}()[]=+*!?#$%&\\|<>~^`аЯё€№«»😀é٣²中 "];
const charRx = new Map<string, RegExp>();
function charHas(src: string, c: string): boolean {
  let rx = charRx.get(src);
  if (!rx) {
    if (charRx.size > 4000) charRx.clear();
    charRx.set(src, (rx = new RegExp(`^(?:${src})$`, "iu")));
  }
  return rx.test(c);
}

interface Run { u: number; b: number; v: number; m: number; start: boolean }
const RUN_LIMIT_START = 128, RUN_LIMIT = 1024, RUN_CAP = 1e12;

function runRisk(root: RxAlt, takes: ReadonlySet<string>, word = false, vars: readonly RxNode[] | null = null,
  blocked: ReadonlySet<RxNode> | null = null): string | null {
  let bad: string | null = null;
  const trm = new Map<RxNode, boolean>(), zero = (): Run => ({ u: 0, b: 1, v: 0, m: 0, start: false });
  const trAlt = (a: RxAlt): boolean => a.some((s) => s.every(tr));
  const tr = (n: RxNode): boolean => {
    let v = trm.get(n);
    if (v === undefined) {
      v = n.t === "char" ? takes.has(n.src) : n.t === "edge" ? n.tr : n.t === "ref" ? true
        : n.t === "look" ? (word && n.neg ? !blocked?.has(n) : trAlt(n.body) !== n.neg)
        : n.t === "group" ? trAlt(n.body) : n.min === 0 || tr(n.body);
      trm.set(n, v);
    }
    return v;
  };
  if (vars && !vars.some((n) => n.t === "ref" || (n.t === "rep" ? tr(n.body) : n.t === "group" && n.body.filter((s) => s.every(tr)).length > 1))) return null;
  const add = (r: Run, f: Run): Run => ({ u: r.u + f.u, b: Math.min(RUN_CAP, r.b * f.b), v: r.v + f.v, m: Math.min(RUN_CAP, r.m + f.m), start: r.start });
  const fac = (n: RxNode): Run => {
    if (n.t === "char") return { ...zero(), m: 1 };
    if (n.t === "ref") return { ...zero(), u: 1, v: 1 };
    if (n.t === "group") {
      const f = zero();
      let ways = 0;
      f.m = RUN_CAP;
      for (const s of n.body) if (s.every(tr)) {
        const x = s.map(fac).reduce(add, zero());
        f.u = Math.max(f.u, x.u); f.v = Math.max(f.v, x.v); f.m = Math.min(f.m, x.m); ways = Math.min(RUN_CAP, ways + x.b);
      }
      return { ...f, b: Math.max(1, ways), v: f.v + (ways > 1 ? 1 : 0), m: f.m === RUN_CAP ? 0 : f.m };
    }
    if (n.t !== "rep" || !tr(n.body)) return zero();
    const f = fac(n.body), m = Math.min(RUN_CAP, n.min * f.m);
    if (n.max - n.min > 1e6) return { u: f.u + 1, b: f.b, v: f.v + 1, m, start: false };
    return { u: f.u, b: Math.min(RUN_CAP, (n.max - n.min + 1) * f.b), v: f.v + (n.max > n.min ? 1 : 0), m, start: false };
  };
  const judge = (r: Run): void => {
    if (bad) return;
    if (word) { if (r.u >= 2) bad = CHAIN; return; }
    if (r.u + (r.start ? 1 : 0) >= 2) bad = r.u >= 2 || (r.u >= 1 && r.v >= 2) ? CHAIN : SLOW;
    else if (r.b > (r.start ? RUN_LIMIT_START : RUN_LIMIT)) bad = r.v >= 2 ? CHAIN : WIDE;
  };
  const judgeEnd = (r: Run): void => {
    if (word) return;
    const len = Math.max(1, r.m) - 1;
    if (!bad && Math.min(r.b, (len + 1) ** r.v) * (len + 1) ** r.u > (r.start ? RUN_LIMIT_START : RUN_LIMIT)) bad = r.v >= 2 ? CHAIN : WIDE;
  };
  const walk = (seq: RxNode[], r0: Run, end: "match" | "look" | null): void => {
    let r = r0;
    for (const n of seq) {
      if (n.t === "look") for (const s of n.body) walk(s, r, "look");
      else for (const s of inner(n) ?? []) walk(s, r, null);
      if (tr(n)) r = add(r, fac(n));
      else { judge(r); r = zero(); }
    }
    if (end === "match") judgeEnd(r);
    else if (end === "look") judge(r);
  };
  for (const s of root) walk(s, { ...zero(), start: true }, "match");
  return bad;
}

const litChar = (src: string): string | null => (!/^[[\\.]/.test(src) ? src : /^\\[^\p{L}\p{N}]$/u.test(src) ? src[1] : null);
const oneCp = (s: string): boolean => s.length === 1 || (s.length === 2 && s.codePointAt(0)! > 0xffff);
const foldMemo = new Map<number, number>();
function foldKey(ch: string): number {
  const c = ch.codePointAt(0)!;
  let k = foldMemo.get(c);
  if (k === undefined) {
    const u = ch.toUpperCase(), ul = oneCp(u) ? u.toLowerCase() : "", l = ch.toLowerCase();
    k = (oneCp(ul) ? ul : oneCp(l) ? l : ch).codePointAt(0)!;
    if (foldMemo.size > 200_000) foldMemo.clear();
    foldMemo.set(c, k);
  }
  return k;
}
function caseVariants(ch: string): number[] {
  const out = new Set<number>([ch.codePointAt(0)!]);
  for (const x of [ch.toLowerCase(), ch.toUpperCase(), ch.toUpperCase().toLowerCase(), ch.toLowerCase().toUpperCase()]) if (oneCp(x)) out.add(x.codePointAt(0)!);
  return [...out];
}

const PRE_MAX = 16;
function lookBlocked(root: RxAlt): Set<RxNode> {
  const out = new Set<RxNode>();
  type Pre = { at: string[][]; full: boolean };
  const seqPre = (seq: RxNode[], rev: boolean): Pre => {
    const at: string[][] = [];
    for (const n of rev ? [...seq].reverse() : seq) {
      const x = pre(n, rev);
      at.push(...x.at);
      if (!x.full || at.length >= PRE_MAX) return { at: at.slice(0, PRE_MAX), full: false };
    }
    return { at, full: true };
  };
  const pre = (n: RxNode, rev: boolean): Pre => {
    if (n.t === "char") return { at: [[n.src]], full: true };
    if (n.t === "edge" || n.t === "look") return { at: [], full: true };
    if (n.t === "ref") return { at: [], full: false };
    if (n.t === "group") {
      const alts = n.body.map((s) => seqPre(s, rev)), len = Math.min(...alts.map((a) => a.at.length));
      if (alts.length === 1) return alts[0];
      return { at: Array.from({ length: len }, (_, k) => [...new Set(alts.flatMap((a) => a.at[k]))]), full: alts.every((a) => a.full && a.at.length === len) };
    }
    const b = pre(n.body, rev), at: string[][] = [];
    for (let k = 0; k < n.min && at.length < PRE_MAX; k++) {
      at.push(...b.at);
      if (!b.full) return { at: at.slice(0, PRE_MAX), full: false };
    }
    return { at: at.slice(0, PRE_MAX), full: b.full && n.min === n.max && at.length <= PRE_MAX };
  };
  const flat = (seq: RxNode[], rev: boolean): string[] | null => {
    const res: string[] = [];
    for (const n of rev ? [...seq].reverse() : seq) {
      const x = n.t === "char" ? [n.src] : n.t === "group" && n.body.length === 1 ? flat(n.body[0], rev)
        : n.t === "rep" ? (n.min === 0 ? [] : flat(Array<RxNode>(Math.min(n.min, PRE_MAX + 1)).fill(n.body), rev)) : null;
      if (x === null) return null;
      res.push(...x);
      if (res.length > PRE_MAX) return null;
    }
    return res;
  };
  let scans = 0;
  const within = (small: string, big: string): boolean => {
    if (small === big) return true;
    const ch = litChar(small);
    if (ch !== null) return charHas(big, ch);
    const sp = classPoints(small);
    if (sp === null || !sp.starts.every((c) => charHas(big, String.fromCodePoint(c)))) return false;
    if (charHas(small, "\0") && !charHas(big, "\0")) return false;
    if (++scans > 8) return false;
    const cp = classPoints(`(?!${big})${small}`);
    return cp !== null && cp.starts.length === 0;
  };
  const visit = (seq: RxNode[]): void => {
    seq.forEach((n, k) => {
      if (n.t === "look" && n.neg && n !== LINE_EDGE) {
        const rev = n.back === true, nb = (rev ? seq.slice(0, k).reverse() : seq.slice(k + 1)).find((x) => x.t !== "look" && x.t !== "edge");
        const p = nb ? pre(nb, rev) : null, fs = n.body.map((s) => flat(s, rev));
        const one = fs.every((f) => f !== null && f.length === 1) ? `(?:${fs.map((f) => f![0]).join("|")})` : null;
        if (p && (fs.some((f) => f !== null && f.length <= p.at.length && f.every((big, j) => p.at[j].every((small) => within(small, big))))
          || (one !== null && p.at.length > 0 && p.at[0].every((small) => within(small, one))))) out.add(n);
      }
      (inner(n) ?? []).forEach(visit);
    });
  };
  root.forEach(visit);
  return out;
}

function patternRiskOf(pattern: string): string | null {
  const root = rxParse(pattern);
  if (bareAlt(root)) return EMPTY_STRING;
  const nested = nestedRisk(root);
  if (nested) return nested;
  if (minAlt(root) === 0) return EMPTY_ONLY;
  const hot = new Set<string>(), all = new Set<string>(), vars: RxNode[] = [];
  let refs = false;
  const atoms = (n: RxNode, h: boolean): void => {
    if ((n.t === "rep" && n.max > n.min) || (n.t === "group" && n.body.length > 1) || n.t === "ref") vars.push(n);
    if (n.t === "char") { all.add(n.src); if (h) hot.add(n.src); }
    else if (n.t === "ref") refs = true;
    else if (n.t === "rep") atoms(n.body, h || n.max > n.min);
    else if (n.t === "group") n.body.forEach((s) => s.forEach((x) => atoms(x, h || n.body.length > 1)));
    else if (n.t === "look") n.body.forEach((s) => s.forEach((x) => atoms(x, h)));
  };
  root.forEach((s) => s.forEach((x) => atoms(x, false)));
  const lits = new Map<number, string[]>(), classes: string[] = [], points = new Set<number>([0]);
  for (const ch of RUN_CHARS) points.add(ch.codePointAt(0)!);
  for (const src of all) {
    const ch = litChar(src);
    if (ch === null) {
      classes.push(src);
      for (const c of classPoints(src)?.bounds ?? []) points.add(c);
      continue;
    }
    const k = foldKey(ch), l = lits.get(k);
    if (l) l.push(src); else lits.set(k, [src]);
    for (const c of caseVariants(ch)) points.add(c).add(c + 1);
  }
  const memo = new Map<number, string[]>();
  const litsOf = (ch: string): string[] => (lits.get(foldKey(ch)) ?? []).filter((s) => charHas(s, ch));
  const litsAt = (c: number): string[] => {
    const k = foldMemo.get(c);
    return !lits.size || (k !== undefined && !lits.has(k)) ? [] : litsOf(String.fromCodePoint(c));
  };
  const takesOf = (c: number): string[] => {
    let out = memo.get(c);
    if (!out) {
      const ch = String.fromCodePoint(c);
      out = litsOf(ch);
      for (const s of classes) if (classPoints(s) === null || charHas(s, ch)) out.push(s);
      memo.set(c, out);
    }
    return out;
  };
  const pts = Array.from(Uint32Array.from([...points].filter((c) => c >= 0 && c <= 0x10ffff)).sort());
  const sig = pts.map(litsAt);
  for (const s of classes) {
    const cp = classPoints(s);
    if (!cp) { sig.forEach((x) => x.push(s)); continue; }
    for (let r = 0, k = 0; r < cp.runs.length; r += 2) {
      while (k < pts.length && pts[k] < cp.runs[r]) k++;
      for (; k < pts.length && pts[k] <= cp.runs[r + 1]; k++) sig[k].push(s);
    }
    pts.forEach((c, k) => { if (!exactAt(cp.prop, c) && charHas(s, String.fromCodePoint(c))) sig[k].push(s); });
  }
  pts.forEach((c, k) => memo.set(c, sig[k]));
  const reps = new Map<string, number>();
  for (const c of pts) {
    const t = takesOf(c);
    if (!refs && !t.some((s) => hot.has(s))) continue;
    const key = t.join("\u0000");
    if (!reps.has(key)) reps.set(key, c);
  }
  for (const c of reps.values()) {
    const risk = runRisk(root, new Set(takesOf(c)), false, vars);
    if (risk) return risk;
  }
  const words: Set<string>[] = [];
  const wordOf = (n: RxNode): void => {
    if (n.t === "rep" && minLen(n.body) >= 2) {
      const w = new Set<string>();
      const add = (x: RxNode): void => {
        if (x.t === "char") {
          const ch = litChar(x.src);
          const cs = ch !== null ? [ch.codePointAt(0)!] : [...reps.values()].filter((c) => takesOf(c).includes(x.src));
          for (const c of cs) for (const s of takesOf(c)) w.add(s);
        } else if (x.t === "rep") add(x.body);
        else (inner(x) ?? []).forEach((sq) => sq.forEach(add));
      };
      add(n.body);
      if (w.size) words.push(w);
    }
    if (n.t === "rep") wordOf(n.body);
    else (inner(n) ?? []).forEach((sq) => sq.forEach(wordOf));
  };
  root.forEach((sq) => sq.forEach(wordOf));
  const blocked = words.length ? lookBlocked(root) : null;
  for (const w of words) {
    const risk = runRisk(root, w, true, vars, blocked);
    if (risk) return risk;
  }
  return null;
}

const riskCache = new Map<string, string | null>();
function patternRisk(pattern: string): string | null {
  let risk = riskCache.get(pattern);
  if (risk === undefined) {
    risk = patternRiskOf(pattern);
    if (riskCache.size > 500) riskCache.clear();
    riskCache.set(pattern, risk);
  }
  return risk;
}

export interface OpenCheckSettings {
  enabled: boolean; disabled_rules: string[]; extra_rules: OpenCheckRule[]; nda_customers: string[]; timeout_sec: number;
  /** Rule packs in force. Optional: absent or invalid — every pack, the strictest set. */
  packs?: readonly OpenCheckPack[];
}
interface SettingsLike { get<T>(path: string, fallback: T): T }

export const OPEN_CHECK_DEFAULT_DISABLED: readonly string[] = ["amount"];

export const OPEN_CHECK_TIMEOUT_SEC = 10;
const timeoutOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 120;

export function openCheckSettings(s: SettingsLike): OpenCheckSettings {
  const timeout = s.get<number>("open_check.timeout_sec", OPEN_CHECK_TIMEOUT_SEC);
  return {
    enabled: s.get<boolean>("open_check.enabled", true) !== false,
    disabled_rules: s.get<string[]>("open_check.disabled_rules", [...OPEN_CHECK_DEFAULT_DISABLED]),
    extra_rules: s.get<OpenCheckRule[]>("open_check.extra_rules", []),
    nda_customers: s.get<string[]>("open_check.nda_customers", []),
    timeout_sec: timeoutOk(timeout) ? timeout : OPEN_CHECK_TIMEOUT_SEC,
    // rule packs: the code's fallback is every pack — no row, an unset value (written past the API) or an unpinned
    // anchored key never weakens the check; a damaged list — every pack too; a value of another JSON type — the seed default
    // (Settings.get); the seed default of a fresh install is narrower (OPEN_CHECK_PACKS_DEFAULT)
    packs: [...activePacks(s.get<unknown>("open_check.packs", [...OPEN_CHECK_PACKS]))].sort((a, b) => OPEN_CHECK_PACKS.indexOf(a) - OPEN_CHECK_PACKS.indexOf(b)),
  };
}

const EXTRA_KINDS = new Set<OpenCheckKind>(["secret", "pii", "money", "contract", "custom"]);

export function openCheckSettingProblems(key: string, value: unknown): string[] {
  // rule packs: no unset value through the API — the check reads unset as every pack, the weakening policy as the
  // seed default; with an explicit list both read the same packs
  if (key === "packs") return value === null ? [OPEN_CHECK_PACKS_UNSET] : openCheckPacksProblems(value);
  if (value === null) return [];
  if (key === "disabled_rules") {
    if (!Array.isArray(value)) return ["expected a list of rule names"];
    const unknown = value.filter((v) => typeof v !== "string" || !BUILTIN_RULE_NAMES.has(v));
    return unknown.length ? [`no such built-in rules: ${unknown.map(String).join(", ")}; available: ${[...BUILTIN_RULE_NAMES].join(", ")}`] : [];
  }
  if (key === "nda_customers") {
    if (!Array.isArray(value)) return ["expected a list of customer names"];
    if (value.length > 1000) return ["no more than 1000 names"];
    const out: string[] = [];
    for (const v of value) {
      const why = ndaNameProblem(v);
      if (why && out.length < 3) out.push(`${JSON.stringify(typeof v === "string" ? v.slice(0, 60) : v)}: ${why}`);
    }
    return out;
  }
  if (key === "extra_rules") {
    if (!Array.isArray(value)) return ["expected a list of rules {name, kind, pattern, reason}"];
    if (value.length > 100) return ["no more than 100 custom rules"];
    const out: string[] = [], names = new Set<string>();
    value.forEach((r, i) => {
      const at = `rule ${i + 1}`;
      if (!r || typeof r !== "object" || Array.isArray(r)) { out.push(`${at}: expected an object`); return; }
      const extra = Object.keys(r).filter((k) => !["name", "kind", "pattern", "reason"].includes(k));
      if (extra.length) out.push(`${at}: unexpected fields ${extra.join(", ")}`);
      if (typeof r.name !== "string" || !/^[A-Za-z0-9_]{2,64}$/.test(r.name)) out.push(`${at}: name must be 2 to 64 Latin letters, digits or “_”`);
      else if (BUILTIN_RULE_NAMES.has(r.name) || r.name === "nda") out.push(`${at}: the built-in rule already uses the name ${r.name}`);
      else if (names.has(r.name)) out.push(`${at}: name ${r.name} is duplicated`);
      else names.add(r.name);
      if (!EXTRA_KINDS.has(r.kind)) out.push(`${at}: kind must be one of ${[...EXTRA_KINDS].join(", ")}`);
      if (typeof r.reason !== "string" || !r.reason.trim() || r.reason.length > 200) out.push(`${at}: reason must be a refusal reason of up to 200 characters`);
      if (typeof r.pattern !== "string" || !r.pattern || r.pattern.length > 1000) { out.push(`${at}: pattern must be a regular expression of up to 1000 characters`); return; }
      try { new RegExp(r.pattern, "giu"); } catch (e) { out.push(`${at}: could not parse the pattern — ${(e as Error).message.slice(0, 120)}`); return; }
      const risk = patternRisk(r.pattern);
      if (risk) out.push(`${at}: ${risk}`);
    });
    return out;
  }
  if (key === "enabled" || key === "despite_enabled" || key === "despite_projects" || key === "despite_scans_text" || key === "recheck_on_nda_change")
    return typeof value === "boolean" ? [] : ["expected true or false"];
  if (key === "timeout_sec") return timeoutOk(value) ? [] : ["expected a whole number of seconds from 1 to 120"];
  return [];
}

interface Compiled { rule: OpenCheckRule; re: RegExp | null; builtin: boolean; nda: NdaIndex | null; reN?: RegExp | null }
export interface OpenCheckConfig { enabled: boolean; compiled: Compiled[] }

const NDA_RULE: OpenCheckRule = { name: "nda", kind: "nda", reason: "customer on the strict NDA list", pattern: "" };
const cache = new Map<string, OpenCheckConfig>();

function yoPattern(p: string): string {
  if (!/[ёЁ]/.test(p)) return p;
  let out = "", cls = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "\\") { out += ch + (p[i + 1] ?? ""); i++; continue; }
    if (ch === "ё" || ch === "Ё") {
      const e = ch === "ё" ? "е" : "Е";
      out += !cls ? e : p[i + 1] === "-" && p[i + 2] !== undefined && p[i + 2] !== "]" ? e + ch : ch + e;
      continue;
    }
    if (cls && ch === "]") cls = false;
    else if (!cls && ch === "[") cls = true;
    out += ch;
  }
  return out;
}

/**
 * The name under which a stored custom rule runs, or null when it does not run (a broken or dangerous pattern written to the
 * base past the panel's check). A rule saved by an earlier version under a name that a built-in rule took later (cloud_key,
 * high_entropy_secret, bank_account, national_id, phone_intl, date_of_birth) keeps running under
 * `<name>_custom` when that name is free in the list (`all`), otherwise `<name>_custom_<n>` for the first free n of
 * q, q + 1, q + 2, where q is the rule's position in the list (from 1, at least 2); when all four names are taken (a list
 * written so on purpose) the last one is used. The list is read in its order with the names given so far, as the seed
 * renames it (04-seed.sql: one statement per position, each sees the renames before it), so the two give the same names.
 * The administrator's protection does not stop after an upgrade, and its findings are never
 * read as the built-in rule's — what an author may show is decided by the rule's name (despite.ts); after the seed the
 * panel can save the list again; the panel refuses a new rule under a taken name.
 */
export function extraRuleRunsAs(rule: unknown, all: readonly unknown[] = [rule]): string | null {
  const i = all.indexOf(rule);
  return i < 0 ? extraRuleNames([rule])[0] : extraRuleNames(all)[i];
}

/** The names under which the stored custom rules run, position by position (extraRuleRunsAs); null — the rule does not run. */
export function extraRuleNames(all: readonly unknown[]): Array<string | null> {
  const current = all.map((r) => (r as { name?: unknown } | null)?.name);
  return all.map((rule, i) => {
    if (openCheckSettingProblems("extra_rules", [rule]).length === 0) return (rule as OpenCheckRule).name;
    const name = current[i];
    if (typeof name !== "string" || !(BUILTIN_RULE_NAMES.has(name) || name === "nda")) return null;
    const taken = (v: string) => current.includes(v) || BUILTIN_RULE_NAMES.has(v);
    const q = Math.max(i + 1, 2);
    let free = `${name}_custom`;
    for (let n = q; taken(free) && n <= q + 2; n++) free = `${name}_custom_${n}`;
    current[i] = free;
    return openCheckSettingProblems("extra_rules", [{ ...(rule as object), name: free }]).length === 0 ? free : null;
  });
}

export function openCheckConfig(s: OpenCheckSettings): OpenCheckConfig {
  const key = JSON.stringify(s);
  const hit = cache.get(key);
  if (hit) return hit;
  const off = new Set(s.disabled_rules);
  const on = activePacks(s.packs);
  const compiled: Compiled[] = BUILTIN_OPEN_CHECK_RULES.filter((r) => on.has(packOfRule(r.name)) && !off.has(r.name))
    .map((rule) => ({ rule, re: new RegExp(rule.pattern, rule.caseSensitive ? "gu" : "giu"), builtin: true, nda: null }));
  const extras: unknown[] = Array.isArray(s.extra_rules) ? s.extra_rules : [];
  const runAs = extraRuleNames(extras);
  for (const [k, stored] of extras.entries()) {
    const name = runAs[k];
    if (name === null) continue;
    const rule: OpenCheckRule = name === (stored as OpenCheckRule).name ? stored as OpenCheckRule : { ...(stored as OpenCheckRule), name };
    const re = new RegExp(rule.pattern, "giu"), yo = yoPattern(rule.pattern.normalize("NFC"));
    let reN: RegExp | null = re;
    if (yo !== rule.pattern) try { reN = new RegExp(yo, "giu"); } catch { reN = null; }
    compiled.push({ rule, re, builtin: false, nda: null, reN });
  }
  const nda = ndaIndex(Array.isArray(s.nda_customers) ? s.nda_customers : []);
  if (nda) compiled.push({ rule: NDA_RULE, re: null, builtin: true, nda });
  const cfg = { enabled: s.enabled, compiled };
  if (cache.size > 20) cache.clear();
  cache.set(key, cfg);
  return cfg;
}

/** Built-in rules with their pack and whether they run under these settings: the pack is on and the rule is not switched off. */
export function builtinRuleStates(s: OpenCheckSettings): Array<{ name: string; pack: OpenCheckPack; active: boolean }> {
  const on = activePacks(s.packs), off = new Set(Array.isArray(s.disabled_rules) ? s.disabled_rules : []);
  return BUILTIN_OPEN_CHECK_RULES.map((r) => {
    const pack = packOfRule(r.name);
    return { name: r.name, pack, active: on.has(pack) && !off.has(r.name) };
  });
}

interface Norm { text: string; cuts: Int32Array | null }
const NORM_ANY = /[\u0300-\u036f\u061c\u17b4\u17b5\u180b-\u180f\u2000-\u2015\u202a-\u202f\u205f-\u206f\u2212\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0ёЁ]|-(?<=\p{L}-)[ \t\r\n]/gu;
const NORM_CONJ: ReadonlySet<string> = new Set(["и", "или", "либо", "а", "and", "or", "to"]);
const NORM_LETTER = /\p{L}/u, NORM_LOWER = /\p{Ll}/u;
const normInvisible = (c: number): boolean => c === 0xad || (c >= 0x200b && c <= 0x200f) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff
  || (c >= 0x202a && c <= 0x202e) || (c >= 0xfe00 && c <= 0xfe0f) || c === 0x61c || c === 0x17b4 || c === 0x17b5 || (c >= 0x180b && c <= 0x180f)
  || c === 0x3164 || c === 0xffa0;
function normCode(c: number): number {
  if (c < 0xa0) return c;
  if (c === 0xa0 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) return 0x20;
  if ((c >= 0x2010 && c <= 0x2015) || c === 0x2212) return 0x2d;
  return c === 0x451 ? 0x435 : c === 0x401 ? 0x415 : c;
}
const normBlank = (c: number): boolean => c === 0x20 || c === 0x09;
function normCpAt(s: string, i: number): number {
  if (i >= s.length) return -1;
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff ? s.codePointAt(i)! : normCode(c);
}
const normMark = (c: number): boolean => c >= 0x300 && c <= 0x36f;
const NORM_PAIRS = new Map<number, number>();
function normCompose(a: number, m: number): number {
  const k = a * 0x10000 + m;
  let r = NORM_PAIRS.get(k);
  if (r === undefined) {
    const t = (String.fromCharCode(a) + String.fromCharCode(m)).normalize("NFC");
    r = t.length === 1 ? t.charCodeAt(0) : -1;
    if (NORM_PAIRS.size >= 4096) NORM_PAIRS.clear();
    NORM_PAIRS.set(k, r);
  }
  return r;
}
function normCpBefore(s: string, i: number): number {
  while (i > 1 && normMark(s.charCodeAt(i - 1))) i--;
  if (i <= 0) return -1;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) { const h = s.charCodeAt(i - 2); if (h >= 0xd800 && h <= 0xdbff) return s.codePointAt(i - 2)!; }
  return normCode(c);
}
function normIsLetter(cp: number): boolean {
  if (cp < 0x80) return (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a);
  if ((cp >= 0x410 && cp <= 0x44f) || cp === 0x401 || cp === 0x451) return true;
  return NORM_LETTER.test(String.fromCodePoint(cp));
}
function normIsLower(cp: number): boolean {
  if (cp < 0) return false;
  if (cp < 0x80) return cp >= 0x61 && cp <= 0x7a;
  if (cp >= 0x410 && cp <= 0x44f) return cp >= 0x430;
  return NORM_LOWER.test(String.fromCodePoint(cp));
}
function normConj(s: string, q: number): boolean {
  let w = "";
  for (let p = q; w.length <= 4;) {
    const cp = normCpAt(s, p);
    if (cp < 0) break;
    if (normMark(cp) && w) {
      const t = normCompose(w.charCodeAt(w.length - 1), cp);
      if (t >= 0) w = w.slice(0, -1) + String.fromCharCode(t);
      p++; continue;
    }
    if (!normIsLetter(cp)) break;
    w += String.fromCodePoint(cp);
    p += cp > 0xffff ? 2 : 1;
  }
  return NORM_CONJ.has(w);
}
function normJoinEnd(s: string, i: number): number {
  if (!normIsLetter(normCpBefore(s, i))) return -1;
  const n = s.length;
  let k = i + 1;
  while (k < n && normBlank(normCode(s.charCodeAt(k)))) k++;
  if (k < n && s.charCodeAt(k) === 0x0d) k++;
  if (k < n && s.charCodeAt(k) === 0x0a) {
    for (k++; k < n && normBlank(normCode(s.charCodeAt(k)));) k++;
    if (normIsLower(normCpAt(s, k))) return k;
  }
  const b = i + 1;
  return b < n && normBlank(normCode(s.charCodeAt(b))) && normIsLower(normCpAt(s, b + 1)) && !normConj(s, b + 1) ? b + 1 : -1;
}

const normEvent = (c: number): boolean => c === 0xa0 || normInvisible(c) || normMark(c) || c === 0x401 || c === 0x451 || (c >= 0x2000 && c <= 0x200a)
  || (c >= 0x2010 && c <= 0x2015) || c === 0x202f || c === 0x205f || c === 0x2212 || c === 0x3000;

function normalize(s: string): Norm {
  NORM_ANY.lastIndex = 0;
  const n = s.length;
  let from = NORM_ANY.exec(s)?.index ?? n;
  for (const ch of ["\u00a0", "\u00ad"]) { const k = s.indexOf(ch); if (k >= 0 && k < from) from = k; }
  if (from === n) return { text: s, cuts: null };
  const pieces: string[] = [], chunks: string[] = [], buf = new Uint16Array(4096);
  let cuts = new Int32Array(0), nc = 0, removed = 0, last = 0, bp = 0;
  const flush = (): void => {
    if (bp) pieces.push(String.fromCharCode.apply(null, buf.subarray(0, bp) as unknown as number[]));
    bp = 0;
  };
  const emit = (to: number, code: number, from: number): void => {
    if (to - last >= 32) { flush(); pieces.push(s.slice(last, to)); }
    else for (let k = last; k < to; k++) { buf[bp++] = s.charCodeAt(k); if (bp === buf.length) flush(); }
    if (code >= 0) { buf[bp++] = code; if (bp === buf.length) flush(); }
    last = from;
    if (pieces.length >= 4096) { chunks.push(pieces.join("")); pieces.length = 0; }
  };
  const cut = (i: number, x: number): void => {
    const at = i - removed;
    removed += x;
    if (nc > 0 && cuts[nc - 2] === at) { cuts[nc - 1] = removed; return; }
    if (nc + 2 > cuts.length) {
      const need = Math.max(cuts.length * 2, 64, Math.ceil(((nc + 2) / Math.max(i + 1, 65536)) * n * 1.1));
      const next = new Int32Array(Math.min(need, 2 * n + 2));
      next.set(cuts.subarray(0, nc));
      cuts = next;
    }
    cuts[nc++] = at;
    cuts[nc++] = removed;
  };
  for (let i = Math.max(0, from - 1); i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xa0 ? c !== 0x2d : !normEvent(c)) continue;
    if (normMark(c)) {
      const b = i - 1, bc = b >= last ? s.charCodeAt(b) : -1;
      let j = i;
      if (bc >= 0 && !(bc >= 0xd800 && bc <= 0xdfff) && !normMark(bc)) {
        let cur = bc;
        for (; j < n && normMark(s.charCodeAt(j)); j++) {
          const t = normCompose(cur, s.charCodeAt(j));
          if (t < 0) break;
          cur = t;
        }
        if (j > i) { emit(b, normCode(cur), j); cut(i, j - i); }
      }
      let k = j;
      while (k < n && normMark(s.charCodeAt(k))) k++;
      if (k > j) { emit(j, -1, k); cut(j, k - j); }
      i = k - 1;
      continue;
    }
    if (normInvisible(c)) {
      let j = i + 1;
      while (j < n && normInvisible(s.charCodeAt(j))) j++;
      emit(i, -1, j);
      cut(i, j - i);
      i = j - 1;
      continue;
    }
    const m = normCode(c);
    if (m === 0x2d) {
      const k = normJoinEnd(s, i);
      if (k > 0) { emit(i, -1, k); cut(i, k - i); i = k - 1; continue; }
    }
    if (m !== c) emit(i, m, i + 1);
  }
  if (last === 0) return { text: s, cuts: null };
  emit(n, -1, n);
  flush();
  chunks.push(pieces.join(""));
  return { text: chunks.length === 1 ? chunks[0] : chunks.join(""), cuts: nc ? cuts.subarray(0, nc) : null };
}

function origAt(n: Norm, at: number): number {
  const c = n.cuts;
  if (!c) return at;
  let lo = 0, hi = c.length / 2 - 1, add = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid * 2] <= at) { add = c[mid * 2 + 1]; lo = mid + 1; } else hi = mid - 1;
  }
  return at + add;
}

function firstMatch(c: Compiled, text: string, rx: RegExp = c.re!): number | null {
  const validate = c.rule.validate ? VALIDATORS[c.rule.validate] : null, memo: Memo = {}, scratch: Record<string, unknown> = {};
  rx.lastIndex = 0;
  for (let m = rx.exec(text); m; m = rx.exec(text)) {
    if (m[0].length === 0) {
      rx.lastIndex = m.index + ((text.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1);
      continue;
    }
    if (validate && !validate(m, text, memo)) continue;
    if (c.builtin && c.rule.check && !c.rule.check(m, text, scratch)) {
      if (c.rule.resumeInside) rx.lastIndex = m.index + ((text.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1);
      continue;
    }
    return m.index;
  }
  return null;
}

export function openCheck(cfg: OpenCheckConfig, texts: OpenCheckText[], opts: { force?: boolean } = {}): OpenCheckFinding[] {
  if (!cfg.enabled && !opts.force) return [];
  const out: OpenCheckFinding[] = [];
  for (const t of texts) {
    if (!t.value) continue;
    let norm: Norm | null = null;
    for (const c of cfg.compiled) {
      let at: number | null;
      if (c.builtin) {
        const n = (norm ??= normalize(t.value));
        at = c.nda ? ndaFind(c.nda, n.text, t.field === "filename" || t.field === "source") : firstMatch(c, n.text);
        if (at !== null) at = origAt(n, at);
      } else {
        at = firstMatch(c, t.value);
        const reN = c.reN === undefined ? c.re : c.reN;
        if (at === null && reN) {
          const n: Norm = (norm ??= normalize(t.value));
          if (n.text !== t.value || reN !== c.re) {
            at = firstMatch(c, n.text, reN);
            if (at !== null) at = origAt(n, at);
          }
        }
      }
      if (at === null) continue;
      out.push({ rule: c.rule.name, kind: c.rule.kind, reason: c.rule.reason, field: t.field, at });
      if (out.length >= OPEN_CHECK_MAX_FINDINGS) return out;
    }
  }
  return out;
}

export const openCheckReasons = (findings: OpenCheckFinding[]): string => [...new Set(findings.map((f) => f.reason))].join(", ");
