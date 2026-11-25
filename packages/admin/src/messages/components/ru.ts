// Original Russian component texts, with neutral examples.
import { productName } from "../../i18n/brand";
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import { pluralRu } from "../../i18n/core";
import { formatCount } from "../../i18n/format";
export const ACTION_FORM_TEXT: Messages<typeof en.ACTION_FORM_TEXT> = {
  openRecord: "Открыть запись",
  recordActions: "на странице записи — «{value1}» и «Удалить»",
  sending: "Отправка…",
};

export const STEP_LABEL: Messages<typeof en.STEP_LABEL> = { ok: "успешно", fail: "ошибка", warn: "предупреждение", skip: "пропущено" } as const;

export const ADMIN_PLANE_STUB_TEXT: Messages<typeof en.ADMIN_PLANE_STUB_TEXT> = {
  stubText: "Раздел появится в следующем выпуске. Пока здесь ничего не нужно делать.",
};

export const AGENT_CARD_TEXT: Messages<typeof en.AGENT_CARD_TEXT> = {
  cloudAgent: "облачный агент",
  agent: "Агент",
  keyPrefix: (prefix: string): string => `ключ ${prefix}…`,
  validThrough: (day: string): string => `действует до ${day} включительно`,
  noExpiry: "бессрочно",
  edgeSignIn: "извне · вход на странице памяти",
  workspaceSignIn: "вход через рабочее место памяти",
  companySignIn: "вход через учётную запись компании",
  reconnectEdge: "Чтобы подключить снова, подключите программу заново из неё — с паролем на странице входа памяти.",
  reconnectBuiltin: "Чтобы подключить снова, подключите программу заново: память снова спросит ваше согласие.",
  reconnectCompany: "Чтобы подключить снова, выйдите из учётной записи компании в браузере и войдите заново.",
  connectionExpiry: "{value1} · до {value2}",
  disconnected: "отключён",
  disconnect: "Отключить",
  disconnectConfirm: (title: string, hint: string): string => `Отключить ${title}? Его следующие запросы будут отклонены. ${hint}`,
};

export const CONNECTION_KIND_TITLES: Messages<typeof en.CONNECTION_KIND_TITLES> = { vscode: "VS Code", claude_desktop: "Claude Desktop", local_other: "Другая локальная программа" };

export const APPROVAL_PENDING_TEXT: Messages<typeof en.APPROVAL_PENDING_TEXT> = {
  request: "Заявка: {value1}",
  openRequest: "Открыть заявку",
};

export const CONFIRM_DIALOG_TEXT: Messages<typeof en.CONFIRM_DIALOG_TEXT> = {
  change: "Что изменится",
  who: "Кто увидит",
  undo: "Можно ли вернуть",
  cancel: "Отмена",
};

export const CONVERTER_BLOCK_TEXT: Messages<typeof en.CONVERTER_BLOCK_TEXT> = {
  title: "Конвертер документов",
  state: "состояние конвертера",
  holdNew: "Приостановить новые",
  holdNewConfirm: "Приостановить отправку новых документов в конвертер? Уже отправленные доведутся до конца.",
  holdAll: "Приостановить всё",
  holdAllConfirm: "Приостановить всю конвертацию документов? Документы будут ждать, пока вы не нажмёте «Возобновить».",
  resume: "Возобновить",
  probe: "Проверить подключение",
  probing: "Проверяем…",
  accountChangedHint: "Отметьте, только если учётную запись памяти у конвертера сменили намеренно: документы, отправленные прежней, будут отправлены заново.",
  accountChanged: " учётная запись сменена намеренно",
  lead: "Конвертер переводит документы PDF в текст. Он один на всех и берёт документы по очереди; если он недоступен или занят, документы ждут и продолжают сами, попытки при этом не тратятся.",
  confirmNewAccount: "Чтобы отправить документы заново под новой учётной записью, отметьте «учётная запись сменена намеренно» и нажмите «Проверить подключение».",
  recent: "Последние конвертации ({value1})",
  record: "Запись",
  status: "Состояние",
  atConverter: "У конвертера",
  waiting: "Ждёт",
  retries: "Повторы",
  orphans: "Ненужные копии у конвертера (последние {value1})",
  orphansHint: "Ни одна запись памяти больше не ссылается на эти копии у конвертера. Передайте номера администратору конвертера — он уберёт их у себя.",
  when: "Когда",
  whyUnused: "Почему не нужна",
  converterId: "Номер у конвертера",
  document: "документ {document}",
};

