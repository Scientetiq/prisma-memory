import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { Badge, Empty, Notice, Section, TableWrap } from "@/components/ui";
import { tryGw } from "@/lib/api";
import { requireSession } from "@/lib/session";
import { readAdminView } from "@/lib/view-as";
import { adminSessions as m } from "@/messages/admin-sessions";
import { endSessionAction, logoutAllAction } from "./actions";

export function SignOutEverywhere() {
  return <ActionForm action={logoutAllAction} submitLabel={m.signOut} pendingLabel={m.pending} compact quiet
    confirm={{ question: m.question, verb: m.signOut, cancel: m.cancel, ack: { name: "confirm_sessions", label: m.acknowledge } }}>
    <label className="check ack-fallback"><input type="checkbox" name="confirm_sessions" /> {m.acknowledge}</label>
  </ActionForm>;
}

interface SessionItem {
  id: string; person_id?: string | null; local_login?: string | null; role: string; auth_method: string; client_ip?: string | null;
  created_at: string; last_seen_at: string; expires_at: string; tool: boolean; breakglass?: boolean; current: boolean;
}
interface Owner { person_id: string; login: string; display_name: string | null }

export async function AdminSessions({ owners, localLogins = [], filter = "" }: { owners: Owner[]; localLogins?: string[]; filter?: string }) {
  const session = await requireSession();
  if (session.role === "security_auditor" || await readAdminView() === "auditor") return null;
  if (!session.token.startsWith("mem_as_")) return <Section title={m.title}><p>{m.listenerRequired}</p></Section>;
  const people = new Map(owners.map((p) => [p.person_id, p.display_name || p.login]));
  const query = filter.startsWith("person:") ? { person_id: filter.slice(7) } : filter.startsWith("local:") ? { local_login: filter.slice(6) } : undefined;
  const res = await tryGw<{ items: SessionItem[]; truncated: boolean }>("/api/v1/admin/sessions", { query });
  return <Section title={m.title} hint={m.hint}>
    <form method="get" action="/admin/admins" className="form-inline">
      <label>{m.owner} <select name="sessions" defaultValue={filter}>
        <option value="">{m.all}</option>
        {[...people].map(([id, name]) => <option key={id} value={`person:${id}`}>{name}</option>)}
        {localLogins.map((login) => <option key={login} value={`local:${login}`}>{login}</option>)}
      </select></label><button className="btn sm" type="submit">{m.filter}</button>
    </form>
    {!res.ok ? <Notice tone="danger">{m.loadFailed}</Notice> : <>
      {res.data.truncated ? <Notice tone="warn">{m.truncated}</Notice> : null}
      {!res.data.items.length ? <Empty icon="circle-check">{m.empty}</Empty> : <TableWrap cards><table className="board">
        <thead><tr>{[m.owner, m.started, m.seen, m.expires, m.address, m.method, m.action].map((title) => <th key={title}>{title}</th>)}</tr></thead>
        <tbody>{res.data.items.map((s) => <tr key={s.id}>
          <td data-label={m.owner}>{s.local_login || people.get(s.person_id ?? "") || s.person_id || m.unknown}
            {s.current ? <Badge>{m.current}</Badge> : null}{s.tool ? <Badge>{m.tool}</Badge> : null}{s.breakglass ? <Badge tone="warn">{m.breakglass}</Badge> : null}</td>
          <td data-label={m.started}><LocalTime iso={s.created_at} relative={false} /></td>
          <td data-label={m.seen}><LocalTime iso={s.last_seen_at} /></td>
          <td data-label={m.expires}><LocalTime iso={s.expires_at} relative={false} /></td>
          <td data-label={m.address}>{s.client_ip || m.unknown}</td><td data-label={m.method}>{Object.hasOwn(m.methods, s.auth_method) ? m.methods[s.auth_method as keyof typeof m.methods] : m.unknown}</td>
          <td data-label={m.action}><ActionForm action={endSessionAction} submitLabel={m.end} pendingLabel={m.pending} compact danger
            confirm={{ question: m.endQuestion, verb: m.end, cancel: m.cancel, ack: { name: "confirm_sessions", label: m.endAcknowledge } }}>
            <input type="hidden" name="session_id" value={s.id} />
            <label className="check ack-fallback"><input type="checkbox" name="confirm_sessions" /> {m.endAcknowledge}</label>
          </ActionForm></td>
        </tr>)}</tbody>
      </table></TableWrap>}
    </>}
  </Section>;
}
