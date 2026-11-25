import { participantsBlockText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { Badge, Section } from "@/components/ui";
import type { OutgoingRequest } from "@/lib/deletion-requests";
import { DELETION_REQUESTS_TEXT, DELETION_REASON_TITLES, DELETION_REASONS } from "@/lib/deletion-requests";
import { personName, type MeetingParticipants, type PersonRef } from "@/lib/meetings";
import { addParticipantConfirm, COMPOSITION_NAMES, formatDay, leaveMeetingConfirm, MEETING_PEOPLE_PLAIN as T, MEETINGS_PLAIN, removePendingConfirm } from "@/lib/plain";
import { personSelectionHref } from "@/lib/selection";
import { askDeleteAction, leaveMeetingAction, meetingParticipantAction } from "../../actions";
import { ParticipantPicker } from "./participant-picker";

export function avatarLetters(p: PersonRef): string {
  const words = (p.display_name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : words.length === 1 ? words[0]!.slice(0, 2) : p.login.slice(0, 2);
  return letters.toUpperCase();
}

const isYou = (p: PersonRef, me: string): boolean => p.login.toLowerCase() === me.toLowerCase();

const nameOf = (p: PersonRef, back: string | undefined) =>
  back ? <Link href={personSelectionHref(p.login, back)} prefetch={false} title={M.recordsInvolvingThisPerson}>{personName(p)}</Link> : personName(p);

export function organizerTransferLine(people: Pick<MeetingParticipants, "owner" | "organizer_transfer">, me: string): string | null {
  const t = people.organizer_transfer;
  if (!t) return null;
  const day = t.at ? formatDay(t.at) : null;
  return people.owner.login.toLowerCase() === me.toLowerCase()
    ? MEETINGS_PLAIN.handoverToYou(day, personName(t.from))
    : MEETINGS_PLAIN.handoverToOthers(day, personName(t.from), personName(people.owner));
}

export function MeetingComposition({ people, me }: { people: MeetingParticipants; me: string }) {
  const all: Array<PersonRef & { gone?: true }> = [...people.participants, ...people.pending];
  const shown = all.slice(0, COMPOSITION_NAMES).map((p) => ({ name: personName(p), you: isYou(p, me), gone: p.gone === true }));
  const more = all.length - shown.length;
  const handover = organizerTransferLine(people, me);
  return (
    <>
      <p className="mtg-people">
        <Icon name="users" />
        <span>{rich(M.organizerCaption("{name}", isYou(people.owner, me)), { tag0: children => <span className="muted">{children}</span> }, { name: personName(people.owner) })}</span>
        <span className="mtg-dot" aria-hidden="true">·</span>
        <span><span className="muted">{M.participantHeading}</span> {M.participantNames(shown, more)}</span>
        <span className="mtg-dot" aria-hidden="true">·</span>
        <a href="#participants">{people.can_edit ? T.change : T.show}</a>
      </p>
      {handover ? <p className="hint mtg-handover">{handover}</p> : null}
    </>
  );
}

function Fields({ id, op, who, name }: { id: string; op: "add" | "remove"; who: string; name: string }) {
  return <><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={op} /><input type="hidden" name="who" value={who} /><input type="hidden" name="name" value={name} /></>;
}

interface Props {
  id: string;
  people: MeetingParticipants;
  me: string;
  isParticipant: boolean;
  archived: boolean;
  orgHint: string | null;
  mine: OutgoingRequest | null;
  back?: string;
}

export function ParticipantsBlock({ id, people, me, isParticipant, archived, orgHint, mine, back }: Props) {
  const edit = people.can_edit;
  const add = edit && !archived;
  const inMeeting = [people.owner.login, ...people.participants.map((p) => p.login), ...people.pending.map((p) => p.login)];
  const notInvited = add ? people.not_invited ?? [] : [];
  const left = add ? people.left ?? [] : [];
  const notify = people.notify === true;
  return (
    <>
      <Section title={M.participants} id="participants" icon="users" hint={edit ? T.hintEdit : T.hintView}>
        <ul className="mb-list mp-list">
          <li className="mb-row">
            <span className="mb-ava" aria-hidden="true">{avatarLetters(people.owner)}</span>
            <span className="mb-who"><b>{rich(M.personCaption("{name}", isYou(people.owner, me), false), null, { name: nameOf(people.owner, back) })}</b></span>
            <span className="mb-meta"><Badge tone="info">{T.labelOrganizer}</Badge></span>
          </li>
          {people.participants.map((p) => (
            <li key={p.login} className="mb-row">
              <span className="mb-ava" aria-hidden="true">{avatarLetters(p)}</span>
              <span className="mb-who"><b>{rich(M.personCaption("{name}", isYou(p, me), false), null, { name: nameOf(p, back) })}</b>{p.gone ? <small className="muted">{T.gone}</small> : p.department ? <small>{p.department}</small> : null}</span>
              <span className="mb-meta"><Badge tone="neutral">{T.labelParticipant}</Badge></span>
              {edit ? (
                <span className="mb-act">
                  <ActionForm action={meetingParticipantAction} submitLabel={M.remove} pendingLabel="…" compact danger>
                    <Fields id={id} op="remove" who={p.login} name={personName(p)} />
                  </ActionForm>
                </span>
              ) : null}
            </li>
          ))}
          {people.pending.map((p) => (
            <li key={p.login} className="mb-row">
              <span className="mb-ava grp" aria-hidden="true">{avatarLetters(p)}</span>
              <span className="mb-who"><b>{personName(p)}</b>{p.display_name ? <small>{p.login}</small> : null}</span>
              <span className="mb-meta"><Badge tone="muted" title={T.waitingTitle}>{T.labelWaiting}</Badge></span>
              {edit ? (
                <span className="mb-act">
                  <ActionForm action={meetingParticipantAction} submitLabel={M.remove} pendingLabel="…" compact danger confirm={removePendingConfirm(personName(p))}>
                    <Fields id={id} op="remove" who={p.login} name={personName(p)} />
                  </ActionForm>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {people.unresolved.length ? <p className="hint">{M.unresolvedNames(people.unresolved)}</p> : null}
        {edit && orgHint ? <p className="hint">{orgHint}</p> : null}
        {add ? (
          <div id="edit-participants" className="mp-edit">
            <ParticipantPicker id={id} inMeeting={inMeeting} action={meetingParticipantAction} notify={notify} />

            {notInvited.length ? (
              <div className="mp-sub">
                <h3>{T.notInvitedTitle}</h3>
                <p className="hint">{T.notInvitedHint}</p>
                <ul className="mb-list mp-list">
                  {notInvited.map((p) => (
                    <li key={p.login} className="mb-row">
                      <span className="mb-ava grp" aria-hidden="true">{avatarLetters(p)}</span>
                      <span className="mb-who"><b>{personName(p)}</b><small>{M.suggestedPerson(p.department, p.why)}</small></span>
                      <span className="mb-act">
                        <ActionForm action={meetingParticipantAction} submitLabel={M.add} pendingLabel="…" compact quiet confirm={addParticipantConfirm(personName(p), { notify })}>
                          <Fields id={id} op="add" who={p.login} name={personName(p)} />
                        </ActionForm>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {left.length ? (
              <div className="mp-sub">
                <h3>{T.leftTitle}</h3>
                <p className="hint">{T.leftHint}</p>
                <ul className="mb-list mp-list">
                  {left.map((p) => (
                    <li key={p.login} className="mb-row">
                      <span className="mb-ava grp" aria-hidden="true">{avatarLetters(p)}</span>
                      <span className="mb-who"><b>{personName(p)}</b><small>{rich(M.leftCaption(Boolean(p.at)), null, { at: p.at ? <LocalTime iso={p.at} short /> : null })}</small></span>
                      <span className="mb-act">
                        <ActionForm action={meetingParticipantAction} submitLabel={T.returnLabel} pendingLabel="…" compact quiet confirm={addParticipantConfirm(personName(p), { notify })}>
                          <Fields id={id} op="add" who={p.login} name={personName(p)} />
                        </ActionForm>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <details className="mp-manual">
              <summary>{T.manualSummary}</summary>
              <p className="hint">{T.manualHint}</p>
              <ActionForm action={meetingParticipantAction} submitLabel={T.manualSubmit} pendingLabel="…" quiet resetOnSuccess confirm={addParticipantConfirm(null, { notify })}>
                <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="add" />
                <label className="field"><span className="field-label">{T.manualLabel}</span><input name="who" required minLength={3} maxLength={200} placeholder={M.colleagueExample} autoComplete="off" /></label>
              </ActionForm>
            </details>
          </div>
        ) : null}
      </Section>

      {isParticipant ? (
        <Section title={T.mistakeTitle} id="not-mine" icon="circle-help" hint={T.mistakeHint}>
          <div className="actions-col">
            <ActionForm action={leaveMeetingAction} submitLabel={T.leave} pendingLabel="…" danger confirm={leaveMeetingConfirm()}>
              <input type="hidden" name="id" value={id} />
            </ActionForm>
            {mine ? (
              mine.status === "kept"
                ? <p className="hint">{rich(M.deletionKept(Boolean(mine.kept_at)), { tag0: () => <LocalTime iso={mine.created_at} short /> }, { at: mine.kept_at ? <LocalTime iso={mine.kept_at} short /> : null })}</p>
                : mine.status === "declined"
                ? <p className="hint">{rich(M.deletionDeclined(Boolean(mine.declined_at)), { tag0: () => <LocalTime iso={mine.created_at} short /> }, { at: mine.declined_at ? <LocalTime iso={mine.declined_at} short /> : null })}</p>
                : <p className="hint">{rich(M.deletionRequestedTheOrganiserAndMemory, { tag0: () => <LocalTime iso={mine.created_at} short /> })}</p>
            ) : (
              <ActionForm action={askDeleteAction} submitLabel={T.askDelete} pendingLabel="…" quiet confirm={DELETION_REQUESTS_TEXT.askDeleteConfirm}>
                <input type="hidden" name="id" value={id} />
                <label className="field">
                  <span className="field-label">{rich(M.reasonOptional, null)}</span>
                  <select name="reason" defaultValue="">
                    <option value="">{rich(M.doNotSpecify, null)}</option>
                    {DELETION_REASONS.map((r) => <option key={r} value={r}>{DELETION_REASON_TITLES[r]}</option>)}
                  </select>
                </label>
              </ActionForm>
            )}
          </div>
        </Section>
      ) : null}
    </>
  );
}