export const COPY_BLOCK_TEXT: Messages<typeof en.COPY_BLOCK_TEXT> = {
  copyLabel: (label: string): string => `Скопировать: ${label}`,
  copied: "Скопировано",
  copy: "Скопировать",
  failed: "Не удалось скопировать — выделите текст и скопируйте вручную.",
};

export const ERROR_ACTIONS_TEXT: Messages<typeof en.ERROR_ACTIONS_TEXT> = {
  home: "На Обзор",
  failed: "Раздел не открылся.",
  retryHint: " Попробуйте ещё раз; если повторяется — сообщите администратору памяти.",
  retrying: "Повторяем…",
  retry: "Повторить",
  details: "Подробнее для ИТ",
};

export const EXTERNAL_NOTICES_TEXT: Messages<typeof en.EXTERNAL_NOTICES_TEXT> = {
  dismiss: "Понятно",
};

export const HEALTH_BANNER_TEXT: Messages<typeof en.HEALTH_BANNER_TEXT> = {
  unreachable: "Гейтвей недоступен.",
  instance: (id: string): string => `инстанс ${id}`,
  statusLine: "{value1}Гейтвей: {value2}",
  missingSettings: "Не заполнены обязательные настройки, поэтому память не отвечает агентам и сервисам (HTTP 503). Панель при этом работает. Заполните их в разделе <mark1>Настройки</mark1> — строки помечены «не заполнено».",
  failClosed: "Гейтвей намеренно не обслуживает запросы, пока не пройдут проверки ниже. Панель при этом работает; параметры — в разделе <mark1>Настройки</mark1>.",
};

export const STATUS_TITLES: Messages<typeof en.STATUS_TITLES> = { ok: "в порядке", degraded: "работает с ограничениями", fail_closed: "не обслуживает запросы (fail-closed)" } as const;

export const HEALTH_DEGRADED_TEXT: Messages<typeof en.HEALTH_DEGRADED_TEXT> = {
  genericExplain: "Чтение и полнотекстовый поиск работают; стадии обработки, которым нужна модель или хранилище, ждут повтора.",
  fresh: "новое",
  freshCount: ", новое: {value1}",
  statusLine: "{value1}Гейтвей: <mark1>работает с ограничениями</mark1>{value2}{value3}",
  failedChecks: " — не пройдены: {value1}.",
  details: "подробнее",
  overview: "Что требует внимания — на Обзоре",
};

export const LLM_STATE_BLOCK_TEXT: Messages<typeof en.LLM_STATE_BLOCK_TEXT> = {
  title: "Модель",
  state: "состояние модели",
  resume: "Снять паузу",
  resumeConfirm: "Снять паузу обращений к модели? Паузы очереди проверок стенда останутся.",
  tryNow: "Попробовать сейчас",
  lead: "Модель одна на всю компанию: запросы к ней идут по одному. Если она занята или медленно отвечает, обработка ждёт и повторяется сама.",
  pausedBy: "Кто поставил паузу",
};

export const LOGIN_STATUS_CARD_TEXT: Messages<typeof en.LOGIN_STATUS_CARD_TEXT> = {
  unavailable: "Сводка {value1} недоступна: {value2}",
  lastCheck: "Последняя проверка",
  notInNinetyDays: "не было за 90 дней",
  passed: "пройдена",
  failed: "не пройдена{value1}",
  lastSignIn: "Последний успешный вход",
  lastDay: "За сутки",
  counts: "входов — {value1}, отказов — {value2} · <mark1>Входы в журнале</mark1>",
};

export const MEETING_ROW_TEXT: Messages<typeof en.MEETING_ROW_TEXT> = {
  ready: "Готово",
  failed: "Не получилось",
  processing: "Обрабатывается",
  untitled: "Без названия",
  projectMeeting: "Встреча по проекту",
  noProjectMeetings: "Встреч по проекту пока нет. Встреча появляется здесь, когда её решение передают в проект или организатор отмечает её как встречу по проекту.",
};

