const HEAD = "Records in which the memory tagged “";
const MEETINGS_HEAD = "Meetings involving “";
const TAIL = "” (those you can read)";
const OLD_HEAD = "Everything related to “";
const OLD_TAIL = "” that you can access";

export const selectionReadme = (title: string): string =>
  `${HEAD}${title}${TAIL}. The memory creates links automatically and may miss some. Also use memory_search to search by title.`;

export const meetingsHint = (login: string): string =>
  ` Meetings the person attended or organized without being named in the records are in /people/${login}/meetings.`;

export const meetingsReadme = (title: string, login: string): string =>
  `${MEETINGS_HEAD}${title}${TAIL}: the person attended or organized the meeting but is not named in its records. Their records and records that name them are in /people/${login}.`;

export function selectionTitle(readme: string | null | undefined): string | null {
  if (!readme) return null;
  for (const [head, tail] of [[HEAD, TAIL], [MEETINGS_HEAD, TAIL], [OLD_HEAD, OLD_TAIL]] as const) {
    if (!readme.startsWith(head)) continue;
    const end = readme.lastIndexOf(tail);
    if (end > head.length) return readme.slice(head.length, end);
  }
  return null;
}
