import { SPACE_SEARCH_TEXT } from "../messages/components";
import { FindField } from "./find-field";

export function SpaceSearch({ slug, name }: { slug: string; name: string }) {
  const label = SPACE_SEARCH_TEXT.searchIn(name);
  return <FindField className="find-space" action="/search" hidden={{ space: slug }} formLabel={label} label={label} placeholder={label} maxLength={500} autoComplete="off" />;
}