export const MISSING_PLAIN: Messages<typeof en.MISSING_PLAIN> = {
  title: "Такой страницы нет",
  lead: "Возможно, ссылка устарела или в адресе опечатка. Запись могли удалить или перенести — её можно найти поиском.",
  home: "На Обзор",
  search: "Поиск",
} as const;

export const MOCKS_TEXT: Messages<typeof en.MOCKS_TEXT> = {
  then: ", затем ",
  terminal: "Терминал",
  bestMatch: "Лучшее соответствие",
  application: "Приложение",
  program: "Программа",
  companySignIn: "<mark1>Example Corp</mark1> · ЕДИНЫЙ ВХОД",
  // Third-party screens and program names are reproduced in their original language.
  powerShell: "Windows PowerShell",
  signInHeading: "Sign in to your account",
  english: "English",
  username: "Username",
  password: "Password",
  rememberMe: "Remember me",
  signIn: "Sign In",
  authenticated: "Authentication successful",
  closeWindow: "You can close this window.",
  installServer: "Install MCP Server",
  cancelInstall: "Cancel",
  install: "Install",
  agentHeading: "Agent",
  chatPrompt: "Plan, search, build anything",
  toolCalled: "Called <app>{server}</app>.{tool}",
  welcome: " Welcome to <app>Claude Code</app>!",
  codexBrand: ">_ OpenAI Codex",
  directory: "· directory: ~",

};

export const KEYS: Messages<typeof en.KEYS> = {
  cmd: { glyph: "⌘", label: "cmd", sr: "Command" },
  win: { glyph: "⊞", label: "Win", sr: "клавиша Windows" },
  ctrl: { label: "Ctrl" }, alt: { label: "Alt" }, shift: { label: "Shift" },
  space: { label: "Пробел", wide: true },
  enter: { glyph: "↵", label: "Enter", sr: "Enter" },
};

export const WHO: Messages<typeof en.WHO> = { user: "Вы: ", tool: "Агент обращается к памяти: ", agent: "Агент: " };

export const PAGER_TEXT: Messages<typeof en.PAGER_TEXT> = {
  first: "« В начало",
  back: "‹ Назад",
  next: "Дальше ›",
  last: "это последняя страница",
  total: "Всего",
};

export const PEOPLE_PICKER_TEXT: Messages<typeof en.PEOPLE_PICKER_TEXT> = {
  get waitingPlain(): string { return `ещё не входил(а) в ${productName()} — позовите после первого входа`; },
  get invitePlain(): string { return `ещё не входил(а) в ${productName()} — попадёт в проект при первом входе`; },
  sessionEnded: "Сеанс завершён — обновите страницу и войдите снова",
  searchFailed: "Поиск не ответил — попробуйте ещё раз",
  seconds: (seconds: number): string => `${seconds} с`,
  oneMinute: "минуту",
  rateLimited: (wait: string): string => `Слишком много поисков подряд — подождите ${wait} и продолжите набирать`,
  networkFailed: "Поиск не ответил — проверьте сеть и попробуйте ещё раз",
  searching: "Ищем среди тех, у кого есть доступ к памяти…",
  notFound: "Никого не нашлось среди тех, у кого есть доступ к памяти. Проверьте написание или наберите почту коллеги целиком.",
  notSelected: (query: string): string => `«${query}» не выбран — выберите коллегу из подсказок, иначе его не позовут`,
  inviteColleague: "Позвать коллегу",
  newOwner: "Новый владелец",
  inviteAnother: "Позвать ещё коллегу",
  anotherPlaceholder: "Ещё коллега: фамилия, имя или почта",
  placeholder: "Фамилия, имя или почта коллеги",
  actHint: "Начните вводить фамилию, имя или почту — память подскажет коллег, у которых есть к ней доступ. Выбор сразу зовёт человека в проект.",
  singleHint: "Выберите из тех, кто сейчас в проекте, или начните вводить фамилию, имя или почту.",
  collectHint: "Начните вводить фамилию, имя или почту — память подскажет коллег, у которых есть к ней доступ. Каждый позванный — отдельной строкой. Необязательно: позвать можно и позже, на странице проекта.",
  inviteToProject: "Позвать в проект",
  emailPending: "по почте — память проверит при создании",
  removePerson: (name: string): string => `Убрать ${name}`,
  remove: "Убрать",
  chooseAnother: "Выбрать другого",
  limit: "Больше {value1} человек сразу не позвать — остальных добавьте на странице проекта.",
  suggestions: "Подходящие коллеги",
  currentMembers: "Сейчас в проекте",
  inviteByEmail: (email: string): string => `Позвать по почте ${email}`,
  emailSearchFailed: "Поиск не ответил — память проверит почту при создании проекта",
  invite: "Пригласить",
  inviteShort: "Позвать",
  alreadyMember: "уже в проекте",
  notSignedIn: "Есть в каталоге компании, но ещё не входили в память",
  firstTen: "Показаны первые 10 — уточните фамилию.",
  role: "Права позванного",
  inviting: "Зовём…",
  moreChars: (n: number): string => `Наберите ещё ${n} ${pluralRu(n, ["знак", "знака", "знаков"])}`,
};

