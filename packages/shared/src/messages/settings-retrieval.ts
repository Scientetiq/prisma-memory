// Descriptions of the retrieval.* settings (embeddings and reranking), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-retrieval", {
  embeddings_model: {
    en: "Name of the semantic search (embeddings) model on the model gateway. While records prepared for semantic search exist, only the model that prepared them can be saved: another model would find the old records worse. Changing the model requires recomputing the vectors, which is a maintenance procedure and not a panel action; the “semantic search model” check on the overview shows a mismatch",
    ru: "Название модели поиска по смыслу на шлюзе платформы. Пока есть записи, подготовленные для поиска по смыслу, сохраняется только модель, которой они подготовлены: с другой моделью старые записи находились бы хуже. Смена модели — только вместе с пересчётом векторов, через разработчиков; расхождение показывает проверка «модель поиска по смыслу» на обзоре",
  },
  rerank_model: {
    en: "Name of the reranking model on the model gateway; empty — no reranking: results are merged from keyword and semantic search",
    ru: "Название модели уточнения выдачи (реранкера) на шлюзе платформы; пусто — без уточнения: выдача сводится из поиска по словам и по смыслу",
  },
  batch: {
    en: "How many chunks are sent to the semantic search model in one request",
    ru: "Сколько фрагментов отправлять модели поиска по смыслу одним запросом (платформа принимает не больше 16)",
  },
  max_tokens: {
    en: "Longest chunk for the semantic search model, tokens. Reserved: this version does not read it (chunk sizes come from processing.chunk)",
    ru: "Наибольшая длина фрагмента для модели поиска по смыслу, токенов",
  },
  rerank_top: {
    en: "How many top candidates of the merged results are passed to the reranker",
    ru: "Сколько лучших кандидатов сводной выдачи передавать реранкеру на уточнение",
  },
  retry_429_sec: {
    en: "Pause before a retry, seconds, when the semantic search model answers “busy, try later” (each further retry waits longer)",
    ru: "Пауза перед повтором, секунд, когда модель поиска по смыслу отвечает «занято, повторите позже» (каждый следующий повтор ждёт дольше)",
  },
});
