// The morning note card on the Overview: the numbers of the person's note for the window of
// the latest slot — the same computation and window as the e-mail (GET /api/v1/me/morning-note) — with links into the workspace,
// and the person's own switch of the e-mail. Shown even without e-mail. Nothing to tell: a short card with the switch only when
// the switch matters (the e-mail sends the person here to turn it off; or it was turned off), otherwise no card. Numbers only:
// no titles. Server component; the switch is an ActionForm with one hidden field, so it also works without JavaScript.
import Link from "next/link";
import { ActionForm, type FormAction } from "./action-form";
import { ListHead } from "./list-head";
import { emailState, noteLines, sinceText, switchMatters, type MorningNoteView } from "@/lib/morning-note";
import { mnText } from "@/lib/morning-note.messages";

export function MorningNoteCard({ view, action }: { view: MorningNoteView; action: FormAction }) {
  const { lines, waiting } = noteLines(view.counts);
  const empty = !lines.length && !waiting.length;
  if (empty && !switchMatters(view.email)) return null;
  const since = sinceText(view.window.from, view.window.tz);
  const mail = emailState(view.email, view.window.time, view.window.tz);
  return (
    <section className="home-sec" aria-labelledby="morning-note-title">
      <ListHead id="morning-note-title" icon="clock" title={mnText("title")} aside={since ? <span className="muted small">{since}</span> : null} />
      <div className="card morning-note"><div className="body">
        {empty ? <p>{mnText("nothing_new")}</p> : (
          <ul className="plain">
            {lines.map((l) => <li key={l.text}><Link href={l.href} prefetch={false}>{l.text}</Link></li>)}
            {waiting.length ? (
              <li>{mnText("waiting")}
                <ul className="plain">{waiting.map((l) => <li key={l.text}><Link href={l.href} prefetch={false}>{l.text}</Link></li>)}</ul>
              </li>
            ) : null}
          </ul>
        )}
        <p className="muted small">{mail.line}</p>
        <ActionForm action={action} submitLabel={mnText(mail.on ? "email_turn_off" : "email_turn_on")} pendingLabel={mnText("email_saving")} quiet notify>
          <input type="hidden" name="enabled" value={mail.on ? "false" : "true"} />
        </ActionForm>
      </div></div>
    </section>
  );
}
