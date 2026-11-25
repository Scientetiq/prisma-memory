// Descriptions of the processing.* settings (the processing pipeline), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-processing", {
  night_window: {
    en: "Night window of heavy background processing: weekdays and weekends as HH:MM-HH:MM by the day the window starts; an optional tz (an IANA name), otherwise the installation's time zone (locale.timezone)",
    ru: "Ночное окно обработки",
  },
  chunk: {
    en: "How text is cut into chunks for search: target, maximum and minimum chunk size in tokens, and the largest overlap between neighbours",
    ru: "Нарезка текста на фрагменты для поиска: целевой, наибольший и наименьший размер фрагмента в токенах",
  },
  budgets: {
    en: "How much text goes to the model in one call and in parts: a long meeting is processed part by part",
    ru: "Сколько текста уходит модели за один вызов и частями: длинная встреча обрабатывается по частям",
  },
  events: {
    en: "Extraction of events from meetings: decisions, tasks, deadlines. suppress_corrected (true by default): a meeting event a person corrected (memory_correct extraction_error) is not brought back by a repeated extraction — the model finds it again, but it is saved hidden, and search and the meeting page keep the corrected version; the count is in the report, line “Not restored: corrected by a person”. false — the corrected event and the new model event are both current. A field missing from the stored value means true",
    ru: "Извлечение событий из встреч: решения, задачи, сроки. suppress_corrected (по умолчанию true): событие встречи, которое человек исправил (memory_correct extraction_error), повторное извлечение не возвращает — модель снова находит его, но оно сохраняется скрытым, а в поиске и на странице встречи остаётся исправленная версия; счётчик — в отчёте, строка «Не возвращено: исправил человек». false — исправленное и новое модельное событие будут текущими оба. Поле, которого в сохранённом значении нет, значит true",
  },
  concurrency: {
    en: "How many model requests run at once by day and by night. Fixed at one request at a time: other values are not saved",
    ru: "Сколько запросов к модели идёт одновременно днём и ночью. Модель одна на всю компанию: не больше одного запроса одновременно, другие значения не сохраняются",
  },
  llm_gate: {
    en: "Protection of the model from excess requests. busy_backoff_sec — how long to wait when the model answered “busy” (10 seconds to an hour): the pause doubles with every new “busy” up to busy_backoff_cap_sec, a successful answer resets it. slow_streak_open — after how many “did not answer in time” in a row to pause as well. after_abort_hold_sec — how long not to call the model after an aborted request: it may still be computing it. shutdown_grace_sec — how long a running request gets when processing stops before it is interrupted (the stage continues after the start). waiting_alert_hours — after how many hours of waiting for the model the panel shows a warning",
    ru: "Защита модели от лишних запросов. busy_backoff_sec — сколько ждать, если модель ответила «занята» (10 секунд — час): пауза удваивается с каждым новым «занята» до потолка busy_backoff_cap_sec, успешный ответ её сбрасывает. slow_streak_open — после скольких ответов «не успела вовремя» подряд тоже сделать паузу. after_abort_hold_sec — сколько не звать модель после оборванного запроса: она может ещё досчитывать его. shutdown_grace_sec — сколько при остановке обработки даётся идущему запросу, прежде чем его прервать (стадия продолжится после запуска). waiting_alert_hours — через сколько часов ожидания модели показывать предупреждение в панели",
  },
  llm_retry: {
    en: "Retry of a stage when the model did not answer in time: the first pause is base_sec (5 seconds to an hour), then it doubles up to cap_sec. now_patience_min — how many minutes a “process now” meeting waits for a busy model by day before it moves to night processing; 0 — straight to the night. poison_after — after how many “not in time” in a row, while the model answers other records, a record counts as too long: by day it moves to the night, by night it waits for the administrator (“Retry”). Answers that fail the schema are retried by processing.retries",
    ru: "Повтор стадии, когда модель не успела ответить вовремя: первая пауза base_sec (5 секунд — час), дальше удваивается до cap_sec. now_patience_min — сколько минут встреча «обработать сейчас» ждёт занятую модель днём, прежде чем уйти в ночную обработку; 0 — сразу в ночь. poison_after — после скольких «не успела» подряд, пока модель отвечает другим записям, запись считается слишком долгой: днём уходит в ночь, ночью ждёт администратора («Повторить»). Ошибки ответа (не по схеме) повторяются по processing.retries",
  },
  retries: {
    en: "Retries of processing jobs: how many times and with what pause; per_call_sec — the time for one model call, from which the deadline of a long meeting processed in parts is computed",
    ru: "Повторы заданий обработки: сколько раз и с какой паузой; per_call_sec — время на один вызов модели: из него срок задания длинной встречи частями",
  },
  daytime_token_cap: {
    en: "Daytime limit of model work on meetings — tokens per day, from midnight in the time zone of the night window. A meeting that would exceed the limit waits for night processing; the “Process now” button is not limited. The limit is approximate: meetings already accepted and still in processing are not counted, so the model may do more in a day. 0 — off",
    ru: "Дневной предел работы модели над встречами — в токенах за сутки, с полуночи по поясу ночного окна. Встреча, которая вышла бы за предел, ждёт ночной обработки; кнопку «Обработать сейчас» предел не ограничивает. Предел приблизительный: встречи, которые уже приняты и ещё обрабатываются, в нём не учитываются, поэтому за день модель может сделать больше. 0 — выключен",
  },
  nighttime_token_cap: {
    en: "How many tokens the model spends in one night on all background work: recomputation for a new prompt version, past meetings and other night jobs. When the limit is reached, night processing stops until the next night; “now” meetings and the “Process now” button are not limited. About 107 thousand tokens is one two-hour meeting. An integer from 10,000 to 200,000,000; never empty",
    ru: "Сколько токенов модель тратит за одну ночь на всё фоновое: пересчёт под новую версию, прошлые встречи и другие ночные работы. Когда предел достигнут, ночная обработка останавливается до следующей ночи; встречи «сейчас» и кнопка «Обработать сейчас» не ограничиваются. Около 107 тысяч токенов — одна двухчасовая встреча. Целое от 10 000 до 200 000 000; пустым не бывает",
  },
  entity_linking: {
    en: "Linking of records to companies, deals and projects: external_lookup — look names up in the connectors that offer an entity lookup (boolean or null); max_lookups_per_record — lookups per record at most (integer from 0 to 100); other keys are refused. Changes to external_lookup take effect within a minute; a request already sent may finish. This switch governs pipeline lookups; connection tests send only the fixed synthetic query \"connection test\"",
    ru: "Связывание записей с компаниями, сделками и проектами: external_lookup — искать названия в коннекторах, которые умеют искать сущности (булево значение или null); max_lookups_per_record — не больше стольких поисков на запись (целое число от 0 до 100); другие поля не сохраняются. Изменение external_lookup действует в течение минуты; уже отправленный запрос может завершиться. Этот выключатель управляет поиском конвейера; проверка подключения отправляет только постоянный синтетический запрос «connection test»",
  },
  prompts: {
    en: "Prompt versions of the processing stages: a new version makes records be recomputed at night",
    ru: "Версии промптов стадий обработки: новая версия — пересчёт записей по ночам",
  },
  backfill_per_night: {
    en: "Records per night when recomputing for a new version",
    ru: "Записей за ночь при пересчёте под новую версию",
  },
  profiles_sync_at: {
    en: "Time of the daily build of people and department cards. Reserved: this version does not read it",
    ru: "Время ежедневной сборки карточек людей и подразделений",
  },
  report_at: {
    en: "Time of the morning report to the administrator. Reserved: this version does not read it",
    ru: "Время утреннего отчёта администратору",
  },
  class_move_fault: {
    en: "For testing only: an ordered failure of a class move — {\"pause_sec\": N} (a pause between copying and deleting the source rows), {\"fail\": \"verify\"} (the row count check fails), {\"fail\": \"storage\"} (moving the original file fails), {\"keep\": true} (a failed move leaves its rows — to test the reconciler), {\"pause_before_check_sec\": N} (a pause after copying, before the open check of a move to the open class: the test changes settings meanwhile). While not empty, health is degraded",
    ru: "Только для проверок: сбой переноса класса по заказу — {\"pause_sec\": N} (пауза между копированием и удалением строк источника), {\"fail\": \"verify\"} (сбой проверки числа строк), {\"fail\": \"storage\"} (сбой переноса файла оригинала), {\"keep\": true} (упавший перенос не убирает свои строки — для проверки сверщика), {\"pause_before_check_sec\": N} (пауза после копирования перед проверкой открытого у переноса в открытое: за это время проверка меняет настройки). Пока не пусто, health — degraded",
  },
  links_test_hook: {
    en: "For testing only: creating and reading links of test people of the same instance; white-box link-copies without the graph. While on, health is degraded",
    ru: "Только для проверок: создание и чтение связей тестовых людей своего инстанса; белый ящик link-copies без графа. Пока включено, health — degraded",
  },
  llm_fault: {
    en: "For testing without a model only: {\"title_contains\": \"…\" (8–200 characters, required), \"busy\": true — always fail, \"busy_times\": N — fail the first N times, \"kind\": busy | unavailable | network | timeout | http_500 | http_401 | unknown_model, \"hold_ms\": hold the model for up to 60000 ms, \"fake_ok\": true — a canned answer}. Applies only to records with this substring in the title. Canned answers and holding are allowed only on a test installation. While not empty, health is degraded",
    ru: "Только для проверок без модели: {\"title_contains\": \"…\" (8–200 знаков, обязательно), \"busy\": true — всегда сбой, \"busy_times\": N — сбой первые N раз, \"kind\": busy | unavailable | network | timeout | http_500 | http_401 | unknown_model, \"hold_ms\": удерживать модель до 60000 мс, \"fake_ok\": true — ответ-заготовка}. Срабатывает только у записей с этой подстрокой в названии. Заготовки и удержание разрешены только на тестовом стенде. Пока не пусто, health — degraded",
  },
  open_check_fault: {
    en: "For testing only: {\"busy\": true, \"title_contains\": \"…\"} — the open check of records and documents with this substring in the title (or file name) answers “the check server is busy” before the rules run — both in the gateway and in the worker after conversion. While not empty, health is degraded",
    ru: "Только для проверок: {\"busy\": true, \"title_contains\": \"…\"} — проверка открытого у записей и документов с этой подстрокой в названии (или имени файла) отвечает «сервер проверки занят» до запуска правил — и в шлюзе, и у воркера после конвертации. Пока не пусто, health — degraded",
  },
  conversion_fault: {
    en: "For testing on a test installation only: an ordered conversion failure — {\"point\": after_session | after_complete | before_submitted_patch | after_fetch | before_final | poll, \"action\": crash (the worker stops) | unavailable (the converter is unavailable) | http500 (a converter error) | abort (the request is aborted), \"times\": how many times in total (1–50, 1 by default), \"title_contains\": a substring of the title or file name (empty — any document)}. While not empty, health is degraded",
    ru: "Только для проверок на тестовом стенде: сбой конвертации по заказу — {\"point\": after_session | after_complete | before_submitted_patch | after_fetch | before_final | poll, \"action\": crash (воркер останавливается) | unavailable (конвертер недоступен) | http500 (ошибка конвертера) | abort (запрос прерван), \"times\": сколько раз всего (1–50, по умолчанию 1), \"title_contains\": подстрока названия или имени файла (пусто — любой документ)}. Пока не пусто, health — degraded",
  },
  disk_guard_fault: {
    en: "For testing on a test installation only: fake the free space on the paths of the disk-space stop — {\"free_percent\": N} (0–100, N % free) or {\"unreadable\": true} (the path cannot be read); \"path\" — only this path of the list, without it — all. Works only when the path list is set. An empty object — off; without test hooks a non-empty value is not saved. While not empty, health is degraded",
    ru: "Только для проверок на тестовом стенде: подменить свободное место на путях стопа по месту — {\"free_percent\": N} (0–100, свободно N %) или {\"unreadable\": true} (путь не читается); \"path\" — только этот путь из списка, без него — все. Действует, только когда список путей задан. Пустой объект — выключено; без тестовых хуков непустое значение не сохраняется. Пока не пусто, health — degraded",
  },
  scheduler_interval_sec: {
    en: "How often, in seconds, the scheduler starts processing stages (every 5 minutes by default); the stage chain of one record runs without waiting",
    ru: "Как часто, в секундах, планировщик запускает стадии обработки (по умолчанию раз в 5 минут); цепочка стадий одной записи идёт без ожидания",
  },
  reclaim_running_on_start: {
    en: "Return running stages to pending when a worker starts (they were orphaned by the restart); switch off when several worker instances run",
    ru: "Возвращать стадии running в pending при старте воркера (осиротели при перезапуске); выключить при нескольких экземплярах воркеров",
  },
  converter_holds: {
    en: "Pause of document conversion: \"new\" — new documents wait, those already sent to the converter are finished; \"all\" — everything stands still. Empty — no pause. While paused, processing attempts are not spent",
    ru: "Пауза конвертации документов: \"new\" — новые документы ждут, уже отправленные конвертеру доводятся до конца; \"all\" — стоит всё. Пусто — без паузы. На паузе попытки обработки не тратятся",
  },
});
