import { rich } from "@/i18n/rich";
import { peopleParts as M } from "@/messages/ws-projects";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { formatDay } from "@/lib/plain";
import { MEMBER_ROLE_PLAIN, memberBasis, removable, roleChangeConfirm, roleSwitchable, PROJECT_PEOPLE_MESSAGES } from "@/lib/project-people";
import { initials } from "@/lib/spaces";
import type { MySpaceInvite, MySpaceMember, MySpaceReaderMember } from "@/lib/types";
import { cancelInviteAction, memberRoleAction, removeMemberAction } from "../actions";

export interface PlaceFields { space: string; space_name: string; space_kind: string }

const roleChip = (role: string) => <span className={role === "owner" ? "chip brand" : role === "member" ? "chip blue" : "chip"}>{MEMBER_ROLE_PLAIN[role] ?? role}</span>;

function Hidden({ place }: { place: PlaceFields }) {
  return <><input type="hidden" name="space" value={place.space} /><input type="hidden" name="space_name" value={place.space_name} /><input type="hidden" name="space_kind" value={place.space_kind} /></>;
}

export function MemberRow({ m, place, edit, archived }: { m: MySpaceMember; place: PlaceFields; edit: boolean; archived: boolean }) {
  const self = Boolean(m.self);
  const name = m.display_name || m.login;
  const canRemove = edit && removable(m, self);
  const nextRole = m.role === "member" ? "reader" : "member";
  const canSwitch = edit && roleSwitchable(m, self) && !(archived && nextRole === "member");
  return (
    <li className={self ? "mb-row self" : "mb-row"}>
      <span className="mb-ava" aria-hidden="true">{initials(name)}</span>
      <span className="mb-who">
        <b>{name}{self ? <span className="muted">{rich(M.youLine, null)}</span> : null}</b>
        {m.department || m.title ? <small>{[m.department, m.title].filter(Boolean).join(" · ")}</small> : null}
        <small className="mb-mail">{m.login}</small>
      </span>
      <span className="mb-meta">
        {roleChip(m.role)}
        {m.role === "owner" && m.source === "manual" ? null : <small>{memberBasis(m)}</small>}
      </span>
      {canRemove || canSwitch ? (
        <span className="mb-act">
          {canSwitch ? (
            <ActionForm action={memberRoleAction} submitLabel={PROJECT_PEOPLE_MESSAGES.changeRole} pendingLabel="…" compact quiet confirm={roleChangeConfirm(name, nextRole, place.space_kind, archived)}>
              <Hidden place={place} />
              <input type="hidden" name="login" value={m.login} />
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="as" value={nextRole} />
            </ActionForm>
          ) : null}
          {canRemove ? (
            <ActionForm action={removeMemberAction} submitLabel={M.remove} pendingLabel="…" compact danger confirm={M.removePreviouslyAddedRecordsWillStay(name, place.space_kind === "project" ? M.fromTheProject : M.fromTheTeam)}>
              <Hidden place={place} />
              <input type="hidden" name="login" value={m.login} />
              <input type="hidden" name="role" value={m.role} />
              <input type="hidden" name="name" value={name} />
            </ActionForm>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

export function ReaderRow({ m }: { m: MySpaceReaderMember }) {
  return (
    <li className={m.self ? "mb-row self" : "mb-row"}>
      <span className="mb-ava" aria-hidden="true">{initials(m.display_name)}</span>
      <span className="mb-who"><b>{m.display_name}{m.self ? <span className="muted">{rich(M.youLine2, null)}</span> : null}</b>{m.department ? <small>{m.department}</small> : null}</span>
      <span className="mb-meta">{roleChip(m.role)}</span>
    </li>
  );
}

export function InviteRow({ i, place, edit }: { i: MySpaceInvite; place: PlaceFields; edit: boolean }) {
  const name = i.display_name || i.login;
  return (
    <li className="mb-row mb-invited">{rich(M.invitedWillJoinOnFirstSignLine, { tag2: () => <Icon name="mail" />, tag1: (children) => <span className="mb-ava" aria-hidden="true">{children}</span>, tag4: (children) => <b>{children}</b>, tag5: (children) => <small className="mb-mail">{children}</small>, tag3: (children) => <span className="mb-who">{children}</span>, tag7: (children) => <span className="chip">{children}</span>, tag8: (children) => <small>{children}</small>, tag6: (children) => <span className="mb-meta">{children}</span> }, { value1: name, value2: i.department ? <small>{i.department}</small> : null, value3: i.login, value4: MEMBER_ROLE_PLAIN[i.role], value5: formatDay(i.expires_at), value6: edit ? (
        <span className="mb-act">
          <ActionForm action={cancelInviteAction} submitLabel={M.cancel} pendingLabel="…" compact>
            <Hidden place={place} />
            <input type="hidden" name="login" value={i.login} />
            <input type="hidden" name="name" value={name} />
          </ActionForm>
        </span>
      ) : null })}</li>
  );
}

export function Faces({ names, more }: { names: string[]; more: number }) {
  return (
    <ul className="sp-faces" aria-label={M.projectMembers3}>
      {names.map((n, i) => <li key={`${n}-${i}`} title={n}><span className="mb-ava" aria-hidden="true">{initials(n)}</span><span className="vis-hidden">{n}</span></li>)}
      {more ? <li className="sp-faces-more">+{more}</li> : null}
    </ul>
  );
}
