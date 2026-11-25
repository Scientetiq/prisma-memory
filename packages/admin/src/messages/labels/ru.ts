import type { DeactivationPolicy } from "../../lib/labels";
import { pluralRu } from "../../i18n/core";
const DEACTIVATION_EFFECTS_DELETE = "Участия в пространствах снимаются. Все ключи человека отзываются безвозвратно: при повторной активации их нужно выпустить заново. Личное пространство замораживается, а по сроку хранения из настроек (access.dismissed_retention_days, по умолчанию 90 дней) его записи удаляются. То, что человек перенёс в проекты, команды и «Общие знания компании», остаётся там. Файл, который он загрузил и к себе, и в проект или команду, переходит в ту команду или проект, куда его загрузили раньше всего; загруженный к себе и только в «Общие знания компании» — туда, на проверку кураторам, если кураторы его оттуда раньше не убирали (иначе он удаляется вместе с личным). Повторная активация до конца срока снимает заморозку. У тестовых учётных записей (адрес на corp.test или в домене .test) записи удаляются: в пространстве всей компании — сразу, в остальных их пространствах — через час (access.test_leftovers_grace_minutes); включено ли это, решает access.test_leftovers_scope. С пометкой test в карточке (её ставят и проверки) записи в пространстве всей компании удаляются сразу при любом адресе.";
const daysWord = (n: number): string => pluralRu(n, ["день", "дня", "дней"]);
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { ClaimedKind, ClaimedSource, ClientKind, MemoryEffect, PersonalClassReason } from "../../lib/types";
export const CATEGORY_TITLES: Messages<typeof en.CATEGORY_TITLES> = {
    models: "Модели и шлюз",
    retrieval: "Поиск по смыслу",
    storage: "Хранилище",
    integrations: "Интеграции",
    processing: "Обработка",
    limits: "Лимиты",
    search: "Поиск",
    access: "Доступ",
    meetings: "Встречи",
    open_check: "Проверка открытого",
    observability: "Наблюдаемость",
    ldap: "Вход и LDAP",
    oidc: "Единый вход (OpenID Connect)",
    oauth: "Вход агентов (OAuth)",
    agent_auth: "Вход агентов (встроенный)",
    smtp: "Почта (SMTP)",
    onboarding: "Знакомство",
    topics: "Темы",
    approvals: "Подтверждения действий",
    edge: "Внешний доступ",
    admin: "Администраторы",
    security: "Безопасность",
    locale: "Язык",
};

export const CATEGORY_HINTS: Messages<typeof en.CATEGORY_HINTS> = {
    models: "Шлюз платформы, модель обработки, время ожидания и повторы вызова модели.",
    retrieval: "Модель поиска по смыслу и модель уточнения выдачи (реранкер) на шлюзе платформы.",
    storage: "S3-совместимое хранилище оригиналов: отдельные бакеты и учётные данные по классу данных.",
    integrations: "Коннекторы к внешним системам (поиск компаний и сделок, приём данных) и конвертер документов.",
    processing: "Ночное окно, чанкинг, бюджеты модели, повторы заданий, версии промптов.",
    limits: "Лимиты обращений по ключам и размеры загрузок.",
    search: "Словарь тем и поправки ранжирования выдачи.",
    access: "Адреса памяти, доверенные провайдеры, подписанные ссылки, ролевая модель, сервер рабочего места, корзина, проверка «Общих знаний компании», уборка и окончательное удаление тестового. Срок и простой сессии — на странице «Вход и LDAP», адрес рабочего места — на «Почте»: здесь они только для чтения.",
    meetings: "Согласие участников встречи: текст, который отправитель подтверждает галочкой, и его версия. Новая версия действует сразу — прежняя перестаёт приниматься.",
    oauth: "Подключение MCP-агентов через корпоративного провайдера единого входа (OpenID Connect): адрес ресурса, разрешённые программы и срок подключений. Секрет клиента не нужен. Когда включено, у сотрудников «Подключить агента» открывается на входе через учётную запись компании, обзор и «Ключи и агенты» ведут туда же; личный ключ — запасной путь (вкладка «По личному ключу»). Выключение возвращает подключение только по ключу.",
    agent_auth: "Вход агентов без отдельного провайдера единого входа: агент открывает браузер, сотрудник входит в рабочее место и разрешает подключение. Режим external — как раньше (провайдер единого входа компании, раздел «Вход агентов (OAuth)»), builtin — сама память, off — только личные ключи. Здесь же — программы, заведённые заранее, «паспорта» программ (CIMD) и автоматическая регистрация (DCR). Включить builtin можно, когда адрес агентов и адрес рабочего места — HTTPS.",
    observability: "Коллектор OTLP, уровень логов и исходы поиска.",
    onboarding: "Первые шаги сотрудников и команд: описание пространства, обзор, «Можно добавить», загрузка папки, лесенка, прошлые встречи.",
    topics: "Темы пространств и как они назначаются. Пока пусто.",
    approvals: "Карточка «утвердить действие» для агентов. Пока пусто.",
    edge: "Доступ к памяти из интернета: вход сотрудников извне и внешний сервер (ребро), куда выгружается опубликованное.",
    admin: "Вход администраторов, их ключи и сессии, вторая подпись, аварийный доступ и оповещения.",
    locale: "Язык, на котором агенты видят инструменты памяти: названия и описания инструментов, инструкции подключения, ресурсы и промпты MCP. Имена инструментов и их схемы — одни и те же; агенты получают новые тексты в течение 5 минут или после перезапуска сессии.",
};

