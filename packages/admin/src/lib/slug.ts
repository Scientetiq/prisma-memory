const MAP: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

export function slugify(name: string, fallback = "space"): string {
  const s = [...name.toLowerCase()].map((ch) => MAP[ch] ?? ch).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s.length >= 2 ? s : fallback;
}

export function projectSlugPreview(name: string, manual: string): string | null {
  const own = manual.trim();
  if (own) return own;
  return name.trim() ? slugify(name, "project") : null;
}
