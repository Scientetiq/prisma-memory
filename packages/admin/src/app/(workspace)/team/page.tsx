import { rich } from "@/i18n/rich";

import { texts as M } from "@/messages/ws-team";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/icons";
import { SpaceCard } from "@/components/space-card";
import { Empty, PageHead } from "@/components/ui";
import { isSlug } from "@/lib/form";
import { requireWorkspace } from "@/lib/me";
import { param, type SearchParams } from "@/lib/paging";
import { SECTION_TITLES } from "@/lib/plain";
import { myTeams } from "@/lib/spaces";

export function generateMetadata(): Metadata { return { title: M.metadataTitle }; }

export default async function TeamPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const asked = param(sp, "space").toLowerCase();
  if (asked && isSlug(asked)) redirect(`/projects/${encodeURIComponent(asked)}`);
  const teams = myTeams(me.spaces);
  if (teams.length === 1) redirect(`/projects/${encodeURIComponent(teams[0]!.slug)}`);
  const org = me.spaces.find((s) => s.kind === "org" && s.role === "owner") ?? null;
  const preview = Boolean(session.preview);

  if (!teams.length && !org) {
    return (
      <>
        <PageHead title={M.myTeam2} />
        <Empty icon="network" action={<Link href="/browse" prefetch={false} className="btn"><Icon name="layers" />{M.spacesAndProjects}</Link>}>{rich(M.youDoNotOwnAnyTeamLine, null)}</Empty>
      </>
    );
  }
  return (
    <>
      <PageHead title={teams.length ? M.myTeams : org!.name}
        lead={teams.length ? M.teamSpacesYouManageRecordsMembersAnd : M.youAreACompanyKnowledgeCurator} />
      {teams.length ? (
        <div className="sc-grid">{teams.map((s) => <SpaceCard key={s.slug} s={s} preview={preview} />)}</div>
      ) : null}
      {org ? (
        <section className="sp-group" aria-labelledby="team-org">
          {teams.length ? <h2 className="sp-group-title" id="team-org">{rich(M.youAreACuratorLine, { tag1: () => <Icon name="globe" /> })}</h2> : <h2 className="vis-hidden" id="team-org">{M.youAreACurator2}</h2>}
          <div className="sc-grid">
            <SpaceCard s={org} preview={preview} href={`/browse?path=${encodeURIComponent("/org")}`}
              note={preview ? null : <Link href="/review" prefetch={false} className="above">{rich(M.recordsAwaitingACuratorSDecisionLine, { tag1: () => <Icon name="chevron" /> }, { value1: SECTION_TITLES.review })}</Link>} />
          </div>
        </section>
      ) : null}
    </>
  );
}