export const CHECK_TITLES: Messages<typeof en.CHECK_TITLES> = {
    origin_allowlist: "список разрешённых Origin",
    t1_gate: "гейт T1 (провайдеры уровня T1)",
    settings: "обязательные настройки",
    db_open: "база открытого класса",
    db_closed: "база закрытого класса",
    audit_append_only: "журнал аудита (только дозапись)",
    embedder: "эмбеддер",
    embedder_model: "модель поиска по смыслу",
    fts_index: "язык поиска по словам",
    embedding_index: "переподготовка поиска по смыслу",
    platform: "шлюз платформы",
    models: "модели: подключения и допуск записей",
    storage: "объектное хранилище",
    storage_isolation: "разделение хранилища по классам",
    original_storage: "сохранение оригиналов файлов",
    database: "база данных",
    schema: "схема базы данных",
    ldap: "вход через каталог (LDAP)",
    oidc: "единый вход (OpenID Connect)",
    oauth: "вход агентов через учётную запись (OAuth)",
    smtp: "почта (SMTP)",
    llm: "модель: пауза, занятость, ожидание",
    converter: "конвертер документов: подключение и очередь",
    edge_export: "экспорт на ребро (внешний доступ)",
    test_hooks: "тестовые хуки приёмки",
    open_check: "проверка записи в открытый класс",
    class_consistency: "сверка классов данных между базами",
    group_sync: "сверка групп каталога (участие в пространствах)",
    external_channel: "внешний адрес и адреса для агентов",
    external_login: "вход извне: служба проверки и пауза",
    disk_guard: "место на диске: приём файлов",
    audit_outbox: "очередь журнала аудита",
    alert_channel: "письма-тревоги при входе извне",
    tls_links: "звенья без TLS (шифрование связей)",
    secrets_source: "ключи служб: откуда взяты",
    local_admin_factor: "второй фактор локального администратора",
    deploy_profile: "профиль развёртывания",
    proxy_trust: "прокси без доверия: адреса клиентов потеряны",
};

export const EFFECT_TITLES: Messages<typeof en.EFFECT_TITLES> = {
    base: "Базовый доступ",
    space_owner: "Владелец пространства области",
    space_reader: "Чтение пространств области",
    admin: "Администрирование без чтения содержимого",
    audit: "Чтение журнала аудита",
    none: "Без эффекта в памяти",
};

export const EFFECT_HINTS: Messages<typeof en.EFFECT_HINTS> = {
    base: "Активный сотрудник: своё, общие знания компании, свои команды, пространство своего подразделения.",
    space_owner: "Руководитель — владелец пространства своего подразделения; куратор — владелец общих знаний компании по назначению.",
    space_reader: "Чтение пространств области без записи; выдаётся только явным назначением.",
    admin: "Люди, сервисы, ключи, пространства, настройки — содержимое записей недоступно.",
    audit: "Журнал аудита: факты обращений без содержимого записей.",
    none: "Роли портала компании, сервисов и систем-источников. Хранятся для полноты картины; доступ к данным памяти НЕ расширяют.",
};

export const ORIGIN_TITLES: Messages<typeof en.ORIGIN_TITLES> = { memory: "память", hub: "портал", service: "сервис", source_system: "система-источник" };

export const SCOPE_TITLES: Messages<typeof en.SCOPE_TITLES> = {
    own: "своё",
    org_unit: "подразделение",
    org_branch: "ветка подразделений",
    company: "компания",
    space: "пространство",
    objects: "объекты",
    catalog: "каталог",
};

export const SCOPE_REF_HINTS: Messages<typeof en.SCOPE_REF_HINTS> = {
    org_unit: "код орг-единицы",
    org_branch: "код корневой орг-единицы ветки",
    space: "slug пространства",
    objects: "идентификаторы объектов",
};

export const BASIS_TITLES: Messages<typeof en.BASIS_TITLES> = {
    request: "заявка",
    manual: "решение вручную",
    org_table: "орг-таблица",
    directory: "каталог (LDAP)",
    bitrix: "CRM-коннектор",
    sap: "SAP",
};

export const PROVENANCE_TITLES: Messages<typeof en.PROVENANCE_TITLES> = {
    installation_code: "код установки",
    self_service: "самообслуживание",
};

export const SERVICE_KIND_TITLES: Messages<typeof en.SERVICE_KIND_TITLES> = {
    transcriber: "транскрибатор",
    chat: "чат",
    meeting_assistant: "ассистент встреч",
    converter: "конвертер",
    audio_agent: "аудио-агент",
    pipeline: "пайплайн",
    other: "другое",
};

export const CLIENT_KIND_TITLES: Messages<typeof en.CLIENT_KIND_TITLES> = {
    claude_code: "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    cloud_other: "Другой облачный агент",
    script: "Скрипт или локальная программа",
};

