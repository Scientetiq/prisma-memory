// Russian labels and option titles; missing overlay text falls back to the English table.
import type { SettingLabelText } from "../../lib/setting-labels";

export const SETTING_LABELS_RU: Readonly<Record<string, SettingLabelText>> = {
  "models.gateway_base_url": {
    "label": "Адрес шлюза моделей"
  },
  "models.gateway_api_key": {
    "label": "Ключ памяти на шлюзе моделей"
  },
  "models.llm_model": {
    "label": "Модель для обработки записей"
  },
  "models.wire_fragment": {
    "label": "Параметры запроса к модели"
  },
  "models.timeout_sec": {
    "label": "Сколько ждать ответа модели, секунд"
  },
  "models.repair_retries": {
    "label": "Повторов, если ответ модели не по форме"
  },
  "models.schema_unsupported_keywords": {
    "label": "Что убрать из схемы ответа для модели"
  },
  "models.t0_aliases": {
    "label": "Модели внутри компании (больше не читается: допуск — в models.allow_closed и models.allow_open)"
  },
  "models.embeddings_provider": {
    "label": "Модель эмбеддингов, подключение 1: API",
    "options": {
      "": "не выбрано",
      "openai-compatible": "совместимый с OpenAI",
      "voyage": "Voyage",
      "cohere": "Cohere",
      "gemini": "Gemini",
      "none": "выключено"
    }
  },
  "models.embeddings_base_url": {
    "label": "Модель эмбеддингов, подключение 1: адрес"
  },
  "models.embeddings_api_key": {
    "label": "Модель эмбеддингов, подключение 1: ключ"
  },
  "models.embeddings_model": {
    "label": "Модель эмбеддингов, подключение 1: название модели"
  },
  "models.embeddings_params": {
    "label": "Модель эмбеддингов, подключение 1: переопределения профиля"
  },
  "models.embeddings_b_provider": {
    "label": "Модель эмбеддингов, подключение 2: API",
    "options": {
      "": "не выбрано",
      "openai-compatible": "совместимый с OpenAI",
      "voyage": "Voyage",
      "cohere": "Cohere",
      "gemini": "Gemini",
      "none": "выключено"
    }
  },
  "models.embeddings_b_base_url": {
    "label": "Модель эмбеддингов, подключение 2: адрес"
  },
  "models.embeddings_b_api_key": {
    "label": "Модель эмбеддингов, подключение 2: ключ"
  },
  "models.embeddings_b_model": {
    "label": "Модель эмбеддингов, подключение 2: название модели"
  },
  "models.embeddings_b_params": {
    "label": "Модель эмбеддингов, подключение 2: переопределения профиля"
  },
  "retrieval.embeddings_model": {
    "label": "Модель поиска по смыслу"
  },
  "retrieval.rerank_model": {
    "label": "Модель уточнения выдачи (реранкер)"
  },
  "retrieval.batch": {
    "label": "Фрагментов в одном запросе к модели поиска"
  },
  "retrieval.max_tokens": {
    "label": "Наибольшая длина фрагмента для модели поиска, токенов"
  },
  "retrieval.rerank_top": {
    "label": "Сколько кандидатов уточнять реранкером"
  },
  "retrieval.retry_429_sec": {
    "label": "Пауза, если модель поиска занята, секунд"
  },
  "retrieval.tuning": {
    "label": "Настройка поиска: число кандидатов, веса объединения и параметры векторного индекса"
  },
  "storage.s3_endpoint": {
    "label": "Адрес хранилища файлов"
  },
  "storage.s3_endpoint_closed": {
    "label": "Адрес хранилища для закрытых файлов"
  },
  "storage.s3_region": {
    "label": "Регион хранилища"
  },
  "storage.bucket_open": {
    "label": "Бакет открытых файлов"
  },
  "storage.bucket_closed": {
    "label": "Бакет закрытых файлов"
  },
  "storage.access_key_open": {
    "label": "Ключ доступа к бакету открытых файлов"
  },
  "storage.secret_key_open": {
    "label": "Секрет доступа к бакету открытых файлов"
  },
  "storage.access_key_closed": {
    "label": "Ключ доступа к бакету закрытых файлов"
  },
  "storage.secret_key_closed": {
    "label": "Секрет доступа к бакету закрытых файлов"
  },
  "storage.inbox_prefix": {
    "label": "Папка входящих документов в хранилище"
  },
  "storage.backup_retention_days": {
    "label": "Сколько дней хранить резервные копии на сервере"
  },
  "integrations.converter_url": {
    "label": "Адрес конвертера документов"
  },
  "integrations.converter_login": {
    "label": "Логин конвертера"
  },
  "integrations.converter_password": {
    "label": "Пароль конвертера"
  },
  "integrations.converter_profile": {
    "label": "Режим конвертера",
    "options": {
      "fast-extraction": "быстрый"
    }
  },
  "integrations.converter_classification": {
    "label": "Метка документа для конвертера"
  },
  "integrations.converter_timeout_sec": {
    "label": "Сколько ждать обработку документа, секунд"
  },
  "integrations.converter_poll_sec": {
    "label": "Как часто спрашивать конвертер, секунд"
  },
  "integrations.converter_request_timeout_sec": {
    "label": "Сколько ждать один ответ конвертера, секунд"
  },
  "integrations.converter_result_max_bytes": {
    "label": "Наибольший ответ конвертера с текстом, байт"
  },
  "integrations.converter_text_max_bytes": {
    "label": "Наибольший текст документа из конвертера, байт"
  },
  "integrations.converter_max_reruns": {
    "label": "Сколько раз конвертер обрабатывает документ заново после сбоя"
  },
  "integrations.converter_window": {
    "label": "Сколько документов одновременно у конвертера"
  },
  "integrations.converter_run_deadline_hours": {
    "label": "Сколько часов ждать одну обработку документа"
  },
  "integrations.converter_accepted_suspect_min": {
    "label": "Через сколько минут неначатый документ считается застрявшим"
  },
  "integrations.converter_accepted_rerun_min": {
    "label": "Через сколько минут застрявший документ отправлять заново"
  },
  "integrations.converter_ocr_rerun_delay_min": {
    "label": "Через сколько минут повторить нераспознанные страницы"
  },
  "integrations.converter_doc_error_max": {
    "label": "Сколько раз ждать документ, который конвертер не отдаёт"
  },
  "integrations.converter_patience_hours": {
    "label": "Сколько часов ждать недоступный конвертер (0 — без предела)"
  },
  "integrations.converter_dedup": {
    "label": "Повторная отправка того же файла в конвертер",
    "options": {
      "document": "искать уже отправленный файл с тем же содержимым",
      "off": "отправлять каждый раз заново"
    }
  },
  "integrations.converter_formats": {
    "label": "Какие документы принимать на перевод в текст"
  },
  "integrations.converter_office_test_hook": {
    "label": "Офисные документы тестовых людей — только для проверок"
  },
  "processing.night_window": {
    "label": "Ночное окно обработки"
  },
  "processing.chunk": {
    "label": "Нарезка текста на фрагменты"
  },
  "processing.budgets": {
    "label": "Объём текста для модели"
  },
  "processing.events": {
    "label": "Извлечение событий из встреч"
  },
  "processing.concurrency": {
    "label": "Запросов к модели одновременно"
  },
  "processing.llm_gate": {
    "label": "Защита модели от лишних запросов"
  },
  "processing.llm_retry": {
    "label": "Повтор, если модель не успела"
  },
  "processing.retries": {
    "label": "Повторы заданий"
  },
  "processing.daytime_token_cap": {
    "label": "Дневной предел обработки, токенов"
  },
  "processing.documents_lane": {
    "label": "Когда обрабатывать загруженные документы",
    "options": {
      "now": "сразу после загрузки",
      "night": "в ночном окне"
    }
  },
  "processing.nighttime_token_cap": {
    "label": "Ночной предел работы модели, токенов за ночь"
  },
  "processing.entity_linking": {
    "label": "Связывание с компаниями и сделками"
  },
  "processing.prompts": {
    "label": "Версии промптов"
  },
  "processing.backfill_per_night": {
    "label": "Записей за ночь при пересчёте"
  },
  "processing.profiles_sync_at": {
    "label": "Время сборки карточек людей"
  },
  "processing.report_at": {
    "label": "Время утреннего отчёта"
  },
  "processing.class_move_fault": {
    "label": "Сбой переноса — только для проверок"
  },
  "processing.links_test_hook": {
    "label": "Связи тестовых людей — только для проверок"
  },
  "processing.llm_fault": {
    "label": "Сбой модели — только для проверок"
  },
  "processing.open_check_fault": {
    "label": "Сбой проверки открытого — только для проверок"
  },
  "processing.conversion_fault": {
    "label": "Сбой конвертации — только для проверок"
  },
  "processing.disk_guard_fault": {
    "label": "Нехватка места на диске — только для проверок"
  },
  "processing.scheduler_interval_sec": {
    "label": "Как часто запускать обработку, секунд"
  },
  "processing.reclaim_running_on_start": {
    "label": "Подхватывать прерванную обработку при запуске"
  },
  "processing.converter_holds": {
    "label": "Пауза конвертации документов",
    "options": {
      "": "без паузы",
      "new": "новые документы ждут",
      "all": "стоит всё"
    }
  },
  "oauth.enabled": {
    "label": "Вход агентов через учётную запись компании"
  },
  "oauth.issuer": {
    "label": "Адрес провайдера единого входа для агентов (издатель)"
  },
  "oauth.resource_url": {
    "label": "Адрес памяти для агентов (ресурс)"
  },
  "oauth.ca_cert": {
    "label": "Корневой сертификат провайдера единого входа (PEM)"
  },
  "oauth.allowed_clients": {
    "label": "Разрешённые программы"
  },
  "oauth.scope": {
    "label": "Обязательная область доступа"
  },
  "oauth.timeout_sec": {
    "label": "Сколько ждать провайдера единого входа, секунд"
  },
  "oauth.connection_days": {
    "label": "Срок подключения агента, дней"
  },
  "agent_auth.mode": {
    "label": "Кто впускает агентов через браузер",
    "options": {
      "external": "Провайдер единого входа компании (раздел «Вход агентов (OAuth)»)",
      "builtin": "сама память: вход сотрудника в рабочем месте",
      "off": "никто: только личные ключи"
    }
  },
  "agent_auth.clients": {
    "label": "Программы, заведённые заранее (Client ID и адреса возврата)"
  },
  "agent_auth.cimd_hosts": {
    "label": "Откуда брать «паспорт» программы (хост и начало пути)"
  },
  "agent_auth.cimd_any_https": {
    "label": "Принимать «паспорт» программы с любого HTTPS-адреса"
  },
  "agent_auth.dcr_enabled": {
    "label": "Регистрация программ автоматически (DCR)"
  },
  "agent_auth.dcr_limits": {
    "label": "Пределы автоматической регистрации (per_day_trusted — доля суток для сетей выхода облачных программ)"
  },
  "agent_auth.dcr_trusted_egress": {
    "label": "Сети выхода облачных программ (CIDR): вместо предела «с одной сети» — общая доля суток per_day_trusted"
  },
  "agent_auth.connection_days": {
    "label": "Срок подключения агента через встроенный вход, дней"
  },
  "agent_auth.idle_days": {
    "label": "Через сколько дней простоя подключение гаснет"
  },
  "limits.personal_per_minute": {
    "label": "Обращений в минуту на личный ключ"
  },
  "limits.process_now_per_hour": {
    "label": "«Обработать сейчас» в час на человека"
  },
  "limits.directory_cache_sec": {
    "label": "Сколько помнить ответ каталога, секунд"
  },
  "limits.personal_keys_max": {
    "label": "Личных ключей на человека"
  },
  "limits.projects_per_person": {
    "label": "Пространств, которые человек создаёт сам"
  },
  "limits.service_key_multiplier": {
    "label": "Во сколько раз больше лимит у сервиса"
  },
  "limits.upload_max_bytes": {
    "label": "Наибольший размер загрузки, байт"
  },
  "limits.upload_daily": {
    "label": "Загрузок в сутки на человека: файлов и МиБ"
  },
  "limits.remember_max_tokens": {
    "label": "Наибольшая длина записи от агента, токенов"
  },
  "limits.read_default_tokens": {
    "label": "Сколько текста отдавать агенту за раз, токенов"
  },
  "limits.read_max_tokens": {
    "label": "Наибольший объём чтения за раз, токенов"
  },
  "limits.plan_max_items": {
    "label": "Записей в плане массового действия, не больше"
  },
  "limits.preauth": {
    "label": "Пределы запросов до проверки ключа"
  },
  "search.domains": {
    "label": "Словарь тем (доменные теги)"
  },
  "search.boosts": {
    "label": "Поправки ранжирования"
  },
  "search.current_space_boost": {
    "label": "Приоритет текущего пространства"
  },
  "search.max_per_parent": {
    "label": "Фрагментов одной записи среди кандидатов"
  },
  "search.snippet_window": {
    "label": "Окно фрагмента результата",
    "options": {
      "density": "где больше всего слов запроса",
      "first": "у первого слова запроса (прежние версии)"
    }
  },
  "search.org_unreviewed_factor": {
    "label": "Понижение непроверенных записей «Общих знаний компании»"
  },
  "search.derivation_order_enabled": {
    "label": "Пересказы в поиске — сразу после источника"
  },
  "search.derivation_factor": {
    "label": "Понижение пересказа в поиске (от 0,1 до 1)"
  },
  "access.origin_allowlist": {
    "label": "Разрешённые сайты для браузерных агентов (Origin)"
  },
  "access.t1_providers": {
    "label": "Доверенные внешние провайдеры"
  },
  "access.original_link_ttl_sec": {
    "label": "Срок ссылки на оригинал, секунд"
  },
  "access.link_signing_key": {
    "label": "Ключ подписи ссылок"
  },
  "access.public_base_url": {
    "label": "Адрес памяти в сети компании"
  },
  "access.cloud_agent_base_url": {
    "label": "Адрес памяти для облачных агентов"
  },
  "access.org_spaces_auto_create": {
    "label": "Создавать пространства подразделений"
  },
  "access.obo_external_identities": {
    "label": "Принимать «от имени» по внешним учётным записям"
  },
  "access.acl_stale_days": {
    "label": "Когда сведения о доступе устаревают, дней"
  },
  "access.obo_denial_pause": {
    "label": "Пауза ключа после серии отказов «от имени»"
  },
  "access.trash_days": {
    "label": "Срок хранения в корзине, дней"
  },
  "access.workplace_peers": {
    "label": "Сервер рабочего места"
  },
  "access.test_sessions": {
    "label": "Тестовые сессии — только для проверок"
  },
  "access.author_rule": {
    "label": "Когда поиск находит запись её автору",
    "options": {
      "legacy": "как раньше — если автор читает её пространство",
      "always": "всегда, и в поиске, и в списках"
    }
  },
  "access.trusted_proxies": {
    "label": "Доверенные прокси"
  },
  "access.external_hosts": {
    "label": "Внешние адреса агентов (имена)"
  },
  "access.agent_hosts": {
    "label": "Адреса для агентов (имена)"
  },
  "access.internal_networks": {
    "label": "Внутренние сети компании"
  },
  "access.system_key_networks": {
    "label": "Откуда принимается системный ключ"
  },
  "access.obo_service_keys": {
    "label": "Выпуск ключей сервисам «от имени»"
  },
  "access.require_department_code": {
    "label": "Требовать код подразделения в орг-таблице"
  },
  "access.dismissed_personal": {
    "label": "Личное пространство уволенного сотрудника",
    "options": {
      "keep": "хранить бессрочно",
      "delete": "удалять по сроку, как до 13.10 — со следующего прохода удалит личное всех, кто уволен дольше срока"
    }
  },
  "access.dismissed_meetings": {
    "label": "Встречи уволенного сотрудника",
    "options": {
      "transfer": "переходят хранителю — он становится организатором",
      "wait": "остаются у уволенного, как до 13.10; уже переданные вернутся к нему"
    }
  },
  "access.dismissed_custody_after_days": {
    "label": "Через сколько дней после увольнения хранитель получает встречи и доступ, дней"
  },
  "access.dismissed_custody_test": {
    "label": "Хранитель и передача встреч у тестовых учётных записей (только для проверок на стенде)"
  },
  "access.dismissed_retention_days": {
    "label": "Через сколько дней удалять личное тестовой учётной записи, дней"
  },
  "access.dismissed_custody": {
    "label": "Что читает хранитель личного уволенного",
    "options": {
      "all": "все записи; закрытые — после подтверждения, с записью в журнал",
      "open": "только открытые; о закрытых — только число",
      "off": "ничего: личное хранится, но его не читает никто"
    }
  },
  "access.mass_deactivation_share": {
    "label": "Порог подтверждения полной выгрузки орг-таблицы, доля"
  },
  "access.space_invite_days": {
    "label": "Сколько ждёт приглашение в проект, дней"
  },
  "access.test_leftovers_scope": {
    "label": "Где удалять записи отключённых тестовых учётных записей",
    "options": {
      "off": "нигде",
      "org": "только в «Общих знаниях компании»",
      "all": "во всех их пространствах"
    }
  },
  "access.test_leftovers_grace_minutes": {
    "label": "Выдержка перед удалением тестовых записей, минут"
  },
  "access.test_purge": {
    "label": "Удалять отключённое тестовое насовсем",
    "options": {
      "off": "нет",
      "auto": "да, раз в час"
    }
  },
  "access.test_purge_after_hours": {
    "label": "Через сколько часов удалять тестовое насовсем"
  },
  "access.test_purge_max": {
    "label": "Объектов одного вида за запуск, не больше"
  },
  "access.plan_agent_max_items": {
    "label": "Позиций плана, которые агент применяет сам"
  },
  "access.plan_ttl_minutes": {
    "label": "Срок плана массового действия, минут"
  },
  "access.promote_confirmation": {
    "label": "Кто подтверждает перенос агентом в общее пространство",
    "options": {
      "human": "человек в рабочем месте",
      "off": "никто: агент переносит сразу"
    }
  },
  "access.promote_confirmation_ttl_hours": {
    "label": "Сколько часов ждёт запрос агента на перенос"
  },
  "access.agent_member_add": {
    "label": "Кто добавляет участников в пространство",
    "options": {
      "workplace": "только владелец в рабочем месте",
      "allow": "также агент владельца"
    }
  },
  "access.correct_non_participant": {
    "label": "Исправление от того, кто запись только читает",
    "options": {
      "proposed": "предложение — подтверждает автор или владелец",
      "deny": "отказ"
    }
  },
  "access.org_review_enabled": {
    "label": "Проверка «Общих знаний компании» кураторами"
  },
  "access.org_review_days": {
    "label": "Через сколько дней непроверенное возвращается"
  },
  "access.org_review_queue_limit": {
    "label": "Записей на странице «Проверка общих знаний»"
  },
  "access.org_review_community_teams": {
    "label": "Подразделений для «подтверждено сообществом»"
  },
  "access.org_review_digest": {
    "label": "Недельное письмо кураторам"
  },
  "access.profile_enabled": {
    "label": "Рабочий профиль сотрудника"
  },
  "access.profile": {
    "label": "Пределы рабочего профиля"
  },
  "access.space_guide_enabled": {
    "label": "Карта «Как мы работаем»"
  },
  "access.space_guide": {
    "label": "Предел карты «Как мы работаем»"
  },
  "onboarding.readme_templates_enabled": {
    "label": "Описание пространства по шаблону"
  },
  "onboarding.space_overview_enabled": {
    "label": "Обзор пространства"
  },
  "onboarding.addable_enabled": {
    "label": "Можно добавить: свои встречи в проект"
  },
  "meetings.consent_version": {
    "label": "Версия текста согласия"
  },
  "meetings.consent_text": {
    "label": "Текст согласия участников"
  },
  "meetings.upload_ticket_ttl_sec": {
    "label": "Срок ссылки загрузки встречи, секунд"
  },
  "meetings.upload_max_mb": {
    "label": "Наибольший размер стенограммы, МБ"
  },
  "meetings.notify_participants": {
    "label": "Письмо участникам о встрече"
  },
  "open_check.enabled": {
    "label": "Проверять записи в открытый класс"
  },
  "open_check.disabled_rules": {
    "label": "Выключенные правила"
  },
  "open_check.packs": {
    "label": "Наборы правил"
  },
  "open_check.extra_rules": {
    "label": "Свои шаблоны"
  },
  "open_check.nda_customers": {
    "label": "Заказчики под NDA"
  },
  "open_check.timeout_sec": {
    "label": "Время на проверку одной записи, секунд"
  },
  "open_check.despite_enabled": {
    "label": "«Сделать доступным агентам»: включено"
  },
  "open_check.despite_projects": {
    "label": "«Сделать доступным агентам» в командах и проектах"
  },
  "open_check.despite_scans_text": {
    "label": "Сканы — только текстом"
  },
  "security.mode": {
    "label": "Режим безопасности",
    "options": {
      "basic": "basic — без людей-подписантов",
      "advanced": "advanced — вторые подписи и ключи"
    }
  },
  "security.downgrade_delay_hours": {
    "label": "Задержка возврата в basic, ч"
  },
  "admin.webauthn_aaguids": {
    "label": "Модели ключей, привязанных к устройству (AAGUID)"
  },
  "open_check.recheck_on_nda_change": {
    "label": "Перепроверять открытое, когда пополнили список NDA"
  },
  "open_check.recheck_batch": {
    "label": "Записей за один шаг перепроверки"
  },
  "observability.otlp_endpoint": {
    "label": "Адрес сбора метрик (OTLP)"
  },
  "observability.log_level": {
    "label": "Подробность логов"
  },
  "observability.outcomes": {
    "label": "Исходы поиска"
  },
  "observability.audit_open_reads": {
    "label": "Журналирование чтения открытого при недоступном журнале",
    "options": {
      "spool": "сохранить событие в очереди и ответить",
      "strict": "отказать при утрате события"
    }
  },
  "locale.mcp_language": {
    "label": "Язык инструментов MCP для агентов",
    "options": {
      "en": "английский",
      "ru": "русский"
    }
  },
  "locale.language": {
    "label": "Язык установки",
    "options": {
      "en": "английский",
      "ru": "русский"
    }
  },
  "locale.timezone": {
    "label": "Часовой пояс установки"
  },
  "locale.legacy_charset": {
    "label": "Кодировка старых текстов"
  },
  "admin.sso_login_enabled": {
    "label": "Вход администраторов через провайдера единого входа"
  },
  "admin.oidc_client_id": {
    "label": "Клиент провайдера единого входа для панели"
  },
  "admin.oidc_client_secret": {
    "label": "Секрет клиента провайдера единого входа для панели"
  },
  "admin.oidc_redirect_uri": {
    "label": "Адрес возврата панели"
  },
  "admin.ad_admin_group": {
    "label": "Группа AD администраторов (необязательно)"
  },
  "admin.oidc_username_form": {
    "label": "Форма имени администратора у провайдера единого входа",
    "options": {
      "any": "Короткое имя или полный UPN",
      "account": "Только короткое имя (sAMAccountName)",
      "upn": "Только полный UPN с доменом"
    }
  },
  "admin.networks": {
    "label": "Сети, из которых открывается панель"
  },
  "admin.webauthn_rp_id": {
    "label": "Имя панели для ключей (RP ID)"
  },
  "admin.webauthn_origins": {
    "label": "Источники панели"
  },
  "admin.webauthn_uv": {
    "label": "Проверка пользователя на ключе",
    "options": {
      "required": "Обязательна (PIN или отпечаток)",
      "preferred": "По возможности"
    }
  },
  "admin.webauthn_required": {
    "label": "Ключ обязателен для входа"
  },
  "admin.webauthn_min_keys": {
    "label": "Минимум ключей у администратора"
  },
  "admin.stepup_max_min": {
    "label": "Свежесть касания для подписи, мин"
  },
  "admin.session_max_min": {
    "label": "Сессия администратора, мин (в advanced — не больше 60)"
  },
  "admin.session_idle_min": {
    "label": "Выход без действий, мин (в advanced — не больше 15)"
  },
  "admin.tool_sessions": {
    "label": "Сессии для инструментов"
  },
  "admin.tool_session_max_min": {
    "label": "Сессия инструмента, мин"
  },
  "admin.second_signature": {
    "label": "Вторая подпись (определяется режимом безопасности)",
    "options": {
      "off": "Выключена — в basic не читается",
      "on": "Включена — в advanced всегда"
    }
  },
  "admin.second_signature_ttl_hours": {
    "label": "Срок заявки на вторую подпись, ч"
  },
  "admin.system_key_admin": {
    "label": "Системный ключ открывает админ-API"
  },
  "admin.local_login": {
    "label": "Вход admin@local",
    "options": {
      "open": "Открыт (как раньше)",
      "breakglass": "Только в аварийном доступе",
      "off": "Закрыт"
    }
  },
  "admin.local_totp_required": {
    "label": "Второй фактор обязателен для локальных администраторов"
  },
  "admin.auditor_key_access": {
    "label": "Аудитор читает журнал ключом агента"
  },
  "admin.service_keys_by_fingerprint": {
    "label": "Ключи сервисов — только по отпечатку"
  },
  "admin.breakglass_max_hours": {
    "label": "Аварийный доступ, ч"
  },
  "admin.bastion_cidrs": {
    "label": "Адреса бастиона"
  },
  "admin.alert_recipients": {
    "label": "Кому письма-тревоги"
  },
  "admin.alert_digest_hour": {
    "label": "Час ежедневной сводки"
  },
  "admin.audit_show_personal_titles": {
    "label": "Названия личных записей в журнале"
  },
  "admin.search_quality_query_texts": {
    "label": "Тексты частых пустых поисков"
  },
  "access.obo_read_consent": {
    "label": "Чтение от имени людей",
    "options": {
      "legacy": "Как раньше — без согласия",
      "consent": "Только с согласия человека",
      "off": "Выключено всем"
    }
  },
  "access.obo_read_consent_days": {
    "label": "Срок согласия на чтение от имени, дн"
  },
  "access.obo_read_alert_people_day": {
    "label": "Тревога: чтение от имени стольких людей в сутки"
  },
  "observability.audit_ship_mode": {
    "label": "Отправка журнала наружу",
    "options": {
      "off": "Выключена",
      "file": "В файлы (стенд)",
      "syslog_tls": "Syslog по TLS"
    }
  },
  "observability.audit_ship_target": {
    "label": "Куда отправлять журнал"
  },
  "observability.audit_ship_batch": {
    "label": "Событий журнала за раз"
  },
  "observability.audit_ship_interval_sec": {
    "label": "Как часто отправлять журнал, секунд"
  },
  "observability.audit_ship_lag_sec": {
    "label": "Задержка чтения журнала, секунд"
  },
  "observability.audit_archive_mode": {
    "label": "Архив журнала",
    "options": {
      "off": "выключен: все месяцы остаются в журнале",
      "export": "выгружать старые месяцы и оставлять их в журнале",
      "export_and_drop": "выгружать старые месяцы, затем удалять их из журнала"
    }
  },
  "observability.audit_retention_months": {
    "label": "Сколько месяцев журнал хранит до архивации"
  },
  "observability.audit_archive_keep_months": {
    "label": "Сколько месяцев хранить месяц в архиве после журнала (0 — бессрочно)"
  },
  "edge.export_enabled": {
    "label": "Отправлять открытые записи на ребро"
  },
  "edge.deadman_theta_sec": {
    "label": "Через сколько секунд без связи ребро перестаёт выдавать данные"
  },
  "edge.revoke_lag_warn_sec": {
    "label": "Предупреждать, если отзыв задерживается дольше, с"
  },
  "edge.revoke_lag_alarm_sec": {
    "label": "Тревога, если отзыв задерживается дольше, с"
  },
  "edge.reconcile_light_min": {
    "label": "Как часто сверять ребро, мин"
  },
  "edge.reconcile_full_hour": {
    "label": "Час ночной полной сверки"
  },
  "edge.projection_refresh_sec": {
    "label": "Как часто полностью обновлять права на ребре, с"
  },
  "edge.originals_max_mib": {
    "label": "Самый большой файл-оригинал на ребре, МиБ"
  },
  "edge.max_concurrent_per_connection": {
    "label": "Одновременных запросов от одного подключения"
  },
  "edge.connection_expiry_warn_days": {
    "label": "За сколько дней предупреждать о конце подключения"
  },
  "edge.bridge_url": {
    "label": "Адрес моста к ребру"
  },
  "edge.ldap_require_ldaps": {
    "label": "Проверять пароли входа извне только по LDAPS (StartTLS и без шифрования не принимать; в basic по умолчанию выключено)"
  },
  "access.https_port": {
    "label": "Порт HTTPS шлюза (0 — выключен)"
  },
  "edge.quota_mode": {
    "label": "Суточные квоты извне",
    "options": {
      "observe": "Наблюдение",
      "enforce": "Отказывать"
    }
  },
  "edge.quota_daily": {
    "label": "Суточные квоты на человека"
  },
  "edge.max_new_connections_alert_day": {
    "label": "Тревога: новых подключений у человека за сутки больше"
  },
  "edge.geo_alert_enabled": {
    "label": "Тревога о новой стране или сети подключения"
  },
  "edge.probe_enabled": {
    "label": "Зонд внешнего адреса"
  },
  "edge.probe_base_url": {
    "label": "Внешний адрес для зонда"
  },
  "edge.probe_connect_addr": {
    "label": "Внешний слушатель общего прокси для зонда"
  },
  "edge.probe_inner_hosts": {
    "label": "Внутренние имена, которых не должно быть на внешнем адресе"
  },
  "edge.probe_interval_min": {
    "label": "Как часто зонд, минут"
  },
  "edge.synthetic_login_enabled": {
    "label": "Синтетический вход"
  },
  "edge.synthetic_login_account": {
    "label": "Учётная запись синтетического входа"
  },
  "edge.synthetic_login_interval_min": {
    "label": "Как часто синтетический вход, минут"
  },
  "edge.geoip_db_path": {
    "label": "Файл базы стран и сетей"
  },
  "admin.alert_work_hours": {
    "label": "Рабочее время для тревог «только днём»"
  },
  "admin.alert_cooldown_min": {
    "label": "Пауза между повторами одной тревоги, минут"
  },
  "edge.login_enabled": {
    "label": "Внешний вход включён"
  },
  "edge.login_groups": {
    "label": "Группы AD, которым можно включить «Доступ извне» (пусто — никому)"
  },
  "edge.deny_groups": {
    "label": "Группы, которым внешний вход запрещён"
  },
  "edge.deny_admin_count": {
    "label": "Запретить учётным записям с признаком adminCount"
  },
  "edge.decoy_guids": {
    "label": "Учётные записи-ловушки"
  },
  "edge.login_domain": {
    "label": "Домен почты для короткого логина"
  },
  "edge.optin_fresh_login_min": {
    "label": "Свежесть входа для включения доступа, минут"
  },
  "edge.optin_idle_days": {
    "label": "Через сколько дней без входа извне доступ гаснет"
  },
  "edge.optin_first_confirm": {
    "label": "Первое включение «Доступа извне»",
    "options": {
      "office_or_support": "Из офиса или с подтверждением поддержкой",
      "none": "Без подтверждения"
    }
  },
  "edge.office_networks": {
    "label": "Сети офиса (не VPN)"
  },
  "edge.ad_lockout_threshold": {
    "label": "Порог блокировки AD (−1 — неизвестен: пароли не проверяются)"
  },
  "edge.ad_lockout_window_min": {
    "label": "Окно счётчика неверных паролей AD, минут"
  },
  "edge.ad_pdc": {
    "label": "Главный контроллер домена (PDC-эмулятор) — один из контроллеров «Вход и LDAP», тем же именем или IP"
  },
  "edge.ad_state_max_age_hours": {
    "label": "Предельный возраст сведений AD, часов"
  },
  "edge.ad_sweep_min": {
    "label": "Обход каталога, минут"
  },
  "edge.ad_pso_visible": {
    "label": "ИТ подтвердили: политики паролей (PSO) видны"
  },
  "edge.badpwd_reserve_min": {
    "label": "Нижняя граница запаса попыток человеку"
  },
  "edge.password_failures_per_window": {
    "label": "Верхняя граница бюджета неверных паролей за окно"
  },
  "edge.password_window_min": {
    "label": "Нижняя граница окна бюджета, минут"
  },
  "edge.password_failures_per_day": {
    "label": "Неудач внешнего входа на учётную запись за сутки"
  },
  "edge.global_binds_per_min": {
    "label": "Проверок пароля в каталоге с внешнего входа в минуту"
  },
  "edge.spray_alert_accounts_10min": {
    "label": "Тревога: неудачи по разным людям за 10 минут"
  },
  "edge.spray_pause_accounts_10min": {
    "label": "Автопауза: неудачи по разным людям за 10 минут"
  },
  "edge.spray_auto_pause": {
    "label": "Автоматическая пауза при распылении"
  },
  "edge.login_step_floor_ms": {
    "label": "Наименьшее время ответа шага входа, мс"
  },
  "edge.login_check_timeout_sec": {
    "label": "Сколько ждать проверки пароля, секунд"
  },
  "edge.check_unhealthy_queue": {
    "label": "Очередь проверок, после которой вход «нездоров»"
  },
  "edge.login_ip_limits": {
    "label": "Пределы по адресу и логину на странице входа"
  },
  "edge.nat_cidrs": {
    "label": "Общие адреса NAT компании (пределы выше)"
  },
  "edge.mfa_mode": {
    "label": "Второй фактор",
    "options": {
      "off": "Выключен",
      "optional": "По желанию",
      "required": "Обязателен"
    }
  },
  "edge.access_token_min": {
    "label": "Срок токена доступа, минут"
  },
  "edge.connection_idle_days": {
    "label": "Подключение гаснет после простоя, дней"
  },
  "edge.connection_max_days": {
    "label": "Предельный срок подключения, дней"
  },
  "edge.max_active_connections": {
    "label": "Подключений на человека"
  },
  "edge.login_session_hours": {
    "label": "Сессия входа с фактором, часов"
  },
  "edge.login_session_hours_no_mfa": {
    "label": "Сессия входа без фактора, часов"
  },
  "edge.grant_ttl_min": {
    "label": "Срок разрешения до обмена кода, минут"
  },
  "edge.refresh_reuse_grace_sec": {
    "label": "Окно повторного обновления, секунд"
  },
  "edge.refresh_reuse_action": {
    "label": "Что делать при повторе ключа обновления",
    "options": {
      "revoke_connection": "Отключить подключение",
      "reject_only": "Только отказать и предупредить"
    }
  },
  "edge.account_page_enabled": {
    "label": "Страница «Мои подключения» вне сети компании"
  },
  "edge.disabled_clients": {
    "label": "Выключенные программы"
  },
  "edge.mfa_provider": {
    "label": "Вид второго фактора",
    "options": {
      "totp": "Приложение с кодами"
    }
  },
  "edge.mfa_required_grace_days": {
    "label": "Льгота подключениям без фактора после «Обязателен», дней"
  },
  "edge.code_failures_per_window": {
    "label": "Неверных кодов за окно — не больше"
  },
  "edge.code_failures_per_day": {
    "label": "Неверных кодов за сутки — не больше"
  },
  "edge.code_failures_window_min": {
    "label": "Окно неверных кодов, минут"
  },
  "edge.code_lock_min": {
    "label": "На сколько запирать вход по коду после неверных кодов, минут"
  },
  "edge.mfa_fresh_login_min": {
    "label": "Насколько свежим должен быть вход для настройки фактора, минут"
  },
  "edge.mfa_pending_ttl_min": {
    "label": "Сколько ждать первого кода при настройке, минут"
  },
  "edge.mfa_issuer_label": {
    "label": "Название в приложении для кодов"
  },
  "edge.recovery_low_threshold": {
    "label": "Напоминать, когда кодов восстановления осталось не больше"
  },
  "ldap.servers": {
    "label": "Контроллеры каталога"
  },
  "ldap.port": {
    "label": "Порт"
  },
  "ldap.connect_timeout_sec": {
    "label": "Тайм-аут соединения, с"
  },
  "ldap.timeout_sec": {
    "label": "Тайм-аут операции, с"
  },
  "ldap.tls_mode": {
    "label": "Режим"
  },
  "ldap.insecure_ack": {
    "label": "Понимаю: без шифрования пароли людей, в том числе при входе извне, идут по сети открытым текстом"
  },
  "ldap.ca_cert": {
    "label": "Корневой сертификат каталога (PEM)"
  },
  "ldap.tls_server_name": {
    "label": "Имя в сертификате"
  },
  "ldap.bind_dn": {
    "label": "DN служебной учётной записи"
  },
  "ldap.bind_password": {
    "label": "Пароль служебной учётной записи"
  },
  "ldap.base_dn": {
    "label": "Где искать людей (base DN)"
  },
  "ldap.user_filter": {
    "label": "Фильтр поиска человека"
  },
  "ldap.attributes": {
    "label": "Имена атрибутов"
  },
  "ldap.login_groups": {
    "label": "Группы доступа"
  },
  "ldap.nested_groups": {
    "label": "Учитывать вложенные группы"
  },
  "ldap.domains": {
    "label": "Допустимые домены в имени входа"
  },
  "ldap.group_sync_minutes": {
    "label": "Сверять членство групп, минут"
  },
  "ldap.group_stale_hours": {
    "label": "Membership expires without verification, hours"
  },
  "ldap.group_max_members": {
    "label": "Наибольший размер группы"
  },
  "ldap.project_groups_base": {
    "label": "Ветка групп для пространств"
  },
  "access.session_days": {
    "label": "Срок входа, дней"
  },
  "access.session_idle_hours": {
    "label": "Простой, часов"
  },
  "access.support_contact": {
    "label": "Куда обращаться"
  },
  "ldap.failure_window_minutes": {
    "label": "Окно неудачных входов, минут"
  },
  "ldap.max_failures_per_login": {
    "label": "На одну учётную запись"
  },
  "ldap.max_failures_per_ip": {
    "label": "С одного адреса"
  },
  "ldap.enabled": {
    "label": "Вход в рабочее место учётной записью компании включён"
  },
  "oidc.issuer": {
    "label": "Издатель (issuer)"
  },
  "oidc.ca_cert": {
    "label": "Корневой сертификат провайдера единого входа (PEM)"
  },
  "oidc.timeout_sec": {
    "label": "Тайм-аут, с"
  },
  "oidc.private_networks": {
    "label": "Частные сети провайдера"
  },
  "oidc.client_id": {
    "label": "Client ID"
  },
  "oidc.client_secret": {
    "label": "Секрет клиента"
  },
  "oidc.redirect_uri": {
    "label": "Адрес возврата"
  },
  "oidc.scopes": {
    "label": "Области (scope)"
  },
  "oidc.login_groups": {
    "label": "Группы доступа"
  },
  "oidc.claims": {
    "label": "Имена claims"
  },
  "oidc.enabled": {
    "label": "Вход в рабочее место через провайдера единого входа включён"
  },
  "smtp.host": {
    "label": "Почтовый сервер"
  },
  "smtp.port": {
    "label": "Порт"
  },
  "smtp.security": {
    "label": "Шифрование"
  },
  "smtp.insecure_ack": {
    "label": "Понимаю: без шифрования логин, пароль и письма идут по сети открытым текстом"
  },
  "smtp.ca_cert": {
    "label": "Корневой сертификат сервера (PEM)"
  },
  "smtp.timeout_sec": {
    "label": "Тайм-аут, с"
  },
  "smtp.username": {
    "label": "Логин"
  },
  "smtp.password": {
    "label": "Пароль"
  },
  "smtp.from_address": {
    "label": "Адрес отправителя"
  },
  "smtp.from_name": {
    "label": "Имя отправителя"
  },
  "access.workplace_url": {
    "label": "Адрес рабочего места для ссылок"
  },
  "smtp.admin_email": {
    "label": "Почта администратора для уведомлений"
  },
  "smtp.max_attempts": {
    "label": "Попыток на письмо"
  },
  "smtp.retry_base_sec": {
    "label": "Первая пауза перед повтором, с"
  },
  "smtp.keep_days": {
    "label": "Хранить журнал писем, дней"
  },
  "smtp.enabled": {
    "label": "Отправка писем включена"
  }
};
