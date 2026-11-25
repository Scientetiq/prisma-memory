import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  aiAgent: "ИИ-агент",
  isConnected: (value0: string | number | null | undefined): string => `${value0} подключён`,
  andAreConnected: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} и ${value1} подключены`,
  andMoreAreConnected: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} и ещё ${value1} подключены`,
  text: "текст",
  images: "картинки",
  upToMb: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} · до ${value1} МБ`,
  materialsLead: (t: { name: string; personal: boolean; defaultClass: "open" | "closed"; org?: boolean } | null, show: string): string => { const head = "Загружайте документы и записывайте заметки"; if (!t) return `${head}.`; if (t.personal) return t.defaultClass === "closed" ? `${head}. Новые видите только вы; показать запись ИИ-агентам можно на её странице — «${show}».` : `${head}. Новые видите вы и ваши ИИ-агенты.`; const who = t.org ? "все сотрудники компании" : `участники «${t.name}»`; return t.defaultClass === "closed" ? `${head} — их увидят ${who}, ИИ-агенты — нет.` : `${head} — их увидят ${who} и их ИИ-агенты.`; },
};


export const HOME_TEXT: Messages<typeof en.HOME_TEXT> = {
  materialsTitle: "Мои записи",
  allMaterials: "Все записи",
  spacesTitle: "Пространства и проекты",
  allSpaces: "Все пространства и проекты",
  emptyMine: "Здесь появятся ваши документы и заметки.",
  emptyMineSub: "Загрузите файл или запишите мысль — память найдёт их, когда понадобится.",

  transcripts: "Стенограмму встречи сюда не загружайте — её присылает организатор:",
  saveTo: "Сохранится в:",
};
