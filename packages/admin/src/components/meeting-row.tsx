
import Link from "next/link";
import { meetingState, personName, type MyMeeting } from "@/lib/meetings";
import { MEETINGS_PLAIN, namesLine } from "@/lib/plain";
import { Icon, type IconName } from "./icons";
import { LocalTime } from "./local-time";

function stateChip(m: MyMeeting): { label: string; icon: IconName; tone: string; detail: string } {
  const st = meetingState(m);
  if (st.tone === "ok") return { label: MEETING_ROW_TEXT.ready, icon: "circle-check", tone: "green", detail: st.label };
  if (st.tone === "danger") return { label: MEETING_ROW_TEXT.failed, icon: "circle-alert", tone: "red", detail: st.label };
  return { label: MEETING_ROW_TEXT.processing, icon: "hourglass", tone: "amber", detail: st.label };
}

export function meetingPeople(m: MyMeeting): string {
  const names = (m.participant_names ?? []).map(personName);
  const others = Math.max(0, m.participants - names.length - (m.role === "participant" ? 1 : 0));
  const who = m.role === "owner" ? MEETINGS_PLAIN.you : MEETINGS_PLAIN.organizer(personName(m.owner));
  const rest = names.length || others ? namesLine(names, others) : m.role === "owner" ? MEETINGS_PLAIN.noOthers : "";
  return [who, rest].filter(Boolean).join(" · ");
}

export function MeetingRow({ m, projects = true }: { m: MyMeeting; projects?: boolean }) {
  const st = stateChip(m);
  return (
    <li className={m.new ? "mt-row is-new" : "mt-row"}>
      <span className="ichip sm tone-gray"><Icon name="mic" /></span>
      <span className="mt-main">
        <Link href={`/records/${m.id}`} prefetch={false} className="mt-title">{m.title || MEETING_ROW_TEXT.untitled}</Link>
        <small><LocalTime iso={m.occurred_at} short /> · {meetingPeople(m)}</small>
        {m.summary_line ? <span className="mt-snip">{m.summary_line}</span> : null}
      </span>
      <span className="mt-side">
        {m.new ? <span className="st brand">{MEETINGS_PLAIN.fresh}</span> : null}
        {projects ? (m.projects ?? []).map((p) => (
          <Link key={p.slug} href={`/projects/${encodeURIComponent(p.slug)}`} prefetch={false} className="chip mt-project" title={MEETING_ROW_TEXT.projectMeeting}>
            <Icon name="layers" />{p.name}
          </Link>
        )) : null}
        <span className={`st ${st.tone}`} title={st.detail}><Icon name={st.icon} /><span className="st-l">{st.label}</span></span>
      </span>
    </li>
  );
}

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { MEETING_ROW_TEXT } from "../messages/components";
import { MEETING_ROW_TEXT } from "../messages/components";
