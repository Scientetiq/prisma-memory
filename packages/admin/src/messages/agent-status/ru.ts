import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const AGENT_UNKNOWN: Messages<typeof en.AGENT_UNKNOWN> = {
  title: "Агенты",
  tile: "не удалось проверить подключение",
  line: "Не удалось проверить, подключён ли агент: память сейчас не ответила.",
};
