import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Block } from "@/components/block";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { ProfileSectionsList } from "@/components/public-profile";
import { Notice, PageHead } from "@/components/ui";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { memoryLinkTarget } from "@/lib/memory-link";
import {
  BASE_FIELD, BASE_PUBLIC_FIELD, baseField, extendedNote, HISTORY_CURSOR, HISTORY_PAGE, historyCursor, historyLine, historyPath, MY_PROFILE_API, MY_PROFILE_HREF, OVERWRITE_FIELD,
  PENDING_FIELD, previewKind, profileState, publicButEmpty, sectionChars, sectionField, sectionMeta,
} from "@/lib/my-profile";
import { param, type SearchParams } from "@/lib/paging";
import { PROFILE_PLAIN } from "@/lib/plain";
import { dayWords } from "@/lib/record-view";
import type { MyProfile, MyProfileHistory } from "@/lib/types";
import { isPublicSection, PROFILE_SECTION_TITLES, PROFILE_SECTIONS, PUBLIC_SECTIONS } from "@/lib/work-profile";
import { saveProfileAction } from "./actions";

export function generateMetadata(): Metadata { return { title: PROFILE_PLAIN.title }; }

const BEFORE = memoryLinkTarget("me", ["profile"]);

export default async function MyProfilePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session } = await requireWorkspace();
  if (session.preview) redirect(BEFORE);
  const sp = await searchParams;
  const st = profileState(await meGw<MyProfile>(session.key, MY_PROFILE_API));
  if (st.kind === "off") redirect(BEFORE);
  if (st.kind === "failed") {
    return (
      <>
        <PageHead title={PROFILE_PLAIN.title} lead={PROFILE_PLAIN.lead} />
        <Notice tone="danger"><strong>{PROFILE_PLAIN.failed}.</strong> {st.message}</Notice>
      </>
    );
  }
  const p = st.data;
  const hcur = historyCursor(param(sp, HISTORY_CURSOR));
  const hist = p.id ? await meGw<MyProfileHistory>(session.key, historyPath(hcur)) : null;
  const chars = sectionChars(p.limits);
  const flags = !p.hidden;
  const seen = PUBLIC_SECTIONS.filter((s) => p.public_preview?.sections?.[s]);
  const preview = previewKind(p);
  const items = hist?.ok ? hist.data.items : [];

  return (
    <>
      <PageHead title={PROFILE_PLAIN.title} lead={PROFILE_PLAIN.lead} />
      {p.hidden ? (
        <Notice tone="warn">
          {PROFILE_PLAIN.hidden}{p.id ? <> <Link href={`/records/${p.id}`} prefetch={false}>{PROFILE_PLAIN.hiddenLink}</Link></> : null}
        </Notice>
      ) : !p.id ? <Notice tone="info">{PROFILE_PLAIN.noProfile}</Notice> : null}

      <Block id="sections" icon="pencil" title={PROFILE_PLAIN.sectionsTitle} hint={PROFILE_PLAIN.rules} className="pf-card">
        <ActionForm action={saveProfileAction} submitLabel={PROFILE_PLAIN.save} pendingLabel={PROFILE_PLAIN.saving} ask={{ name: OVERWRITE_FIELD, label: PROFILE_PLAIN.overwrite }}>
          <input type="hidden" name={BASE_FIELD} value={baseField(p)} />
          {flags ? (
            <>
              <input type="hidden" name="pub" value="1" />
              <input type="hidden" name={BASE_PUBLIC_FIELD} value={p.public.join(",")} />
              {preview === "pending" ? <input type="hidden" name={PENDING_FIELD} value="1" /> : null}
            </>
          ) : null}
          <input type="hidden" name="seen" value={seen.join(",")} />
          <div className="pf-list">
            {PROFILE_SECTIONS.map((s) => {
              const v = p.sections[s], meta = sectionMeta(v), ext = extendedNote(s, p);
              const help = `pf-${s}-help`;
              return (
                <fieldset key={s} id={s} className="pf-sec">
                  <legend className="pf-title">{PROFILE_SECTION_TITLES[s]}</legend>
                  <p className="pf-help" id={help}>{PROFILE_PLAIN.sectionHints[s]}</p>
                  <textarea name={sectionField(s)} aria-label={PROFILE_SECTION_TITLES[s]} aria-describedby={help} rows={s === "agent" ? 3 : 4}
                    maxLength={chars} defaultValue={v?.text ?? ""} />
                  <div className="pf-foot">
                    <span className={meta?.stale ? "pf-meta warn-text" : "pf-meta"}>{meta ? meta.text : PROFILE_PLAIN.empty} · {PROFILE_PLAIN.limit(chars)}</span>
                    {s === "agent" ? <span className="pf-meta">{PROFILE_PLAIN.agentOnly}</span>
                      : flags && isPublicSection(s) ? (
                        <label className="check pf-public"><input type="checkbox" name="public" value={s} defaultChecked={p.public.includes(s)} /> {PROFILE_PLAIN.showColleagues}</label>
                      ) : null}
                  </div>
                  {publicButEmpty(s, p) ? <p className="pf-meta">{PROFILE_PLAIN.publicEmpty}</p> : null}
                  {ext ? <p className="pf-meta warn-text">{ext}</p> : null}
                </fieldset>
              );
            })}
          </div>
          {flags ? null : <p className="hint">{PROFILE_PLAIN.hiddenFlags}</p>}
        </ActionForm>
      </Block>

      <Block id="colleagues" icon="users" title={PROFILE_PLAIN.previewTitle} hint={PROFILE_PLAIN.previewHint}>
        {p.hidden ? <p className="sp-line">{PROFILE_PLAIN.hiddenFlags}</p>
          : preview === "shown" ? (
            <>
              <ProfileSectionsList sections={p.public_preview.sections} />
              {p.public_preview.updated_at ? <p className="pf-meta">{PROFILE_PLAIN.updated(dayWords(p.public_preview.updated_at), null)}</p> : null}
            </>
          ) : <p className="sp-line">{preview === "pending" ? PROFILE_PLAIN.previewPending : preview === "unfilled" ? PROFILE_PLAIN.previewUnfilled : PROFILE_PLAIN.previewEmpty}</p>}
      </Block>

      {p.id ? (
        <Block id="history" icon="history" title={PROFILE_PLAIN.historyTitle} hint={PROFILE_PLAIN.historyHint}>
          {hist && !hist.ok ? <p className="sp-line">{PROFILE_PLAIN.historyFailed}: {hist.message}</p>
            : !items.length ? <p className="sp-line">{PROFILE_PLAIN.historyEmpty}</p>
            : (
              <ul className="pf-history">
                {items.map((it) => (
                  <li key={it.id} className="pf-hrow">
                    <span className="pf-hmain">
                      <span><b>{PROFILE_PLAIN.historyVersion(it.version)}</b> · <LocalTime iso={it.at} short /></span>
                      {historyLine(it) ? <small>{historyLine(it)}</small> : null}
                    </span>
                    <Link href={`/records/${it.id}`} prefetch={false} className="sp-link pf-hopen">{PROFILE_PLAIN.historyOpen}</Link>
                  </li>
                ))}
              </ul>
            )}
          {hist?.ok && (hcur || hist.data.next_cursor) ? (
            <CursorPager path={MY_PROFILE_HREF} params={hcur ? { [HISTORY_CURSOR]: hcur } : {}} cursorName={HISTORY_CURSOR} cursor={hcur}
              nextCursor={hist.data.next_cursor} prevCursor={hcur ? String(Math.max(0, Number(hcur) - HISTORY_PAGE)) : undefined}
              shown={items.length} anchor="history" noun={PROFILE_PLAIN.historyNoun} />
          ) : null}
        </Block>
      ) : null}
    </>
  );
}
