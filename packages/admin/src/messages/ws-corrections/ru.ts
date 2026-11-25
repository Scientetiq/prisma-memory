import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const actionsText: Messages<typeof en.actionsText> = {
  tooLongUseAtMost2: "Слишком длинно: до 2 000 знаков — скажите коротко, что верно.",
  thisKindOfCorrectionDoesNot: "Такое исправление к этой записи не подходит.",
  theTranscriptPhraseMustBeBetween: "Фраза из стенограммы — от 8 до 1 000 знаков.",
  describeWhatIsCorrect: "Напишите, что верно.",
  selectTheNewerRecordFromThe: "Выберите более новую запись из списка ещё раз.",
  thisDoesNotLookLikeA: "Не похоже на адрес записи: вставьте ссылку на страницу записи или её номер.",
  chooseAnotherRecordThisIsThe: "Укажите другую запись: это та же самая.",
  describeWhatChangedOrPasteThe: "Напишите, что изменилось, или вставьте адрес более новой записи.",
  enterTheNewNoteText: "Напишите новый текст заметки.",
  titleMustBeAtMost200: "Название — до 200 знаков.",
  unknownCorrectionDecision: "Неизвестное решение по исправлению",
  specifyWhoToReplaceAndTheir: "Укажите, кого заменить и на кого.",
  namesMustBeAtMost120: "Имя — до 120 знаков.",
  specifyDifferentNames: "Укажите разные имена.",
};

export const pageText: Messages<typeof en.pageText> = {
  theListCouldNotBeLoaded: "Не удалось загрузить список — обновите страницу.",
  youNoLongerHaveAccessTo: "Запись больше недоступна вам",
  untitled: "Без названия",
  noMoreRecords: "Дальше пусто.",
  record: "Запись",
  proposedChanges: "Что предлагают",
  who: "Кто",
  when: "Когда",
  decision: "Решение",
  whatChanged: "Что исправлено",
  state: "Состояние",
  action: "Действие",
};
