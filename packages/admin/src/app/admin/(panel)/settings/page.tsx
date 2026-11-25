import { PAGE_TEXT } from "@/messages/panel-settings";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { LoadError, Section } from "@/components/ui";
import { tryGw } from "@/lib/api";
import { compareText } from "@/i18n/format";
import { CATEGORY_HINTS, CATEGORY_TITLES } from "@/lib/labels";
import { param, type SearchParams } from "@/lib/paging";
import { OWN_PAGES, OWNED_ELSEWHERE, settingHref, settingLabel, settingOptions, settingsIndex, settingsTabOf } from "@/lib/setting-labels";
import { CATEGORY_ORDER, type Category, type SettingsResponse } from "@/lib/types";
import { ActionForm } from "@/components/action-form";
import { SettingsSearch } from "@/components/settings-search";
import { checkConverterAction, clearRequiredAction, saveCategoryAction } from "./actions";
import { SettingsForm, type SettingView } from "./settings-form";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.title }; }

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const asked = param(sp, "cat") as Category;
  if (OWN_PAGES[asked]) redirect(OWN_PAGES[asked]!.href);
  const res = await tryGw<SettingsResponse>("/api/v1/admin/settings");
  const sectionTitles: Record<string, string> = { search: PAGE_TEXT.ranking };

  const missing = res.ok ? res.data.missing_required : [];
  const titleOf = (c: Category) => CATEGORY_TITLES[c] ?? c;
  const categories: Category[] = orderCategories(res.ok ? res.data.items.map((i) => i.category).filter((c) => !OWN_PAGES[c]) : []);
  const tabs: Category[] = orderCategories(categories.map(settingsTabOf));
  const inTab = (t: Category) => categories.filter((c) => settingsTabOf(c) === t);
  const missingBy = (t: Category) => missing.filter((m) => inTab(t).some((c) => m.startsWith(`${c}.`))).length;
  const askedTab = settingsTabOf(asked);
  const active: Category = tabs.includes(askedTab) ? askedTab : tabs.find((t) => missingBy(t) > 0) ?? tabs[0] ?? "models";
  const sections = inTab(active);

  const itemsOf = (c: Category): SettingView[] => res.ok
    ? res.data.items.filter((i) => i.category === c).map((i) => {
        const elsewhere = OWNED_ELSEWHERE.get(`${c}.${i.key}`), options = settingOptions(c, i.key);
        const x = i as typeof i & { class?: SettingView["policyClass"]; pinned?: boolean; db_differs?: boolean; weaken_needs_approval?: boolean };
        const pinnedRo = x.pinned && !i.secret ? { href: "/admin/anchors", page: PAGE_TEXT.anchors } : null;
        const ro = elsewhere ? { href: elsewhere.href, page: elsewhere.page } : pinnedRo;
        return { key: i.key, value: i.secret ? null : i.value, secret: i.secret, required: i.required, description: i.description, isSet: i.isSet,
                 label: settingLabel(c, i.key), ...(options ? { options } : {}), ...(ro ? { readOnly: ro } : {}),
                 ...(x.class ? { policyClass: x.class } : {}), ...(x.pinned ? { pinned: true } : {}), ...(x.db_differs ? { dbDiffers: true } : {}),
                 ...(x.weaken_needs_approval ? { weakenNeedsApproval: true } : {}) };
      })
    : [];
  const index = res.ok ? settingsIndex(res.data.items, titleOf) : [];
  const query = param(sp, "q");
  const pathLabel = (m: string) => { const dot = m.indexOf("."); return settingLabel(m.slice(0, dot), m.slice(dot + 1)); };
  const pathHref = (m: string) => { const dot = m.indexOf("."); return settingHref(m.slice(0, dot), m.slice(dot + 1)); };

  return (
    <PageFrame title={PAGE_TEXT.title} lead={PAGE_TEXT.lead}>
      {!res.ok ? <LoadError result={res} what={PAGE_TEXT.loadWhat} /> : (
        <>
          {missing.length ? (
            <div className="notice danger" role="alert">
              <strong>{PAGE_TEXT.missingTitle(missing.length)}</strong>{" "}
              {missing.map((m, n) => (
                <span key={m}>{n ? ", " : ""}<a href={pathHref(m)} title={m}>{pathLabel(m)}</a></span>
              ))}
              {PAGE_TEXT.missingHint}
            </div>
          ) : null}

          <SettingsSearch index={index} initial={query} />

          <nav className="tabs" aria-label={PAGE_TEXT.sections}>
            {tabs.map((t) => (
              <Link key={t} prefetch={false} href={`/admin/settings?cat=${t}`} className={t === active ? "on" : undefined} aria-current={t === active ? "page" : undefined}>
                {titleOf(t)}
                {missingBy(t) ? <span className="cnt" title={PAGE_TEXT.missingBadge}>{missingBy(t)}</span> : null}
              </Link>
            ))}
          </nav>

          {sections.map((c) => {
            const items = itemsOf(c);
            const title = sections.length > 1 ? sectionTitles[c] ?? titleOf(c) : titleOf(c);
            return (
              <Section key={c} id={`cat-${c}`} title={title} hint={CATEGORY_HINTS[c] ?? PAGE_TEXT.unknownSection}>
                {items.length
                  ? <SettingsForm key={c} category={c} title={title} items={items} action={saveCategoryAction} clearAction={clearRequiredAction} />
                  : <p className="empty">{PAGE_TEXT.empty}</p>}
              </Section>
            );
          })}

          {sections.includes("integrations") && itemsOf("integrations").some((i) => i.key === "converter_url") ? (
            <Section title={PAGE_TEXT.converter} hint={rich(PAGE_TEXT.converterHint, {
              upload: (c) => <code className="code">{c}</code>, export: (c) => <code className="code">{c}</code>,
            })}>
              <ActionForm action={checkConverterAction} submitLabel={PAGE_TEXT.checkConverter} pendingLabel={PAGE_TEXT.checking} quiet>
                <p className="hint">{PAGE_TEXT.converterCheckHint}</p>
              </ActionForm>
            </Section>
          ) : null}
        </>
      )}
    </PageFrame>
  );
}

function orderCategories(all: string[]): Category[] {
  const known = CATEGORY_ORDER as readonly string[];
  const uniq = Array.from(new Set(all.filter(Boolean)));
  return uniq.sort((a, b) => {
    const ia = known.indexOf(a), ib = known.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return compareText(a, b);
  });
}
