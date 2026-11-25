// Descriptions of the observability.* settings (logs, search outcomes and audit shipping), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-observability", {
  otlp_endpoint: {
    en: "Address of an OTLP collector. Reserved: this version does not read it and exports nothing over OTLP",
    ru: "Коллектор OTLP; пусто — метрики только в логах",
  },
  log_level: {
    en: "Log level of the gateway and the workers (debug, info, warn, error); read at process start",
    ru: "Уровень журнала шлюза и воркеров (debug, info, warn, error); читается при старте процесса",
  },
  outcomes: {
    en: "Search outcomes from the audit log — without record texts and without per-person numbers. Every 15 minutes the memory links each search with what was opened and written after it. read_window_min — for how many minutes after a search a read or a note by the same key counts as “from these results” (1–60); reformulate_window_sec — a new query within these seconds without reads counts as a rephrasing (10–600); session_gap_min — the pause after which a new session starts (5–240); min_group — numbers and texts are shown only when at least this many different people stand behind them (2–50). Changes apply to new searches. enabled = false — new outcomes are not computed, earlier ones stay",
    ru: "Исходы поиска из журнала — без текстов записей и без чисел по людям. Раз в 15 минут память связывает каждый поиск с тем, что после него открыли и записали. read_window_min — сколько минут после поиска чтение и заметка того же ключа считаются «по этой выдаче» (1–60); reformulate_window_sec — новый вопрос за эти секунды без чтений считается переспросом (10–600); session_gap_min — пауза, после которой начинается новая сессия (5–240); min_group — числа и тексты показываются, только если за ними не меньше стольких разных людей (2–50). Изменения действуют на новые поиски. enabled = false — новые исходы не считаются, прежние остаются",
  },
  audit_ship_mode: {
    en: "Shipping of the audit log to an external receiver: off — not shipped; file — JSONL files (test installations); syslog_tls — syslog over TLS (RFC 5425). Only service fields of events leave, without the texts of records and queries",
    ru: "Отправка журнала во внешний приёмник: off — не отправляется; file — файлы JSONL (стенд); syslog_tls — syslog по TLS (RFC 5425). Уходят только служебные поля событий, без текстов записей и запросов",
  },
  audit_ship_target: {
    en: "Where to ship the audit log: {\"file_dir\": \"…\"} for file, or {\"host\", \"port\", \"ca_cert\", \"tls_server_name\"} for syslog_tls",
    ru: "Куда отправлять журнал: {\"file_dir\": \"…\"} для file или {\"host\", \"port\", \"ca_cert\", \"tls_server_name\"} для syslog_tls",
  },
  audit_ship_batch: {
    en: "How many audit events are shipped at once (50–5000)",
    ru: "Сколько событий журнала отправлять за раз (50–5000)",
  },
  audit_ship_interval_sec: {
    en: "How often the audit log is shipped, seconds (5–300)",
    ru: "Как часто отправлять журнал, секунд (5–300)",
  },
  audit_ship_lag_sec: {
    en: "Reading delay of the audit log, seconds (30–900): younger events are not shipped, so that late transactions have time to commit",
    ru: "Задержка чтения журнала, секунд (30–900): события моложе не отправляются, чтобы поздние транзакции успели записаться",
  },
});