export const PERSON_SUGGEST_TEXT: Messages<typeof en.PERSON_SUGGEST_TEXT> = {
  linkedPerson: "человек по ссылке",
  selected: "выбран: {value1}{value2}",
  unavailable: "Подсказки недоступны — можно набрать логин целиком",
  searching: "Ищем…",
  notFound: "Никого не нашлось среди действующих",
};

export const SLUG_PREVIEW: Messages<typeof en.SLUG_PREVIEW> = {
  label: "Адрес",
  empty: "Адрес составится из названия",
  edit: "изменить",
  note: "Если такой уже есть, добавится номер.",
} as const;

export const RECORD_ROW_TEXT: Messages<typeof en.RECORD_ROW_TEXT> = {
  untitled: "Без названия",
};

export const REPORT_DESPITE_TEXT: Messages<typeof en.REPORT_DESPITE_TEXT> = {
  summary: "Показано автором вопреки находке за {value1} ч: {value2}; из них только текстом — {value3}. Отказано воркером: {value4}.",
  record: "Запись",
  space: "Пространство",
  author: "Автор",
  when: "Когда",
  accepted: "Что принято",
  authorOnly: "видит только автор",
  shared: "видят и другие",
  textOnly: "только текстом (скан)",
};

export const REPORT_QUALITY_TEXT: Messages<typeof en.REPORT_QUALITY_TEXT> = {
  details: "Подробнее — страница «Качество поиска»",
  title: "Качество поиска за неделю",
  week: (span: string): string => `За неделю ${span}.`,
  searches: "Поисков",
  nothingFound: "Ничего не нашлось",
  firstThree: "Из первых трёх",
  nothingOpened: "Ничего не открыли",
  largestChange: "Больше всего изменилось к прошлой неделе: {value1}.",
  periodSearches: "Поисков за период",
  rollout: "Внедрение",
  rolloutHint: (span: string, counted: string): string => `Как сотрудники начинают пользоваться памятью. За неделю ${span}; только числа, без имён и без содержимого записей.${counted}`,
  conversations: "Разговоры ИИ-агентов с памятью",
  notCalculated: "Неделя ещё не посчитана — загляните позже.",
  conversationCount: "Разговоров ИИ-агентов с памятью — {value1}",
  queryCount: "из них с вопросом к памяти — {value1}",
  pastNotesFound: "нашли заметки, записанные раньше — {value1}",
  pastNotesOpened: "открыли такую заметку — {value1}",
  colleagueNotes: "нашли заметки коллег — {value1}",
  overviewPastNotes: "Обзор нового в начале разговора показал прошлые заметки — {value1}",
  conversationHint: "Разговор — работа агента без перерыва больше 30 минут. Обзор нового агент делает в начале каждого разговора сам, поэтому он считается отдельно.",
  openCheck: "Проверка открытого",
  agentNotes: "Новых заметок от ИИ-агентов — {value1}, из них сохранены закрытыми — {value2}; ещё {value3} проверка не пустила в открытое (не сохранены).",
  other: "другое",
  otherChecks: "Другие срабатывания проверки: {value1}.",
  notesBySpace: "Заметки по пространствам",
  space: "Пространство",
  kind: "Вид",
  notes: "Заметок",
  newThisWeek: "Новых за неделю",
  personalSpaces: "Личные пространства ({value1})",
  archived: "в архиве",
  spaceFallback: "пространство",
  totalNotes: "Всего заметок",
  individualSpaces: "Отдельных пространств",
  privacyHint: "Только количество. Личные и небольшие пространства — одной строкой, чтобы не было видно заметок отдельного человека.",
  adoptionHeading: "Как сотрудники осваивают память",
  catalogCount: "В каталоге сотрудников — {value1}",
  step: "Шаг",
  people: "Сотрудников",
  insufficientData: "мало данных",
  usualDays: (days: string): string => `обычно ${days} дн.`,
  firstRead: "От первого входа до первого открытого агентом — {value1}",
  funnelHint: "Шаги считаются по текущему состоянию: отозвал ключ — шаг 2 снова не пройден. Шаги 3–4 — за последние 12 месяцев, с начала подсчёта.",
};

