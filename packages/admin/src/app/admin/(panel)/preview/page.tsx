import { rich } from "@/i18n/rich";
import { PERSONAS, TEXT } from "@/messages/panel-preview";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Code, Notice, Section } from "@/components/ui";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { ACCESS_ACTION, CLOSED_CLASS_TEXT } from "@/lib/closed-class";
import { DEMO_PEOPLE, DEMO_SAMPLES, DEMO_SPACE, DEMO_UNIT, type DemoRole } from "@/lib/demo";
import { param, type SearchParams } from "@/lib/paging";
import { PREVIEW_OPS } from "@/lib/preview";
import { createShowcaseAction, findDemoPeople, rebuildShowcaseAction, switchViewAction } from "./actions";

export function generateMetadata(): Metadata { return { title: TEXT.preview }; }



const closedSamples = () => DEMO_SAMPLES.filter((s) => s.space === "me").length;
const closedByRole = (role: DemoRole) => DEMO_SAMPLES.filter((s) => s.space === "me" && s.who === role).length;

export default async function PreviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const missing = param(sp, "missing"), error = param(sp, "error"), expired = param(sp, "expired") === "1", unavailable = param(sp, "unavailable") === "1";
  const people = await findDemoPeople();
  const ready = Boolean(people.head && people.employee);

  return (
    <PageFrame title={TEXT.preview} lead={TEXT.openTheWorkspaceAsADemoEmployeeOr}>
      {expired ? <Notice tone="warn">{TEXT.previewExpiredItLastsNoMoreThanAn}</Notice> : null}
      {unavailable ? <Notice tone="warn">{rich(TEXT.memoryIsNotRespondingSoTheWorkspacePreview, { v0: () => (<Link href="/">{TEXT.returnToPreview}</Link>) })}</Notice> : null}
      {missing ? <Notice tone="warn">{rich(TEXT.theRoleHasNoDemoPersonaYetCreate, { v0: () => (missing === "head" ? TEXT.head : TEXT.employee) })}</Notice> : null}
      {error ? <Notice tone="danger">{rich(TEXT.previewCouldNotOpen, { v0: () => (error) })}</Notice> : null}

      <Section title={TEXT.demoPersonas} hint={<>{rich(TEXT.twoFictionalPeopleInTheDemoDepartmentAnd, { v0: () => (DEMO_UNIT.name), v1: () => (DEMO_SAMPLES.length) })}</>}>
        <div className="persona-grid">
          {PERSONAS.map((p) => {
            const person = people[p.role];
            return (
              <div className="card" key={p.role}>
                <div className="head"><span className="ttl">{p.title}</span>{person ? <Badge tone="ok">{TEXT.ready}</Badge> : <Badge tone="muted">{TEXT.noPersona}</Badge>}</div>
                <div className="body">
                  <p>{p.what}</p>
                  <div className="kv"><span>{TEXT.login}</span><Code>{DEMO_PEOPLE[p.role].login}</Code></div>
                  <div className="kv"><span>{TEXT.name}</span><span>{person?.display_name ?? DEMO_PEOPLE[p.role].display_name}</span></div>
                  <div className="kv"><span>{TEXT.closedRecords}</span><span className="hidden-count">{closedByRole(p.role)}</span></div>
                  {person ? (
                    <form action={switchViewAction} className="form-inline-actions">
                      <input type="hidden" name="view" value={p.role} />
                      <button type="submit" className="btn primary">{p.open}</button>
                    </form>
                  ) : <p className="hint">{TEXT.createTheShowcaseBelowFirst}</p>}
                </div>
              </div>
            );
          })}
          <div className="card">
            <div className="head"><span className="ttl">{TEXT.auditor}</span><Badge tone="muted">{TEXT.menuPreview}</Badge></div>
            <div className="body">
              <p>{TEXT.thePanelAsSeenByASecurityAuditor}</p>
              <p className="hint">{rich(TEXT.aRealSecurityAuditorHasTheGatewayRole, { v0: () => (<code className="code">security_auditor</code>) })}</p>
              <form action={switchViewAction} className="form-inline-actions">
                <input type="hidden" name="view" value="auditor" />
                <button type="submit" className="btn">{TEXT.previewAuditorMenu}</button>
              </form>
            </div>
          </div>
        </div>
      </Section>

      <Section title={TEXT.showcaseMaintenance} hint={ready ? TEXT.demoPersonasExistCompleteAddsMissingSampleRecords : TEXT.noShowcaseYetCreateOneToAddDemo}>
        <ActionForm action={createShowcaseAction} submitLabel={ready ? TEXT.completeShowcase : TEXT.createShowcase} pendingLabel={TEXT.creatingShowcase} quiet={ready}>
          <span />
        </ActionForm>
        {ready ? (
          <div className="action-with-note">
            <ActionForm action={rebuildShowcaseAction} submitLabel={TEXT.rebuildShowcase} pendingLabel={TEXT.rebuilding} danger
              confirm={TEXT.deleteAllDemoPersonaRecordsAndWriteThe}>
              <span />
            </ActionForm>
            <p className="hint">{TEXT.rebuildMovesBothDemoPersonasRecordsToTrash}</p>
          </div>
        ) : null}
      </Section>

      <details className="how-details">
        <summary>{TEXT.howItWorks}</summary>
        <Notice tone="info">{rich(TEXT.previewKeysLikeAllPersonalKeysAreT2, { v0: () => (<strong>{TEXT.whatPreviewShowsAndHides}</strong>), v1: () => (<Code>{DEMO_SPACE.slug}</Code>), v2: () => (closedSamples()), v3: () => (CLOSED_CLASS_TEXT.closedHiddenLabel), v4: () => (ACCESS_ACTION.show) })}</Notice>
        <ul className="plain">
          <li>{rich(TEXT.theShowcaseConsistsOfDemoDepartmentTwoPeople, { v0: () => (<Code>{DEMO_UNIT.code}</Code>), v1: () => (<code className="code">attrs.demo = true</code>), v2: () => (<code className="code">PUT /admin/people</code>), v3: () => (<Code>{DEMO_SPACE.slug}</Code>), v4: () => (DEMO_SAMPLES.length), v5: () => (<code className="code">memory_remember</code>), v6: () => (<code className="code">memory_upload</code>) })}</li>
          <li>{rich(TEXT.whenOpeningTheWorkspaceTheGatewayIssuesThe, { v0: () => (<code className="code">preview</code>), v1: () => (<Code>{TEXT.operationsList(PREVIEW_OPS)}</Code>), v2: () => (<Link href="/">{TEXT.workspace}</Link>) })}</li>
          <li>{rich(TEXT.previewHidesAndRejectsRememberFileUploadsDelete, { v0: () => (ACCESS_ACTION.show) })}</li>
          <li>{TEXT.aYouAreViewingAsBannerAtThe}</li>
          <li>{rich(TEXT.everythingInPreviewRunsAsTheDemoPersona, { v0: () => (<code className="code">panel-preview</code>), v1: () => (<code className="code">details.preview</code>) })}</li>
          <li>{TEXT.auditorModePreviewsThePanelMenuTheSession}</li>
        </ul>
      </details>
    </PageFrame>
  );
}
