export const text = {
  image: (value0: string | number | null | undefined): string => `image: ${value0}`,
  image2: "image",
  page: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `<div class="pg" id="page-${value0}">Page ${value1}</div>`,
};
