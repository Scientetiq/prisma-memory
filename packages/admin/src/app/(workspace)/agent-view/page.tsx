// "What my agent sees": two numbers — visible to the person's agents and the
// person's own records hidden from agents — a table per space, what can be done about the hidden records (show many to agents
// through a plan, review one by one, meetings stay with their participants) and the default for new records in the personal
// space. Numbers only: the gateway sends no titles. The page does not exist for a preview ("view as") session.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, LoadError, Notice, PageHead, Section, TableWrap } from "@/components/ui";
import { AGENT_VIEW_PATH, bulkOffer, classTitle, hiddenGroups, incompleteText, records, spaceKindTitle, type AgentView } from "@/lib/agent-view";
import { avText, formatNumber, typeCount } from "@/lib/agent-view.messages";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { SECTION_TITLES } from "@/lib/plain";
import { createOpenPlanAction } from "./actions";
import { DefaultForm } from "./default-form";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.agentView }; }

const num = (n: number | null): string => (n === null ? "—" : formatNumber(n));

export default async function AgentViewPage() {
  const { session } = await requireWorkspace();
  if (session.preview) notFound();
  const r = await meGw<AgentView>(session.key, AGENT_VIEW_PATH);
  if (!r.ok) {
    return <>
      <PageHead title={avText("title")} />
      {r.code === "forbidden" ? <Notice tone="info">{r.message}</Notice> : <LoadError result={r} what={avText("load_what")} />}
    </>;
  }
  const v = r.data;
  const groups = hiddenGroups(v), offer = bulkOffer(v), missing = incompleteText(v.incomplete);
  const types = Object.entries(v.hidden_mine_by_type).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const nothingHidden = v.hidden_mine === 0;
  return <>
    <PageHead title={avText("title")} lead={avText("lead")} />
    {missing ? <Notice tone="warn">{missing}</Notice> : null}
    <div className="stat-tiles">
      <div className="stat-tile"><div className="v">{num(v.visible)}</div><div className="k">{avText("visible_label")}</div></div>
      <div className="stat-tile"><div className="v">{num(v.hidden_mine)}</div><div className="k">{avText("hidden_label")}</div></div>
    </div>

    <Section id="agent-view-hidden" title={avText("hidden_title")}>
      {nothingHidden ? <p>{avText("hidden_none")}</p> : <div className="overview-grid agent-view-groups">
        {offer.off && groups.bulk > 0 ? <div className="card"><div className="body">
          <p>{avText(offer.off === "admin" ? "bulk_off_admin" : "bulk_off_check")}</p>
        </div></div> : groups.bulk > 0 ? <div className="card"><div className="body">
          <p>{avText("bulk_line", { records: records(groups.bulk) })}</p>
          {offer.show ? <ActionForm action={createOpenPlanAction} submitLabel={avText("bulk_button", { records: records(offer.count) })} pendingLabel="…">{null}</ActionForm> : null}
          <p className="hint">{avText("bulk_how")}</p>
          {offer.more ? <p className="hint">{avText("bulk_more", { max: records(v.bulk_open.max_items) })}</p> : null}
        </div></div> : null}
        {groups.held > 0 ? <div className="card"><div className="body">
          <p>{avText("held_line", { records: records(groups.held) })}</p>
          <div><Link href="/materials" prefetch={false} className="btn sm">{avText("review_action")}</Link></div>
        </div></div> : null}
        {groups.meetings > 0 ? <div className="card"><div className="body">
          <p>{avText("meetings_line", { records: records(groups.meetings) })}</p>
          <div><Link href="/meetings" prefetch={false} className="btn sm">{avText("meetings_action")}</Link></div>
        </div></div> : null}
        {groups.other > 0 ? <div className="card"><div className="body">
          <p>{avText("other_line", { records: records(groups.other) })}</p>
          <div><Link href="/materials" prefetch={false} className="btn sm">{avText("review_action")}</Link></div>
        </div></div> : null}
      </div>}
      {types.length ? <p className="hint">{avText("by_type", { list: types.map(([t, n]) => typeCount(t, n)).join(", ") })}</p> : null}
      {v.meetings_with_me !== null && v.meetings_with_me > 0 ? <p className="hint">{avText("meetings_with_me", { n: formatNumber(v.meetings_with_me) })}</p> : null}
    </Section>

    <Section id="agent-view-default" title={avText("default_title")} hint={avText("default_hint")}>
      <DefaultForm value={v.upload_default} />
    </Section>

    <Section id="agent-view-spaces" title={avText("spaces_title")} hint={avText("spaces_hint")}>
      {!v.spaces.length ? <p>{avText("spaces_empty")}</p> : <TableWrap cards><table className="board agent-view-spaces">
        <thead><tr><th>{avText("col_space")}</th><th>{avText("col_visible")}</th><th>{avText("col_hidden")}</th><th>{avText("col_default")}</th></tr></thead>
        <tbody>{v.spaces.map((s) => <tr key={s.slug}>
          <td data-label={avText("col_space")}><strong>{s.kind === "personal" ? avText("kind_personal") : s.name}</strong>
            <div className="muted small">{s.kind === "personal" ? s.name : spaceKindTitle(s.kind)}{s.archived ? <> · <Badge tone="neutral">{avText("archived")}</Badge></> : null}</div></td>
          <td data-label={avText("col_visible")}>{num(s.open)}</td>
          <td data-label={avText("col_hidden")}>{num(s.hidden_mine)}</td>
          <td data-label={avText("col_default")}>{classTitle(s.default_class)}</td>
        </tr>)}</tbody>
      </table></TableWrap>}
    </Section>
  </>;
}
