import type { Metadata } from "next";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { param, slicePage, type SearchParams } from "@/lib/paging";
import { formatNumber } from "@/i18n/format";
import { models as t } from "@/messages/m-models";
import { ModelForm } from "./model-form";
import { ROLES, machineCode, roleSnapshot, type ModelRoleView, type Preset, type UsageResponse } from "./view";
import styles from "./models.module.css";

export function generateMetadata(): Metadata { return { title: t.title }; }

export default async function ModelsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const group = (["day", "role", "model", "stage"] as const).find((g) => g === param(sp, "group")) ?? "day";
  const now = Date.now(), from = new Date(now - 29 * 86400000).toISOString().slice(0, 10), to = new Date(now).toISOString().slice(0, 10);
  const [connections, catalog, usage] = await Promise.all([
    tryGw<{ roles: ModelRoleView[] }>("/api/v1/admin/models"),
    tryGw<{ presets: Preset[] }>("/api/v1/admin/models/presets"),
    tryGw<UsageResponse>("/api/v1/admin/models/usage", { query: { from, to, group } }),
  ]);
  const paged = slicePage(usage.ok ? usage.data.rows : [], param(sp, "page"), 10);
  const num = (value: string) => formatNumber(Number(value));
  const money = (value: string) => formatNumber(Number(value) / 1000000, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
  return <PageFrame title={t.title} lead={t.lead}>
    <nav className={styles.links} aria-label={t.advanced}>
      <a href="/admin/settings?cat=models">{t.advanced}</a><a href="/admin/anchors">{t.anchors}</a><a href="/admin/approvals">{t.approvals}</a>
    </nav>
    <p className="hint">{t.protections}</p>
    {!connections.ok || !catalog.ok ? <p role="alert">{t.loadFailed} · <code>{machineCode(!connections.ok ? connections.code : !catalog.ok ? catalog.code : null)}</code></p>
      : <div className={styles.cards}>{ROLES.map((role) => {
        const view = connections.data.roles.find((r) => r.role === role);
        return view ? <ModelForm key={roleSnapshot(view)} role={view} presets={catalog.data.presets} />
          : <section key={role} id={`model-${role}`}><h2>{t.roles[role]}</h2><p role="alert">{t.loadFailed}</p></section>;
      })}</div>}
    <section aria-labelledby="models-usage">
      <h2 id="models-usage">{t.usage}</h2>
      <p>{t.period(from, to)}</p><p className="hint">{t.usageHint}</p>
      <form className={styles.links} method="get">
        <label htmlFor="usage-group">{t.group}</label>
        <select id="usage-group" name="group" defaultValue={group}>{(["day", "role", "model", "stage"] as const).map((g) => <option key={g} value={g}>{t.groups[g]}</option>)}</select>
        <button type="submit">{t.apply}</button>
      </form>
      {!usage.ok ? <p role="alert">{t.loadFailed} · <code>{machineCode(usage.code)}</code></p> : <>
        {usage.data.budget ? <div>
          <p>{t.budget}: {usage.data.budget.enforced ? t.enforced : t.notEnforced}
            {usage.data.budget.unenforced ? <> · <code>{machineCode(usage.data.budget.unenforced)}</code></> : null}</p>
          {usage.data.budget.exhausted ? <p role="status">{t.exhausted}: <code>{usage.data.budget.exhausted}</code></p> : null}
          {usage.data.budget.warning ? <p>{t.warning}: <code>{usage.data.budget.warning}</code></p> : null}
          <p>{t.spentDay}: {formatNumber(usage.data.budget.spent_day)} · {t.spentMonth}: {formatNumber(usage.data.budget.spent_month)}</p>
        </div> : <p>{t.budget}: {t.unknown}</p>}
        {!paged.total ? <p>{t.emptyUsage}</p> : <>
          <div className={styles.table} tabIndex={0} role="region" aria-label={t.usage}>
            <table><caption>{t.usage}</caption><thead><tr>
              <th scope="col">{t.groups[group]}</th><th scope="col">{t.calls}</th><th scope="col">{t.input}</th>
              <th scope="col">{t.cached}</th><th scope="col">{t.output}</th><th scope="col">{t.search}</th>
              <th scope="col">{t.cost}</th><th scope="col">{t.unpriced}</th><th scope="col">{t.estimated}</th>
            </tr></thead><tbody>{paged.items.map((row, i) => <tr key={i}>
              <th scope="row">{row.group_key}</th><td>{num(row.calls)}</td><td>{num(row.input_tokens)}</td>
              <td>{num(row.cached_input_tokens)}</td><td>{num(row.output_tokens)}</td><td>{num(row.search_units)}</td>
              <td>{money(row.cost_micros)}</td><td>{num(row.unpriced_calls)}</td><td>{num(row.estimated_calls)}</td>
            </tr>)}</tbody></table>
          </div>
          <nav className={styles.links} aria-label={t.usage}>
            {paged.page > 1 ? <a href={`/admin/models?group=${group}&page=${paged.page - 1}`}>{t.previous}</a> : null}
            <span>{t.pages(paged.page, paged.pages)}</span>
            {paged.page < paged.pages ? <a href={`/admin/models?group=${group}&page=${paged.page + 1}`}>{t.next}</a> : null}
          </nav>
        </>}
      </>}
    </section>
  </PageFrame>;
}