export const RETRY_LATER_TEXT: Messages<typeof en.RETRY_LATER_TEXT> = {
  get limited(): string { return `${productName()} просит подождать — страница обновится сама.`; },
  refreshSoon: "Страница скоро обновится сама.",
  retry: "Повторить",
  retryNow: "Повторить сейчас",
};

export const ROW_MENU_TEXT: Messages<typeof en.ROW_MENU_TEXT> = {
  more: "Ещё действия",
};

export const SECRET_BOX_TEXT: Messages<typeof en.SECRET_BOX_TEXT> = {
  copy: "Скопировать",
  copied: "Скопировано",
  failed: "Не вышло — выделите значение и скопируйте вручную",
};

export const SECTION_SETTINGS_FORM_TEXT: Messages<typeof en.SECTION_SETTINGS_FORM_TEXT> = {
  ldapInsecure: "Без шифрования пароли людей идут по сети открытым текстом. Любой, кто видит трафик между сервером памяти и контроллером, их прочитает. В basic это рабочий режим, если контроллеры не дают LDAPS: этим же каналом идут и пароли сотрудников, которые входят извне. В advanced без шифрования вход извне не работает. Как только контроллеры дадут LDAPS или StartTLS — переключитесь.",
  smtpInsecure: "Без шифрования логин и пароль отправителя и сами письма идут по сети открытым текстом. Любой, кто видит трафик между сервером памяти и почтовым сервером, их прочитает. Для работы выберите STARTTLS или TLS.",
  checkSavedFirst: "Есть несохранённые изменения, а проверка идёт по сохранённым настройкам. Проверить по сохранённым? Чтобы проверить новые — сначала нажмите «Сохранить».",
  ldapPasswordHint: "Пароль служебной учётной записи каталога.",
  clearPassword: "очистить пароль",
  saveLogin: "Сохранить настройки входа",
  dirtyLogin: "В настройках входа есть несохранённые изменения. Уйти и потерять их?",
  oidcSecretHint: "Секрет — в настройках клиента у провайдера единого входа (в Keycloak: вкладка Credentials клиента).",
  clearSecret: "очистить секрет",
  saveSso: "Сохранить настройки единого входа",
  dirtySso: "В настройках единого входа есть несохранённые изменения. Уйти и потерять их?",
  smtpPasswordHint: "Пароль учётной записи отправителя писем.",
  saveMail: "Сохранить настройки почты",
  dirtyMail: "В настройках почты есть несохранённые изменения. Уйти и потерять их?",
  setKeep: "задан, не менять",
  notSet: "не задан",
  workspaceValue: "Для этого рабочего места: {value1}",
  pemFormat: "Формат: блок от {value1} до {value2}",
  example: "Например: {value1}",
  set: "задан",
  missing: "не задано",
  requiredHint: "Без этого поля раздел не включить",
  saving: "Сохранение…",
  invalidFields: "Есть нарушенные правила — они отмечены под полями.",
  checksUseSaved: "Есть несохранённые изменения — проверки ниже идут по сохранённым настройкам.",
  mailSavesFirst: "Есть несохранённые изменения — тестовое письмо ниже сначала сохранит их.",
};

export const SETTINGS_SEARCH_TEXT: Messages<typeof en.SETTINGS_SEARCH_TEXT> = {
  label: "Найти настройку",
  hint: "Например: «корзина», «модель» или имя настройки — по названию и по ключу во всех разделах.",
  empty: "Ничего не нашлось. Попробуйте другое слово или имя настройки.",
};

