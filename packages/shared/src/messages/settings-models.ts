// Descriptions of the models.* settings (the model gateway and the processing model), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-models", {
  gateway_base_url: {
    en: "Address of the model gateway (an OpenAI-compatible endpoint such as LiteLLM), for example http://<gateway>:8080/v1",
    ru: "Адрес шлюза моделей платформы (LiteLLM), например http://<шлюз>:8080/v1",
  },
  gateway_api_key: {
    en: "Service key of the memory on the model gateway (stored encrypted)",
    ru: "Сервисный ключ памяти на шлюзе моделей платформы (хранится зашифрованным)",
  },
  llm_model: {
    en: "Name of the model that processes records, as the model gateway knows it",
    ru: "Название модели обработки записей на шлюзе платформы",
  },
  wire_fragment: {
    en: "Fixed parameters added to every model request (temperature, sampling, thinking mode); task prompts do not change them",
    ru: "Постоянные параметры каждого запроса к модели из профиля платформы (температура, выборка, режим размышлений); тексты заданий их не меняют",
  },
  timeout_sec: {
    en: "How long to wait for a model answer, seconds",
    ru: "Сколько ждать ответа модели, секунд",
  },
  repair_retries: {
    en: "How many times to ask the model again when its answer does not match the required form",
    ru: "Сколько раз переспросить модель, если ответ пришёл не по заданной форме",
  },
  schema_unsupported_keywords: {
    en: "JSON Schema keywords the model gateway does not understand: they are removed from the schema sent to the model, while the answer is still validated against the full schema",
    ru: "Правила формы ответа (слова JSON Schema), которых не понимает шлюз платформы: их убирают из формы, уходящей модели, а сам ответ всё равно проверяется по полной форме",
  },
  t0_aliases: {
    en: "Names of the models that run inside the company (on the model gateway). A model outside the list is allowed only when trusted external providers are admitted (access.t1_providers), and only for open records; otherwise the call is refused and the audit log gets a t1_fallback event",
    ru: "Названия моделей, которые работают внутри компании (на шлюзе платформы). Модель не из списка допускается, только если открыт допуск внешних провайдеров (настройка «Доверенные внешние провайдеры»), и только для открытых записей; иначе вызов отклоняется, а в журнал аудита пишется событие t1_fallback",
  },
});
