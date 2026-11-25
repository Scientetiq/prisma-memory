import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const uploadQueue: Messages<typeof en.uploadQueue> = {
  memoryIsNotAcceptingFiles: "Память не принимает файлы",
  uploadedAlreadySavedFailed: (value0: unknown, value1: unknown, value2: unknown): string => `Загружено: ${value0} · Уже было: ${value1} · Не удалось: ${value2}`,
  memoryAsksYouToWaitSUploading: (value0: unknown): string => `Память просит подождать ${value0} с — продолжу сама. Не закрывайте страницу`,
  noConnectionFileWasNotSent: "нет связи: файл не отправлен",
  memoryIsStillAskingYouToWait: "память всё ещё просит подождать — отправьте этот файл позже",
};
