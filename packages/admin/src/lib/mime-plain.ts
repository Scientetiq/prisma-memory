import { MIME_PLAIN, kinds } from "../messages/mime-plain";
export function mimePlain(mime: string | null | undefined): string {
  const m = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (!m) return kinds.file;
  if (Object.hasOwn(MIME_PLAIN, m)) return MIME_PLAIN[m]!;
  const kind = m.split("/")[0];
  return kind === "image" ? kinds.image : kind === "audio" ? kinds.audio : kind === "video" ? kinds.video : kind === "text" ? kinds.text : kinds.file;
}
