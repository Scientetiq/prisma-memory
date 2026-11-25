import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const MIME_PLAIN: Messages<typeof en.MIME_PLAIN> = {
  "text/plain": "Текст", "text/markdown": "Текст с разметкой (Markdown)", "text/x-markdown": "Текст с разметкой (Markdown)", "text/html": "Веб-страница",
  "text/csv": "Таблица (CSV)", "text/vtt": "Субтитры", "application/x-subrip": "Субтитры", "application/json": "Данные (JSON)", "application/pdf": "PDF",
  "application/msword": "Документ Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Документ Word",
  "application/rtf": "Документ RTF", "text/rtf": "Документ RTF", "application/vnd.oasis.opendocument.text": "Документ OpenDocument",
  "application/vnd.ms-excel": "Таблица Excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Таблица Excel",
  "application/vnd.ms-powerpoint": "Презентация PowerPoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "Презентация PowerPoint",
  "application/vnd.oasis.opendocument.presentation": "Презентация OpenDocument", "application/vnd.oasis.opendocument.spreadsheet": "Таблица OpenDocument",
  "message/rfc822": "Письмо", "application/zip": "Архив ZIP",
};
export const kinds: Messages<typeof en.kinds> = {"file": "Файл", "image": "Изображение", "audio": "Аудиозапись", "video": "Видеозапись", "text": "Текст"};
