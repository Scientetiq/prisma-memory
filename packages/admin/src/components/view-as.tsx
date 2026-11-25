import { VIEW_AS_TEXT } from "../messages/components";
export { VIEW_AS_TEXT } from "../messages/components";
import { switchViewAction } from "@/app/admin/(panel)/preview/actions";

export function AuditorBar() {
  return (
    <form action={switchViewAction} className="notice info view-as-bar" role="status">
      <span>{VIEW_AS_TEXT.auditorBarText}</span>
      <input type="hidden" name="view" value="admin" />
      <button type="submit" className="btn sm">{VIEW_AS_TEXT.returnAdmin}</button>
    </form>
  );
}
