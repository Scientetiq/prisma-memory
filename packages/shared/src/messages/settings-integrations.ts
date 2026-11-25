// Descriptions of the integrations.* settings (the document converter and outside services), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-integrations", {
  converter_url: {
    en: "Document converter (base URL without /api/v1, for example http://converter.example.com); empty — only Markdown and plain text are accepted",
    ru: "Конвертер документов (базовый URL без /api/v1, например http://converter.example.com); пусто — принимаются только markdown и текст",
  },
  converter_login: {
    en: "Login of the converter's service account; it needs the roles admin_upload and export_manager (check with the “Check connection” button in the panel)",
    ru: "Логин сервисной учётной записи конвертера; нужны роли admin_upload и export_manager (проверка — кнопка «Проверить связь» в панели)",
  },
  converter_password: {
    en: "Password of the converter's service account (stored encrypted)",
    ru: "Пароль сервисной учётной записи конвертера (хранится зашифрованным)",
  },
  converter_profile: {
    en: "Processing profile of the converter — fast-extraction only: a quick draft without full verification; other values are not saved. The memory picks the export profile itself from the outcome of the run",
    ru: "Профиль обработки конвертера — только fast-extraction: быстрый черновик без полной проверки, другие значения не сохраняются. Профиль выгрузки память выбирает сама по итогу прогона",
  },
  converter_classification: {
    en: "Data class label a document carries to the converter (the converter's own marking, not the class of the record in memory)",
    ru: "Метка класса данных, с которой документ уходит в конвертер (его собственная маркировка, не класс памяти)",
  },
  converter_timeout_sec: {
    en: "How long to wait for a converter run, seconds; after that the converted stage fails and is retried",
    ru: "Сколько ждать прогон конвертера, секунд; по истечении — стадия converted failed с повтором",
  },
  converter_poll_sec: {
    en: "How often the state of a run and of an export is polled, seconds",
    ru: "Период опроса состояния прогона и выгрузки, секунд",
  },
  converter_request_timeout_sec: {
    en: "How long to wait for ONE request to the converter (sign-in, an upload part, a poll, the archive download), seconds",
    ru: "Сколько ждать ОДИН запрос к конвертеру (вход, часть загрузки, опрос, скачивание архива), секунд",
  },
  converter_result_max_bytes: {
    en: "How many bytes of the converter's answer with the finished text the memory reads (128 MiB by default): the answer may carry the document's images too. A larger answer is fetched as an archive; a larger archive makes the document “too large to convert to text”. From 1 MiB to 1 GiB",
    ru: "Сколько байт ответа конвертера с готовым текстом память читает (128 МиБ): в ответе бывают и картинки документа. Ответ больше — текст забирается архивом; архив больше — документ «слишком большой для перевода в текст». От 1 МиБ до 1 ГиБ",
  },
  converter_text_max_bytes: {
    en: "Largest document text the memory takes from the converter, bytes; larger — the document is “too large”. 0 — twice the upload size limit",
    ru: "Наибольший размер текста документа, который память берёт у конвертера, байт; больше — документ «слишком большой». 0 — вдвое больше предела размера загружаемого файла",
  },
  converter_max_reruns: {
    en: "How many times to ask the converter to process a document again after its temporary failure before showing “Failed” (0–5); the “Retry” button starts the count again",
    ru: "Сколько раз просить конвертер обработать документ заново после его временного сбоя, прежде чем показать «Не получилось» (от 0 до 5); кнопка «Повторить» начинает счёт заново",
  },
  converter_window: {
    en: "How many documents are given to the converter at once (1–8); the rest wait their turn, round-robin between authors. Raise it above 1 only if the converter has more than one worker",
    ru: "Сколько документов одновременно отдавать конвертеру (от 1 до 8); следующие ждут своей очереди по кругу между авторами. У конвертера один обработчик на всех его пользователей: больше 1 имеет смысл, только если у него появятся дополнительные",
  },
  converter_run_deadline_hours: {
    en: "How many hours to wait for one converter run before starting it again or showing “Failed” (9–72: the converter itself cancels a run after 8 hours)",
    ru: "Сколько часов ждать одну обработку документа конвертером, прежде чем запустить её заново или показать «Не получилось» (от 9 до 72: конвертер сам снимает обработку через 8 часов)",
  },
  converter_accepted_suspect_min: {
    en: "After how many minutes a document the converter accepted but never started processing counts as stuck: it stops holding a place in the queue and the administrator gets a warning (5–720)",
    ru: "Через сколько минут документ, который конвертер принял, но так и не начал обрабатывать, считается застрявшим: он перестаёт занимать место в очереди, администратор получает предупреждение (от 5 до 720)",
  },
  converter_accepted_rerun_min: {
    en: "After how many minutes a document stuck this way is sent for processing again (10–1440, later than the moment it counts as stuck)",
    ru: "Через сколько минут застрявший так документ отправляется на обработку заново (от 10 до 1440, позже, чем он считается застрявшим)",
  },
  converter_ocr_rerun_delay_min: {
    en: "After how many minutes to repeat, once, the recognition of pages the converter could not read (1–1440); after the repeat the document is processed as it is",
    ru: "Через сколько минут один раз повторить распознавание страниц, которые конвертер не смог прочитать (от 1 до 1440); после повтора документ обрабатывается как есть",
  },
  converter_doc_error_max: {
    en: "How many times in a row to wait for a document whose result the converter does not return although it is working (8 is about 2–3 hours) before showing “Failed” (1–50); other documents keep going meanwhile",
    ru: "Сколько раз подряд ждать документ, результат которого конвертер не отдаёт, хотя сам работает (8 — около 2–3 часов), прежде чем показать «Не получилось» (от 1 до 50); остальные документы при этом идут",
  },
  converter_patience_hours: {
    en: "How many hours a document waits for an unavailable converter before showing “Failed” — the administrator can then retry (0–720). 0 — wait without limit: attempts are not spent, and after 4 hours of unavailability the administrator gets a warning",
    ru: "Сколько часов документ ждёт недоступный конвертер, прежде чем показать «Не получилось» — тогда администратор может повторить (от 0 до 720). 0 — ждать без предела: попытки не тратятся, а через 4 часа недоступности администратор получает предупреждение",
  },
  converter_dedup: {
    en: "Before sending a document to the converter, look for an already sent file with the same content: \"document\" — the found document of the same class is processed again at the converter without a second copy (each record gets its own run, results of other records are never reused); \"off\" — every file is sent anew",
    ru: "Перед отправкой документа в конвертер искать, не отправлен ли уже файл с тем же содержимым: \"document\" — найденный документ своего класса обрабатывается заново у конвертера без второй копии (у каждой записи — своя обработка, чужие результаты не берутся); \"off\" — каждый файл отправляется заново",
  },
  converter_formats: {
    en: "Which documents are accepted for conversion to text: a list of pdf, docx, doc, odt, rtf, pptx, ppt, odp, xlsx, ods, csv. PDF is always accepted. Word, PowerPoint and Excel files are accepted only when the converter supports fast conversion of office files; until then the memory does not take them. Files with macros, password-protected files and legacy .xls spreadsheets are never accepted",
    ru: "Какие документы принимать на перевод в текст: список из pdf, docx, doc, odt, rtf, pptx, ppt, odp, xlsx, ods, csv. PDF принимается всегда. Word, PowerPoint и Excel начинают приниматься, только когда конвертер умеет быстрый перевод офисных файлов (его новая версия), — до этого память сама их не берёт. Файлы с макросами, под паролем и старые таблицы .xls не принимаются никогда",
  },
  converter_office_test_hook: {
    en: "For testing only: Word, PowerPoint and Excel files are accepted from test people (attrs.test, a test domain, not a demo persona, no directory link) before they are enabled for everyone — for a live check of the converter. Works only when the converter supports fast conversion of office files; everyone else follows the format list. While on, health is degraded",
    ru: "Только для проверок: Word, PowerPoint и Excel принимаются у тестовых людей (attrs.test, тестовый домен, не демо, без связи с AD) ещё до того, как их включат всем, — для живой проверки конвертера на ВМ перед включением офиса. Действует, только когда конвертер умеет быстрый перевод офисных файлов; остальным людям — как в списке форматов. Пока включено, health — degraded",
  },
});