export const SHELL_TEXT: Messages<typeof en.SHELL_TEXT> = {
  logout: "Выйти",
  skip: "Перейти к содержимому",
  closeMenu: "Закрыть меню",
  openMenu: "Открыть меню",
  navigation: "Навигация",
  sections: "Разделы",
};

export const SPACE_CARD_TEXT: Messages<typeof en.SPACE_CARD_TEXT> = {
  noData: "нет данных",
  archived: "{value1}в архиве",
  newProject: "Новый проект",
  newProjectHint: "Общая память команды проекта",
  recordNoun: (n: number): string => pluralRu(n, ["запись", "записи", "записей"]),
  processingCount: (n: number): string => `${formatCount(n)} ${pluralRu(n, ["обрабатывается", "обрабатываются", "обрабатываются"])}`,
};

export const SPACE_SEARCH_TEXT: Messages<typeof en.SPACE_SEARCH_TEXT> = {
  searchIn: (name: string): string => `Искать в «${name}»`,
};

export const TABLE_WRAP_TEXT: Messages<typeof en.TABLE_WRAP_TEXT> = {
  moreColumns: "ещё столбцы →",
  start: "← к началу",
};

export const TEST_AFTER_SAVE_TEXT: Messages<typeof en.TEST_AFTER_SAVE_TEXT> = {
  saveFailedText: "Настройки не сохранены — исправьте отмеченные поля выше; письмо не отправлено.",
  sending: "Отправка…",
  saving: "Сохранение…",
  hint: "Сначала сохранятся настройки выше, затем уйдёт письмо — уже по новым настройкам.",
};

export const TOASTS_TEXT: Messages<typeof en.TOASTS_TEXT> = {
  failed: "Не получилось — обновите страницу и попробуйте ещё раз",
  close: "Закрыть сообщение",
};

export const UI_TEXT: Messages<typeof en.UI_TEXT> = {
  details: "Подробнее для ИТ",
  responseLost: "Связь с памятью прервалась посреди ответа.",
  directoryUnavailable: "Каталог компании сейчас не отвечает — попробуйте позже.",
  failed: "Память ответила ошибкой.",
  loadFailed: "Не удалось загрузить: {value1}.",
};

export const VIEW_AS_TEXT: Messages<typeof en.VIEW_AS_TEXT> = {
  auditorBarText: "Вы смотрите панель как аудитор: доступны «Аудит», «Отчёт» и «Качество поиска», изменения отключены.",
  returnAdmin: "Вернуться в режим администратора",
};

// This newer feature already used English in the legacy interface; retain its exact wording.
export const GROUP_VALIDITY_TEXT: Messages<typeof en.GROUP_VALIDITY_TEXT> = {
  stale: "Not verified in time: members removed until the directory answers",
  validUntil: "membership valid until {until}",
};

export const PAGER_NOUNS: Messages<typeof en.PAGER_NOUNS> = {
  rows: "строк", records: "записей", meetings: "встреч", colleagues: "сотрудников", clients: "клиентов", consents: "согласий",
  proposals: "предложений", versions: "версий", alerts: "тревог", decisions: "решений", risks: "вопросов и рисков", deadlines: "сроков",
};

export const PAGER_COUNTS: Messages<typeof en.PAGER_COUNTS> = {
  rows: (n: number): string => `Показано строк: ${n}`,
  records: (n: number): string => `Показано записей: ${n}`,
  meetings: (n: number): string => `Показано встреч: ${n}`,
  colleagues: (n: number): string => `Показано сотрудников: ${n}`,
  clients: (n: number): string => `Показано клиентов: ${n}`,
  consents: (n: number): string => `Показано согласий: ${n}`,
  proposals: (n: number): string => `Показано предложений: ${n}`,
  versions: (n: number): string => `Показано версий: ${n}`,
  alerts: (n: number): string => `Показано тревог: ${n}`,
  decisions: (n: number): string => `Показано решений: ${n}`,
  risks: (n: number): string => `Показано вопросов и рисков: ${n}`,
  deadlines: (n: number): string => `Показано сроков: ${n}`,
  custom: (noun: string, n: number): string => `Показано ${noun}: ${n}`,
  local: (label: string, total: number, shown: number, page: number, pages: number): string => `${label}: ${total}${total > shown ? ` · показаны ${shown}` : ""}${pages > 1 ? ` · страница ${page} из ${pages}` : ""}`,
};