export const LABELS_TEXT: Messages<typeof en.LABELS_TEXT> = {
    clientKindNone: "не указана (облачный)",
    clientKindHint: "Облачный агент (Claude Code, Codex, Cursor и другие) пишет заметки и документы в ваше личное открытыми, пока записи агентов в личном открытые (раздел «Записи агентов в личном» на этой странице), — их находят ваши агенты, коллеги их не видят; запись с находкой проверки открытого (телефон, пароль, NDA…) сохраняется закрытой, встречи там всегда закрытые. Скрипт или локальная программа загружает мимо модели: всё, что он пишет в личное, закрытое, выключатель на него не действует; показать запись агентам можно здесь, в рабочем месте.",
    searchSliceOther: "остальные",
    unknown: "не удалось определить",
    conversionTextPartial: "часть страниц — сканы: их текст прочитан автоматически без проверки или не прочитан — сверяйтесь с оригиналом",
    conversionOpenPartial: "часть страниц — сканы, их не удалось проверить: в общее пространство такой файл не принимается — загрузите его в закрытое пространство команды",
    conversionOpenPartialKept: "часть страниц — сканы, их не проверить, поэтому сам файл не выдаётся; распознанный текст — на этой странице",
    conversionTextNotFound: "текста в файле не нашлось — по словам из документа запись не найти; похоже, это скан или фото страниц: загрузите PDF, в котором текст можно выделить и скопировать",
    failedWhy: (why: string): string => `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
    conversionLine: (head: string, why: string): string => why ? `${head}: ${why}` : head,
    originalPartial: "Сам файл не выдаётся: часть страниц — сканы, их не проверить. Распознанный текст — на этой странице.",
    originalUnavailable: "Сам файл не выдаётся: текст в нём не распознан, а страницы-сканы не проверить.",
    agentFileLine: (reasons: readonly string[]): string => `Текст доступен агентам. Сам файл — только людям: ${reasons.length ? reasons.join("; ") : "в нём есть то, что не попало в текст и не проверялось"}.`,
    queueLine: (lane: string | null | undefined, hint: string, minutes: number | null): string => `${lane ? `Очередь: ${lane}` : "Очередь обработки"}. ${lane ? hint : "Стадии обновляются сами."}${minutes !== null ? ` Ожидание около ${minutes} мин.` : ""}`.trim(),
    graceTitle: (minutes: number): string => {
      const form = (n: number, forms: readonly [string, string, string]) => `${n} ${pluralRu(n < 0 ? 5 : n, forms)}`;
      if (minutes === 60) return "час";
      if (minutes > 0 && minutes % 1440 === 0) return form(minutes / 1440, ["день", "дня", "дней"]);
      if (minutes > 0 && minutes % 60 === 0) return form(minutes / 60, ["час", "часа", "часов"]);
      return form(minutes, ["минута", "минуты", "минут"]);
    },
    deactivationEffects: (p: DeactivationPolicy): string => {
  if (p.personal === "delete") return DEACTIVATION_EFFECTS_DELETE;
  const meetings = p.meetings === "wait"
    ? "Встречи сотрудника остаются у него, как и раньше: участники их видят, но организатора у них нет."
    : `${p.after_days > 0 ? `Через ${p.after_days} ${daysWord(p.after_days)}` : "Сразу после увольнения"} (access.dismissed_custody_after_days) встречи сотрудника, где были другие участники, переходят хранителю: он становится организатором, участники видят встречи как раньше.`;
  return "Участия в пространствах снимаются. Все ключи человека отзываются безвозвратно: при повторной активации их нужно выпустить заново. "
    + "Личное пространство сотрудника замораживается и хранится бессрочно: ничего из него не удаляется, корзина тоже. "
    + "Хранителем становится руководитель сотрудника по орг-таблице; если его нет — руководитель подразделения; если нет и его — тот, кого вы назначите в карточке. "
    + "Хранитель сможет читать личное сотрудника сам, в рабочем месте; его агенты эти записи не видят. "
    + `${meetings} Повторная активация снимает заморозку и возвращает сотруднику его встречи. `
    + "У тестовых учётных записей (адрес на corp.test или в домене .test) записи удаляются: в пространстве всей компании — сразу, в остальных их пространствах — через час (access.test_leftovers_grace_minutes); включено ли это, решает access.test_leftovers_scope. "
    + "Их личное пространство удаляется по сроку из настроек (access.dismissed_retention_days, по умолчанию 90 дней). "
    + "С пометкой test в карточке (её ставят и проверки) записи в пространстве всей компании удаляются сразу при любом адресе.";
},

};

export const CLAIMED_KIND_TITLES: Messages<typeof en.CLAIMED_KIND_TITLES> = {
    script: "Скрипт",
    transport: "HTTP-библиотека (не распознано)",
    internal: "Проверки и рабочее место памяти",
};

export const CLAIMED_SOURCE_TITLES: Messages<typeof en.CLAIMED_SOURCE_TITLES> = {
    meta: "clientInfo в каждом запросе",
    initialize: "clientInfo при подключении (initialize)",
    user_agent: "заголовок User-Agent",
};

export const CLIENT_MISMATCH_TITLES: Messages<typeof en.CLIENT_MISMATCH_TITLES> = { warn: "расхождение", info: "к сведению" };

export const CLIENT_KIND_PANEL_HINTS: Messages<typeof en.CLIENT_KIND_PANEL_HINTS> = {
    personal: "client_kind: куда человек вставит ключ. Облачный агент пишет заметки и документы в личное человека открытыми, пока человек не сделал записи агентов закрытыми («Ключи и агенты» → «Записи агентов в личном»); запись с находкой проверки открытого — закрытой. «Скрипт или локальная программа» — закрытыми: скрипт загружает мимо модели. Встречи в личном закрытые при любой программе. Человек видит программу в «Ключах и агентах».",
    extended: "client_kind: куда человек вставит ключ. Расширенный ключ сам читает закрытое, поэтому его записи в личном закрытые при любой программе: здесь программа — пометка для человека и журнала, на класс записей она не влияет. Человек видит программу в «Ключах и агентах».",
};

export const PERSONAL_CLASS_REASON_TITLES: Messages<typeof en.PERSONAL_CLASS_REASON_TITLES> = {
    notebook: "записи агентов в личном открытые",
    notebook_off: "записи агентов в личном человек сделал закрытыми",
    script: "ключ скрипта или локальной программы",
    reads_closed: "ключ сам читает закрытое",
    service: "сервисный ключ",
};

export const KEY_KIND_TITLES: Messages<typeof en.KEY_KIND_TITLES> = {
    personal: "личный",
    service: "сервисный",
    extended: "расширенный",
    system: "системный",
    session: "сессия рабочего места",
};

export const SESSION_SOURCE_TITLES: Messages<typeof en.SESSION_SOURCE_TITLES> = { ldap: "учётная запись AD", oidc: "единый вход", test: "тестовый вход приёмки" };

export const SPACE_KIND_TITLES: Messages<typeof en.SPACE_KIND_TITLES> = { personal: "личное", team: "командное", org: "общие знания компании", project: "проект" };

export const CREATED_VIA_TITLES: Messages<typeof en.CREATED_VIA_TITLES> = { workplace: "рабочее место", mcp: "агент (MCP)", admin: "панель", org_table: "орг-таблица", unknown: "не записано" };

export const GROUP_STATUS_TITLES: Messages<typeof en.GROUP_STATUS_TITLES> = {
    pending: "ещё не сверялась", ok: "сверена", missing: "нет в каталоге — состав не меняется", too_large: "больше предела — состав заморожен", error: "сбой каталога",
};

export const CLASS_TITLES: Messages<typeof en.CLASS_TITLES> = { open: "открытый", closed: "закрытый" };

export const AUDIT_EVENT_TITLES: Messages<typeof en.AUDIT_EVENT_TITLES> = {
    read: "чтение",
    search: "поиск",
    list: "список",
    write: "запись",
    promote: "перенос между пространствами",
    open: "показ агентам",
    forget: "удаление и корзина",
    extended_key_use: "расширенный ключ",
    t1_fallback: "уход на T1",
    confirmation: "подтверждение",
    admin: "администрирование",
    processing: "обработка",
    auth_failure: "отказ во входе",
    rate_limited: "превышен лимит",
    class_move: "смена доступа (открыто/закрыто)",
    purge: "очистка",
    directory: "поиск по каталогу",
    external: "доступ извне",
};

export const RECORD_TYPE_TITLES: Messages<typeof en.RECORD_TYPE_TITLES> = { document: "документ", transcript: "встреча", event: "решение или задача", summary: "резюме встречи", profile: "карточка", note: "заметка" };

export const SPACE_ROLE_TITLES: Messages<typeof en.SPACE_ROLE_TITLES> = { owner: "владелец", member: "участник", reader: "только читает" };

export const SPACE_ROLE_YOU: Messages<typeof en.SPACE_ROLE_YOU> = { owner: "вы владелец", member: "вы участник", reader: "вы только читаете" };

export const SPACE_ROLE_HINTS: Messages<typeof en.SPACE_ROLE_HINTS> = {
    owner: "читает всё в пространстве, пишет, продвигает свои записи, удаляет записи пространства, управляет ручными участниками",
    member: "читает всё в пространстве и пишет в него; свои записи может продвигать и удалять",
    reader: "только читает записи пространства",
};

export const VIA_TITLES: Messages<typeof en.VIA_TITLES> = { personal: "личное пространство", org_unit: "орг-таблица: подразделение", grant: "назначение роли", manual: "добавлен вручную", org: "все сотрудники компании", group: "группа AD" };

export const EVENT_KIND_TITLES: Messages<typeof en.EVENT_KIND_TITLES> = { decision: "решение", action: "задача", question_risk: "риск или вопрос", fact: "факт", note: "заметка" };

export const ORIGIN_RECORD_TITLES: Messages<typeof en.ORIGIN_RECORD_TITLES> = { document: "из документа", human: "сказано человеком", model: "составлено автоматически", agent: "запись агента" };

export const SOURCE_KIND_TITLES: Messages<typeof en.SOURCE_KIND_TITLES> = {
    upload: "загрузка файла", agent: "через MCP — агент или рабочее место", ingest: "приём от системы-источника",
    transcript: "транскрипт встречи", email: "почта", promote: "продвинуто из другого пространства",
    correction: "исправление со слов человека",
};

export const SEARCH_MODE_TITLES: Messages<typeof en.SEARCH_MODE_TITLES> = { hybrid: "обычный", keyword: "точные слова", semantic: "по смыслу", recent: "новое" };

export const SEARCH_MODE_HINTS: Messages<typeof en.SEARCH_MODE_HINTS> = { hybrid: "вопрос своими словами: ищет и по словам, и по смыслу", keyword: "коды, аббревиатуры, точные названия", semantic: "похожее по смыслу, даже если слова другие", recent: "что нового по фильтрам, без запроса" };

export const CONVERSION_STATUS_TITLES: Messages<typeof en.CONVERSION_STATUS_TITLES> = { pending: "идёт конвертация", done: "конвертация завершена", failed: "конвертация не удалась" };

export const CONVERSION_ERROR_TITLES: Messages<typeof en.CONVERSION_ERROR_TITLES> = {
    converter_too_large: "файл больше предела конвертера документов",
    converter_unsupported: "конвертер не принимает этот формат",
    converter_auth: "конвертер не принял учётные данные — вопрос к администратору",
    converter_timeout: "конвертер не ответил вовремя",
    converter_rejected: "конвертер отказался разбирать файл",
    converter_no_text: "в файле не нашлось текста — похоже, это скан или фото страниц; загрузите PDF, в котором текст можно выделить и скопировать",
    converter_run_gone: "прогон конвертера потерян — нужна повторная загрузка",
    converter_http: "не получилось: конвертер ответил ошибкой — администратор может повторить",
    converter_network: "конвертер не отвечал — администратор может повторить",
    converter_fail_retryable: "конвертер не справился — можно нажать «Обработать сейчас»",
    converter_cancelled: "обработку остановили на стороне конвертера — можно нажать «Обработать сейчас»",
    converter_stuck: "конвертер так и не взял документ в работу — можно нажать «Обработать сейчас»",
    converter_deadline: "конвертер не уложился в срок — можно нажать «Обработать сейчас»",
    converter_result_missing: "конвертер не отдал готовый результат — администратор разберётся",
    converter_copies_limit: "конвертер несколько раз терял загрузку — администратор может повторить",
    converter_doc_error: "конвертер не отдаёт результат этого документа — администратор разберётся",
    converter_encrypted: "файл защищён паролем — снимите пароль и загрузите снова",
    converter_malformed: "файл повреждён — пересохраните его и загрузите снова",
    converter_gave_up: "конвертер не справился с документом",
    converter_unexpected: "не получилось — администратор разберётся",
    converter_patience: "конвертер долго не отвечал — администратор может повторить",
    converter_assurance_conflict: "конвертер не выдал текст этого прогона — администратор разберётся",
    original_changed: "файл в хранилище изменился — загрузите его снова",
    original_missing: "оригинал не сохранён — загрузите снова",
    open_check: "текст документа не прошёл проверку для общего пространства — загрузите документ в закрытое пространство команды",
    open_check_fallback_failed: "перенос в закрытое после находки не удался несколько раз — документ скрыт, файл никому не выдаётся (в команде или проекте оригинал сохранён); «Повторить» у переноса («Переносы класса») перенесёт документ в закрытое — конвертация продолжится там сама",
    version_refused: "the new version was not added to the document",
};

export const AGENT_FILE_WHY_TEXT: Messages<typeof en.AGENT_FILE_WHY_TEXT> = {
    images: "в нём есть картинки, которые не проверялись",
    pictures_skipped: "в нём есть картинки, которые не проверялись",
    pdf_hidden_parts: "в нём есть комментарии, вложения или поля форм, которые не попали в текст",
    office: "в файле может быть то, что не попало в текст: картинки, примечания, скрытые слайды",
    table_truncated: "таблица в тексте обрезана",
    active_content: "в нём есть макросы или другое содержимое, которое не проверялось",
    other_format: "файлы такого формата агентам не выдаются",
};

export const QUEUE_LANE_TITLES: Messages<typeof en.QUEUE_LANE_TITLES> = { now: "сейчас", day: "дневная полоса", night: "ночная полоса" };

export const QUEUE_LANE_HINTS: Messages<typeof en.QUEUE_LANE_HINTS> = {
    now: "обрабатывается в первую очередь — обычно минуты.",
    day: "обрабатывается в течение дня.",
    night: "обработка идёт ночью: записи появятся в поиске к утру. Нужно раньше — «обработать сейчас» поднимает приоритет.",
};

export const MY_AUDIT_TITLES: Messages<typeof en.MY_AUDIT_TITLES> = { admin: "управление" };

export const KEY_STATUS_TITLES: Messages<typeof en.KEY_STATUS_TITLES> = { current: "этот сеанс", active: "действует", revoked: "отозван", expired: "истёк" } as const;

export const SOURCE_TITLES: Messages<typeof en.SOURCE_TITLES> = { org_table: "орг-таблица", directory: "каталог", manual: "вручную", grant: "назначение", org: "орг-структура", group: "группа AD" };

export const RELATION_TITLES: Messages<typeof en.RELATION_TITLES> = { head: "руководитель", deputy: "заместитель", member: "сотрудник" };

export const SPACE_STATUS_TITLES: Messages<typeof en.SPACE_STATUS_TITLES> = { active: "действующие", archived: "в архиве", all: "все" } as const;

export const PEOPLE_STATUS_TITLES: Messages<typeof en.PEOPLE_STATUS_TITLES> = { true: "активные", false: "деактивированные (архив)", all: "все" } as const;

export const LEFTOVERS_SCOPE_TITLES: Messages<typeof en.LEFTOVERS_SCOPE_TITLES> = { off: "выключено", org: "только пространство всей компании", all: "все их пространства" };

export const LEFTOVERS_SKIPPED_TITLES: Messages<typeof en.LEFTOVERS_SKIPPED_TITLES> = {
    read_by_staff: "запись читают сотрудники",
    placed_by_staff: "документ добавил сотрудник",
    staff_participants: "среди участников встречи есть сотрудник",
    pending_participants: "встреча ждёт входа участников",
    unresolved_participants: "участники встречи не найдены в каталоге",
    foreign_owner: "к записи привязаны материалы другого человека",
};

export const LEFTOVERS_KEPT_TITLES: Messages<typeof en.LEFTOVERS_KEPT_TITLES> = {
    staff_records: "есть записи сотрудников",
    staff_members: "есть участники-сотрудники",
    skipped_records: "остались записи, которые удалять нельзя",
    service_space: "сюда пишет сервис",
    unit_active: "подразделение действует",
};

export const TEST_PURGE_MODE_TITLES: Messages<typeof en.TEST_PURGE_MODE_TITLES> = { off: "выключено", auto: "автоматически, раз в час" };

export const TEST_PURGE_STOP_TITLES: Messages<typeof en.TEST_PURGE_STOP_TITLES> = {
    S1: "в плане оказалось то, что не удаляется никогда",
    S2: "записи не прошли проверку правил",
    S3: "превышен потолок на один запуск",
    S4: "по записям ещё идёт работа",
    S5: "нет проверенной резервной копии",
    S6: "независимая проверка плана не сошлась",
    S7: "план устарел или повреждён",
    S8: "число сотрудников или действующих пространств не совпало с ожидаемым",
    S9: "журнал не принял запись",
    S10: "выключено — режим или уборка тестовых остатков",
    S11: "очистка записей не продвигается",
    S12: "список встреч не совпал с одобренным",
    S13: "база отвергла то, что план считал удаляемым",
    S14: "затронуто нетестовое",
    S15: "одобренная встреча похожа на настоящую",
    S16: "во время окна обслуживания работают другие подключения",
    S17: "нужно одобрение подразделений",
    S18: "очистка записей занята дольше 5 минут",
};

export const TEST_PURGE_BACKLOG_TITLES: Messages<typeof en.TEST_PURGE_BACKLOG_TITLES> = {
    people: "учётные записи", spaces: "пространства", keys: "ключи", sessions: "сессии", org_units: "подразделения", services: "службы", entities: "сущности",
};

export const LEFTOVERS_KIND_TITLES: Messages<typeof en.LEFTOVERS_KIND_TITLES> = { org: "вся компания", personal: "личные", team: "командные", project: "проекты", dep: "подразделения" };

export const OBO_DENIAL_TITLES: Messages<typeof en.OBO_DENIAL_TITLES> = {
    obo_not_allowed: "сервису не разрешено действовать от имени людей",
    obo_unknown_person: "человек неизвестен или неактивен",
    obo_demo_person: "демо-персона витрины ролей",
    obo_key_paused: "ключ поставлен на паузу",
};

export const OPEN_CHECK_KIND_TITLES: Messages<typeof en.OPEN_CHECK_KIND_TITLES> = { secret: "секреты", pii: "персональные данные", money: "суммы", contract: "договоры", nda: "NDA", custom: "своё", unchecked: "не проверено", never_open: "«никогда не открывать»" };

export const MOVE_VIA_TITLES: Messages<typeof en.MOVE_VIA_TITLES> = {
    person: "человек или администратор", open_check_fallback: "память: находка проверки открытого (личное или файл в команде или проекте)",
    agent_relayed: "агент по слову человека", human_workplace: "человек: сделать доступным агентам",
    despite_rollback: "администратор: откат показа в командах и проектах",
    resume_refused: "память: возврат в закрытое — показ не прошёл повторную проверку",
    nda_recheck: "память: перепроверка по списку NDA",
};

export const MOVE_CONFIRMATION_TITLES: Messages<typeof en.MOVE_CONFIRMATION_TITLES> = { agent_relayed: "словом человека через агента", human_workplace: "человеком в рабочем месте" };

export const OPEN_CHECK_VIA_TITLES: Messages<typeof en.OPEN_CHECK_VIA_TITLES> = {
    remember: "запомнить", upload: "загрузка", promote: "перенос", open: "показать агентам", convert: "PDF после конвертера", move: "перенос класса", derive: "сгенерировано моделью",
    space: "название пространства",
    open_word: "открыть по слову человека",
    link: "связь записей",
    correct: "исправление",
    handover: "передача решения встречи в проект",
    nda_recheck: "перепроверка по списку NDA",
};

export const OPEN_CHECK_FIELD_TITLES: Messages<typeof en.OPEN_CHECK_FIELD_TITLES> = {
    text: "текст", title: "название", filename: "имя файла", source: "источник", summary: "краткое содержание", entities: "сущности", original: "оригинал", derived: "производная запись",
    participants: "участники встречи",
    name: "название пространства", description: "описание пространства", readme: "«Подробнее о пространстве»", slug: "идентификатор пространства",
    quote: "цитата", rationale: "обоснование",
};

export const OPEN_CHECK_UNCHECKED_TITLES: Messages<typeof en.OPEN_CHECK_UNCHECKED_TITLES> = {
    timeout: "не уложилась", conversion_pending: "ещё конвертируется", conversion_failed: "конвертация не удалась", empty_text: "нет текста",
    partial_text: "часть страниц — сканы",
    original_unavailable: "оригинал не прочитан", original_too_large: "оригинал слишком большой", check_failed: "проверка не выполнилась",
    busy: "сервер проверки занят",
    tree_too_large: "слишком длинная история правок",
};

export const OPEN_REFUSED_TITLES: Messages<typeof en.OPEN_REFUSED_TITLES> = {
    changed: "не показано агентам: запись изменилась после вашего согласия — откройте её и посмотрите снова",
    audience: "не показано агентам: изменилось, кто видит запись — откройте её и посмотрите снова",
    no_write: "не показано агентам: у вас больше нет права менять записи в этом пространстве",
    disabled: "не показано агентам: администратор выключил показ",
    found: "не показано агентам: проверка нашла в записи новое — откройте её и посмотрите снова",
    never_open: "не показано агентам: такие записи администратор запретил показывать агентам",
    unchecked: "не показано агентам: память не успела проверить запись — попробуйте показать её снова через несколько минут",
    consent_needed: "не показано агентам: согласие давали до обновления памяти — откройте запись и подтвердите показ заново",
};

export const AUDIT_ACTION_TITLES: Messages<typeof en.AUDIT_ACTION_TITLES> = {
    plan: "составлен план массового действия",
    plan_apply: "применён план",
    plan_cancel: "план отменён",
    plan_view: "просмотрен план",
    // space export in the workplace: the download started and ended — the archive itself is not kept
    export: "space export started",
    export_done: "space export ended",
    correct: "исправлено в памяти",
    correct_proposed: "предложено исправление",
    correct_confirm: "подтверждено исправление",
    correct_reject: "отклонено исправление",
    correct_withdraw: "отозвано исправление",
    link_confirm: "подтверждено: заменено или исправлено",
    corrections_view: "просмотрены исправления",
    suppressed_by_correction: "событие не возвращено повторным извлечением: его исправил человек",
    move_space: "перенесено между пространствами",
    return: "возвращено в личное",
    delete: "в корзину",
    restore: "восстановлено из корзины",
    trash_purge: "удалено навсегда из корзины",
    purge_now: "удалено навсегда",
    close: "скрыто от агентов",
    close_failed: "не скрыто: сбой — запись снова находят агенты, нажмите «Скрыть от агентов» ещё раз",
    open: "показано агентам",
    key_issue_self: "выпущен свой ключ",
    key_revoke_self: "отозван свой ключ",
    key_client_kind_set: "свой ключ помечен как ключ скрипта",
    session_end: "завершена сессия рабочего места",
    sessions_end_all: "завершены все сессии рабочего места",
    login: "вход в рабочее место",
    person_created: "карточка создана при первом входе",
    person_login_changed: "логин сменился (почта в каталоге)",
    oidc_check: "проверка провайдера единого входа",
    smtp_test: "тестовое письмо",
    operator_linked: "связь администратора с человеком",
    mail_retry: "повтор письма",
    mail_cancel: "отмена письма",
    hidden_locator: "локатор закрытой записи",
    section_candidates: "агенту показаны названия разделов записи: таких разделов несколько, текст не выдавался",
    placement: "размещение",
    open_check_refused: "не принято проверкой открытого",
    open_check_fallback: "сохранено закрытым проверкой открытого",
    open_check_fallback_failed: "перенос в закрытое после проверки открытого не удался",
    open_relayed: "показано агентам по вашему слову через агента",
    open_despite: "показано вами агентам, несмотря на находку",
    open_refused: "не показано агентам: запись изменилась, изменился круг читателей, показ выключен или проверка нашла новое — откройте запись и посмотрите снова",
    open_failed: "не показано агентам: сбой переноса — попросите показать снова",
    open_done: "показано агентам по вашему слову: память проверила ещё раз и перенесла в открытое",
    open_word_denied: "агент просил показать запись агентам — это можете только вы в рабочем месте",
    close_rollback: "скрыто от агентов администратором: показ вопреки находке в командах и проектах отменён",
    convert_refused: "файл не обработан заново: он показан агентам только текстом — сначала скройте запись",
    space_archive: "пространство отправлено в архив",
    space_unarchive: "пространство возвращено из архива",
    extended_open_denied: "агенту с расширенным доступом не дали создать открытую запись",
    derived_refused: "агент не записал пересказ: его увидели бы те, кто не видит источник",
    handover: "решение встречи передано в проект",
    handover_form: "открыта форма «Передать в проект»",
    meeting_participant_left: "убрал(а) себя из участников встречи",
    obo_consent_grant: "вы разрешили сервису искать и читать память от вашего имени",
    obo_consent_revoke: "разрешение сервису читать от вашего имени закрыто",
    obo_read_no_consent: "сервис обратился от вашего имени без разрешения — читать ему не дали",
    key_open_write_on: "администратор разрешил ключу открытые записи",
    key_open_write_off: "ключу запрещены открытые записи",
    key_issue: "администратор выпустил ключ",
    key_update: "администратор изменил ключ",
    org_useful: "отмечено «Полезно» в «Общих знаниях компании»",
    org_unuseful: "снята отметка «Полезно»",
    org_wrong: "отмечено «Неверно / не для всех» — агенты не находят запись до решения куратора",
    org_unwrong: "снята отметка «Неверно / не для всех»",
    org_confirm: "подтверждено куратором «Общих знаний компании»",
    org_return: "возвращено из «Общих знаний компании»",
    org_return_auto: "вернулось из «Общих знаний компании» само: куратор не подтвердил за срок",
    org_delete: "удалено куратором «Общих знаний компании» (через возврат, в корзину)",
    org_digest: "письмо кураторам «Общих знаний компании»",
    org_review_now: "задание проверки «Общих знаний компании» запущено",
    org_review_expire: "срок проверки записи сдвинут (тестовый хук)",
    my_meetings: "показан список «Встречи со мной»",
    trash: "показана корзина",
    deletion_requests: "показаны просьбы удалить",
    participants: "показан состав встречи",
    status_derived: "показано, что извлечено из записи",
    derivation_sources: "показаны источники пересказа",
    deletion_requested: "участник попросил удалить встречу",
    deletion_declined: "владелец оставил встречу",
    deletion_kept: "администратор оставил встречу",
    deletion_request_keep: "администратор оставил встречу по просьбе удалить",
    deletion_request_delete: "администратор удалил встречу по просьбе",
    organizer_transfer: "встреча передана вам: прежний организатор больше не работает",
    organizer_return: "встреча возвращена прежнему организатору",
    organizer_return_reactivated: "встреча возвращена прежнему организатору: он вернулся в компанию",
    organizer_return_wait: "встреча возвращена прежнему организатору: так настроил администратор",
    close_organizer_transfer: "скрыта от агентов: встреча перешла к новому организатору",
    organizer_return_trashed: "встреча из корзины возвращена прежнему организатору: в его корзину с новым сроком",
    close_nda_recheck: "скрыто от агентов: найдено название заказчика из списка NDA (список пополнили)",
    open_nda_recheck: "снова доступно агентам: перепроверка ничего не нашла",
    open_recheck_held: "скрыто от агентов перепроверкой: найдено название заказчика из списка NDA",
    open_recheck_on_restore: "запись в корзине: если её восстановить, она вернётся скрытой от агентов",
    close_nda_recheck_rules: "скрыто от агентов: перепроверка нашла то, что в открытый класс не пишется",
    close_nda_recheck_unchecked: "скрыто от агентов: перепроверка не смогла проверить запись трижды",
    open_recheck_held_rules: "скрыто от агентов перепроверкой: найдено то, что в открытый класс не пишется",
    open_recheck_held_unchecked: "скрыто от агентов: перепроверка не смогла проверить запись трижды",
    open_recheck_on_restore_rules: "запись в корзине: перепроверка нашла в ней то, что в открытый класс не пишется, — восстановится скрытой от агентов",
    open_recheck_on_restore_unchecked: "запись в корзине: перепроверка не смогла её проверить — восстановится скрытой от агентов",
    open_recheck_kept: "оставлено скрытым от агентов",
    open_recheck_start: "запущена перепроверка открытого по списку NDA",
    open_recheck_done: "перепроверка открытого по списку NDA закончена",
    custody_assign: "назначен хранитель личного уволенного",
    custody_change: "сменился хранитель личного уволенного",
    custody_end: "хранение личного закончено",
    custody_set: "администратор назначил хранителя",
    custody_manager_detached: "руководитель уволенного не учитывается: его почту получил другой сотрудник",
    custody_read: "прочитана запись ушедшего сотрудника",
    custody_read_closed: "прочитана запись ушедшего сотрудника: закрытая",
    custody: "показан список записей ушедшего сотрудника",
    custody_copy: "запись ушедшего сотрудника скопирована себе",
    profile: "изменён рабочий профиль",
    profile_refused: "рабочий профиль не сохранён: в тексте нашлись сведения о частной жизни",
    profile_view: "открыт рабочий профиль, скрытый от агентов",
    profile_public: "изменено, что коллеги видят в профиле",
    profile_public_off: "снят профиль из «Общих знаний компании»",
    space_guide: "изменена карта «Как мы работаем»",
    space_guide_view: "открыта карта «Как мы работаем»",
    optin_enabled: "включён доступ извне",
    optin_disabled: "выключен доступ извне",
    revoke_all: "отключены все подключения извне",
    optin_confirm_requested: "отправлена заявка в поддержку на первое включение доступа извне"
};

export const ROLE_TITLES: Messages<typeof en.ROLE_TITLES> = {
    employee: "Сотрудник", unit_head: "Руководитель подразделения", unit_deputy: "Заместитель руководителя", company_management: "Руководство компании",
    branch_reader: "Чтение ветки подразделений", memory_admin: "Администратор памяти", security_auditor: "Аудитор ИБ", org_curator: "Куратор общих знаний компании",
    domain_owner: "Владелец домена", champion: "Чемпион", effect_owner: "Ответственный за эффект", pm_kam: "РП / КАМ", legal_specialist: "Юрист / профильный специалист",
    tender_decision: "ЛПР тендера", office_booking_user: "Пользователь офисного бронирования", travel_assistant: "Получатель командировочного помощника",
    contract_digest: "Бизнес-получатель «Выжимки договоров»",
};

export const KEY_OPEN_WRITE_TITLES: Messages<typeof en.KEY_OPEN_WRITE_TITLES> = {
    allowed: "как обычно",
    denied: "открытые записи не создаёт",
    marked: "открытые записи — с пометкой",
};

export const EXTENDED_ATTEMPT_TITLES: Messages<typeof en.EXTENDED_ATTEMPT_TITLES> = {
    remember: "запомнить", upload: "загрузка", placement: "размещение файла", promote: "перенос", correct: "исправление", link: "связь «заменено»", space_meta: "описание пространства",
};

export const ENTITY_ROLE_TITLES: Messages<typeof en.ENTITY_ROLE_TITLES> = {
    mentioned: "упоминание", participant: "участник", customer: "заказчик", deal: "сделка", owner: "владелец", author: "автор", space: "пространство проекта",
};

export const SEARCH_SLICE_TITLES: Messages<typeof en.SEARCH_SLICE_TITLES> = {
    channel: { agent: "ИИ-агенты", workplace: "люди в рабочем месте" },
    key_kind: { personal: "личный ключ агента", extended: "расширенный доступ", connection: "вход через учётную запись компании", obo: "сервис от имени сотрудника",
        service: "сервис", session: "рабочее место", unknown: "не удалось определить" },
    closed_seen: { open: "только открытое", closed: "было и закрытое" },
};

export const SEARCH_SLICE_DIMS: Messages<typeof en.SEARCH_SLICE_DIMS> = [{title: "Кто искал"},
    {title: "Как искали"},
    {title: "Чем подключались"},
    {title: "Программа"},
    {title: "Что было в выдаче"}];

export const ROLLOUT_STEP_TITLES: Messages<typeof en.ROLLOUT_STEP_TITLES> = {
    1: "Заходили в рабочее место", 2: "Подключили ИИ-агента", 3: "Агент что-то нашёл в памяти", 4: "Агент открыл найденное",
    5: "Есть своя заметка", 6: "Есть встреча в памяти", 7: "Участвуют в пространстве проекта",
};
