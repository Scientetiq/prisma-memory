// Descriptions of the limits.* settings (request, upload and size limits), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-limits", {
  personal_per_minute: {
    en: "Per-minute limits of a personal key by bucket: MCP tool names and REST buckets (me_audit, me_keys, ingest, status, original, directory — directory search, per workspace session or service key; deletion_requests — the list of requests to delete meetings, asked by every workspace page). Service loads of the workspace have their own buckets, 120 by default: session_me — the profile by session (does not touch the agents' memory_me), me_keys_view — lists of keys and connections by session (issuing and revoking — me_keys), nav — the menu summary; open_preview — “Make available to agents”: what the check found and who will see the record (30 by default), show_anyway — whether that action is enabled, for the record page (120 by default); a service key gets × limits.service_key_multiplier. Each bucket is an integer from 1 to 100,000: 0 would silently forbid everything, so it is not saved",
    ru: "Лимиты личного ключа в минуту по бакетам: имена инструментов MCP и бакеты REST (me_audit, me_keys, ingest, status, original, directory — поиск по каталогу, на сессию рабочего места или ключ сервиса; deletion_requests — список просьб удалить встречи, его запрашивает каждая страница рабочего места). Служебные загрузки рабочего места — в своих бакетах, по умолчанию 120: session_me — профиль сессией (memory_me агентов не трогает), me_keys_view — списки ключей и подключений сессией (выпуск и отзыв — me_keys), nav — сводка меню; open_preview — «Сделать доступным агентам»: что нашла проверка и кто увидит (по умолчанию 30), show_anyway — включён ли этот показ, для страницы записи (по умолчанию 120); сервисному ключу — × limits.service_key_multiplier. Каждая корзина — целое от 1 до 100 000: 0 запрещал бы всё молча, поэтому не сохраняется",
  },
  process_now_per_hour: {
    en: "How many times per hour one person may ask to process a meeting now (memory_process_now), 1–1000",
    ru: "На человека",
  },
  directory_cache_sec: {
    en: "Directory search (GET /api/v1/directory/search): for how many seconds the directory's answer is reused for the same query, 0–3600; 0 — no cache",
    ru: "Поиск по каталогу (GET /api/v1/directory/search): сколько секунд ответ каталога переиспользуется для того же запроса, 0–3600; 0 — без кэша",
  },
  personal_keys_max: {
    en: "How many active personal keys a person may issue for themselves (the workspace, POST /api/v1/me/keys)",
    ru: "Сколько действующих личных ключей человек может выпустить себе сам (интерфейс, POST /api/v1/me/keys)",
  },
  projects_per_person: {
    en: "How many spaces a person may create themselves: projects in the workspace and team spaces through an agent (memory_space_create), archived ones excluded. Spaces the person created are counted, not those they own: handing over ownership does not use up the limit. An administrator creates without a limit",
    ru: "Сколько пространств человек может создать сам: проекты в рабочем месте и командные через агента (memory_space_create), кроме архивных. Считаются созданные им, а не те, которыми он владеет: передача владения предел не занимает. Администратор создаёт без предела",
  },
  service_key_multiplier: {
    en: "How many times higher the per-minute limits of limits.personal_per_minute are for a service key",
    ru: "Во сколько раз пределы в минуту из limits.personal_per_minute выше для ключа сервиса",
  },
  upload_max_bytes: {
    en: "Largest size of one uploaded file, bytes: from 1 MiB (1048576) to 20 MiB (20971520). The upload schema refuses a file above 20 MiB anyway",
    ru: "Наибольший размер одного загружаемого файла, байт: от 1 МиБ (1048576) до 20 МиБ (20971520). Больше 20 МиБ файл всё равно не примет схема загрузки",
  },
  upload_daily: {
    en: "How many new files (documents and meeting transcripts) and mebibytes one person may upload per day — with all their keys, agents and the workspace together: files (1–1,000,000), mib (1–10,485,760). The day follows the time zone of the night window. Repeating an already uploaded file or the same meeting text uses up nothing; transcripts the meeting service sends on a person's behalf are not counted. Above the limit an upload is refused in plain words (“you can continue tomorrow, or ask the administrator to raise the limit”); reading and searching work as usual",
    ru: "Сколько новых файлов (документов и стенограмм встреч) и мегабайт (МиБ) один человек может загрузить за сутки — всеми своими ключами, агентами и рабочим местом вместе: files — файлов (1–1 000 000), mib — МиБ (1–10 485 760). Сутки — по поясу ночного окна. Повтор уже загруженного файла или того же текста встречи объём не тратит; стенограммы, которые сервис встреч присылает от имени человека, не считаются. Сверх предела загрузка получает отказ простыми словами «продолжить можно завтра или попросите администратора поднять предел»; читать и искать можно как обычно",
  },
  remember_max_tokens: {
    en: "Longest text of one note (memory_remember and other text writes), tokens; a longer text is refused with the advice to upload it as a document",
    ru: "Наибольшая длина текста одной заметки (memory_remember и другие записи текста), токенов; длиннее — отказ с советом загрузить документом",
  },
  read_default_tokens: {
    en: "How much of a record one memory_read returns when the agent does not set max_tokens, in estimated tokens (a whole number from 1 000 to 64 000, at most limits.read_max_tokens). The estimate counts by script: about 0.35 token per Latin letter, 0.45 per Cyrillic letter, 1.1 per Chinese or Japanese character, so a part of a Russian record is shorter in characters than an English one. A longer record continues with next_range",
    ru: "Какую часть записи возвращает один memory_read, когда агент не задаёт max_tokens, в оценочных токенах (целое число от 1 000 до 64 000, не больше limits.read_max_tokens). Оценка зависит от письменности: около 0,35 токена на латинскую букву, 0,45 — на кириллическую, 1,1 — на китайский или японский знак, поэтому часть русской записи короче в знаках, чем английской. Длинная запись продолжается через next_range",
  },
  read_max_tokens: {
    en: "Most tokens of a record one read may return, whatever max_tokens the request names",
    ru: "Сколько токенов записи самое большее возвращает одно чтение, какой бы max_tokens ни назвал запрос",
  },
  preauth: {
    en: "Per-minute request limits before the key is checked — before the database and the audit log; the counters live in the gateway's memory (a restart resets them). per_address_per_minute — from one client address (the address after X-Forwarded-For from a trusted proxy), 60–100,000; proxy_per_minute — when the client address turned out to be the trusted proxy itself (it added no X-Forwarded-For, so everything through it shares one address), 600–1,000,000; global_per_minute — all requests together, separately on each channel (internal, agent hosts, external — traffic to the external address does not eat the limit of internal services), 1,000–10,000,000; auth_failures_per_minute — failed key checks from one address, 5–10,000: above it, requests with an unknown or wrong key from this address get 429 until the end of the minute (a key that passed the check from this address in the last 15 minutes is let through), and the audit log gets one event instead of one per failure. An IPv6 address is counted by its /64 network. The server of the panel and the workspace (the networks the system key is accepted from, and the workspace server) is not counted. Trade-off: while the proxy adds X-Forwarded-For, the limit applies to each client; without it everything through the proxy shares proxy_per_minute (about 100 requests per second), and one noisy client may take it from the others for a minute; failures from the proxy's own address lock nobody out, they only stop reaching the audit log. 0 in a field switches that limit off",
    ru: "Пределы запросов в минуту до проверки ключа — до базы и до журнала, счётчики в памяти шлюза (перезапуск их обнуляет). per_address_per_minute — с одного адреса клиента (адрес — после X-Forwarded-For от доверенного прокси), 60–100 000; proxy_per_minute — когда адресом клиента оказался сам доверенный прокси (он не дописал X-Forwarded-For, и весь поток через него делит один адрес), 600–1 000 000; global_per_minute — все запросы вместе, отдельно на каждом канале (внутренний, адрес для агентов, внешний — поток на внешний адрес не отнимает предел у внутренних сервисов), 1 000–10 000 000; auth_failures_per_minute — неудачных проверок ключа с одного адреса, 5–10 000: сверх него запросы с неизвестным или неверным ключом с этого адреса получают 429 до конца минуты (ключ, прошедший проверку с этого адреса за последние 15 минут, пускается), а журнал пишет одно событие вместо каждой неудачи. Адрес IPv6 считается по его сети /64. Сервер панели и рабочего места (откуда принимается системный ключ и сервер рабочего места) не считается. Компромисс: пока прокси дописывает X-Forwarded-For, предел действует на каждого клиента; без него весь поток через прокси делит proxy_per_minute (около 100 запросов в секунду), и один шумный клиент может на минуту занять его у остальных; неудачи с адреса самого прокси никого не запирают, только перестают попадать в журнал. 0 у поля — предел выключен",
  },
  plan_max_items: {
    en: "Largest number of records in a bulk change plan (1–2000); above it, narrow the criterion. Derived records are counted separately, as consequences",
    ru: "Наибольшее число записей в плане массового действия (1–2000); больше — сузьте критерий. Производные учитываются отдельно как последствия",
  },
});
