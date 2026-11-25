import { Block } from "./block";
import { shownSections } from "@/lib/my-profile";
import { PROFILE_PLAIN } from "@/lib/plain";
import { dayWords } from "@/lib/record-view";
import type { PublicProfile, PublicProfileSection, WorkProfilePublicSection } from "@/lib/types";

export function ProfileSectionsList({ sections }: { sections: Partial<Record<WorkProfilePublicSection, PublicProfileSection>> }) {
  const rows = shownSections(sections);
  if (!rows.length) return null;
  return (
    <dl className="pf-shown">
      {rows.map((r) => (
        <div key={r.s} className="pf-shown-row">
          <dt>{r.title}</dt>
          <dd>{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PublicProfileBlock({ p, now }: { p: PublicProfile | null; now?: Date }) {
  if (!p || !shownSections(p.sections).length) return null;
  return (
    <Block id="about" icon="user" title={PROFILE_PLAIN.aboutTitle} hint={PROFILE_PLAIN.aboutHint(dayWords(p.updated_at, now))} className="pf-about">
      <ProfileSectionsList sections={p.sections} />
    </Block>
  );
}
