import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  image: (value0: string | number | null | undefined): string => `изображение: ${value0}`,
  image2: "изображение",
  page: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `<div class="pg" id="page-${value0}">Страница ${value1}</div>`,
};
