import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { StageErrorInfo } from "../../lib/stage-errors";
import { CONVERSION_ERROR_TITLES } from "../labels/ru";
const RETRY = "Нажмите «Повторить» у записи или повторите все упавшие.";
const DEV = "Если повтор не помогает — передайте код разработчикам.";
export const STAGE_ERROR_INFO: Messages<typeof en.STAGE_ERROR_INFO> = {
    converter_rejected: { title: CONVERSION_ERROR_TITLES.converter_rejected!, advice: "Повтор даст тот же отказ. Попросите автора пересохранить файл в другом формате и загрузить заново." },
    converter_too_large: { title: CONVERSION_ERROR_TITLES.converter_too_large!, advice: "Повтор даст тот же отказ. Файл нужно разделить на части или поднять предел в настройках конвертера." },
    converter_unsupported: { title: CONVERSION_ERROR_TITLES.converter_unsupported!, advice: "Повтор даст тот же отказ. Попросите автора сохранить файл в PDF или DOCX." },
    converter_no_text: { title: "в файле не нашлось текста — похоже на скан", advice: "Повтор даст тот же отказ. Скан с распознаванием текста нужно загрузить заново." },
    converter_auth: { title: CONVERSION_ERROR_TITLES.converter_auth!, advice: "Проверьте ключ конвертера в «Настройках», затем повторите." },
    converter_timeout: { title: CONVERSION_ERROR_TITLES.converter_timeout!, advice: `Конвертер был занят или файл большой. ${RETRY}` },
    converter_network: { title: "конвертер недоступен по сети", advice: `Проверьте, что конвертер работает, затем повторите. ${RETRY}` },
    converter_http: { title: "конвертер ответил ошибкой", advice: `${RETRY} ${DEV}` },
    converter_run_gone: { title: CONVERSION_ERROR_TITLES.converter_run_gone!, advice: "Попросите автора загрузить файл заново." },
    converter_assurance_conflict: { title: "конвертер не выдал выгрузку этого прогона", advice: `${RETRY} Если ошибка повторяется — передайте код разработчикам: путь быстрого режима тоже не дал текста.` },
    converter_wait: { title: "ждёт конвертер документов", advice: "Ничего делать не нужно: попытки не тратятся, обработка продолжится сама, когда конвертер снова примет документ." },
    open_check: { title: "текст не прошёл проверку для общего пространства", advice: "Повтор даст тот же отказ. Документ нужно загрузить в закрытое пространство команды." },
    open_check_fallback_failed: { title: "перенос в закрытое после проверки не удался", advice: "Повторите перенос в «Переносах класса» ниже — обработка продолжится в закрытом сама." },
    model_busy: { title: "модель была занята", advice: "Ничего делать не нужно: стадия повторится сама, когда модель освободится." },
    model_slow: { title: "модель не ответила вовремя", advice: "Ничего делать не нужно: стадия повторится сама." },
    model_config: { title: "модель недоступна по настройкам", advice: "Проверьте настройки модели в «Настройках»; стадия ждёт и повторится сама." },
    llm_too_slow: { title: "модель не успевает ответить на эту запись", advice: "Повторите ночью, когда модель свободна; если не выйдет — передайте разработчикам." },
    llm_timeout: { title: "модель не ответила вовремя", advice: RETRY },
    schema_error: { title: "ответ модели не подошёл по форме", advice: `${RETRY} ${DEV}` },
    platform_http: { title: "шлюз модели ответил ошибкой", advice: `Проверьте блок «Модель» вверху страницы. ${RETRY}` },
    platform_gate: { title: "шлюз модели не пустил запрос", advice: "Проверьте блок «Модель» вверху страницы и ключ шлюза в «Настройках»." },
    platform_busy: { title: "модель была занята", advice: RETRY },
    platform_bad_response: { title: "модель вернула непонятный ответ", advice: `${RETRY} ${DEV}` },
    platform_aborted: { title: "запрос к модели прерван", advice: RETRY },
    aborted: { title: "прервано перезапуском", advice: "Ничего делать не нужно: стадия продолжится сама." },
    stuck_running: { title: "стадия не завершилась в срок", advice: RETRY },
    worker_restart: { title: "стадия прервана перезапуском обработчика", advice: RETRY },
    handoff: { title: "запись перенесена между открытым и закрытым во время обработки", advice: "Ничего делать не нужно: стадия продолжится в новом месте." },
    index_held_long: { title: "подготовка к поиску давно ждёт переноса записи между открытым и закрытым", advice: "Проверьте перенос записи на вкладке «Переносы класса»: он не завершается. Стадия повторяется сама не чаще раза в 30 минут." },
    index_source_check_failed: { title: "перед отправкой модели не удалось проверить запись (сбой базы)", advice: `Проверьте базы данных памяти. ${RETRY} ${DEV}` },
    index_store_locked: { title: "подготовка к поиску не сохранила результат: на последней попытке запись была занята другой операцией", advice: `Сама стадия больше не повторится. Проверьте, не идёт ли долгая операция с базой данных памяти (перестроение поискового индекса, перенос записи), и дождитесь её конца. ${RETRY} ${DEV}` },
    index_wait: { title: "подготовка к поиску ждёт: запись или поисковый индекс заняты другой операцией", advice: `Ничего делать не нужно: стадия повторится сама через минуту. Попытка тратится, только когда модель уже отработала, а её результат не удалось сохранить; когда попытки кончатся, ожидание станет ошибкой — тогда смотрите её совет. Если стадия с этой причиной уже отмечена упавшей, сама она не повторится. ${RETRY}` },
    error: { title: "ошибка обработки", advice: `${RETRY} ${DEV}` },
    superseded: { title: "обрабатывается новая версия записи", advice: "Ничего делать не нужно: обработка идёт у новой версии." },
    open_check_fallback: { title: "документ переносится в закрытое", advice: "Ничего делать не нужно: перенос идёт сам; его видно на вкладке «Переносы класса»." },
    version_wait: { title: "waits for the current version of the document", advice: "Nothing to do: attempts are not spent; the new version is finished as soon as the document is free." },
    version_refused: { title: "the new version was not added to the document", advice: "Retrying gives the same result. Open the record: it says why, and what to do with the file." },
};

export const text: Messages<typeof en.text> = {
  retry: RETRY,
  fallback: `${RETRY} ${DEV}`,
  missing: "причина не записана",
  failed: "не получилось",
};
