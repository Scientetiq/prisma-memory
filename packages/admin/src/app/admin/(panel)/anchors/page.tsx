import { PAGE_TEXT, KIND_TITLES, DRAFT_ERRORS } from "../../../../messages/panel-anchors";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { Badge, Chips, Empty, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { param, type SearchParams } from "@/lib/paging";
import { readSession } from "@/lib/session";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.trustAnchors }; }

interface AnchorsStatus {
  in_force: boolean;
  documents: Array<{ kind: "edge" | "inner"; serial: number; applied_at: string; signers?: string[] }>;
  policy_sha256_ok?: boolean | null;
  unpinned?: string[];
}


export default async function AnchorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(true);
  const sp = await searchParams;
  const [res, session] = await Promise.all([tryGw<AnchorsStatus>("/api/v1/admin/anchors"), readSession()]);
  const draftError = DRAFT_ERRORS[param(sp, "draft_error")];
  return (
    <PageFrame title={PAGE_TEXT.trustAnchors2} lead={PAGE_TEXT.lead} allowAuditor>
      {!res.ok ? <LoadError result={res} what={PAGE_TEXT.anchorStatus} /> : (
        <>
          <Section title={PAGE_TEXT.status} icon="shield">
            {res.data.in_force ? (
              <Notice tone={res.data.policy_sha256_ok === false ? "danger" : "ok"} role="status">
                <p>{rich(PAGE_TEXT.tag1AnchorsAreInForceTag1Value2, { tag1: (children) => <strong>{children}</strong> }, { value2: res.data.policy_sha256_ok === false
                  ? PAGE_TEXT.theSettingsPolicyFileDoesNotMatchTheSigned
                  : PAGE_TEXT.theSettingsPolicyFileMatchesTheSignedFile })}</p>
              </Notice>
            ) : (
              <Notice tone="info" role="status"><p>{rich(PAGE_TEXT.inactiveAnchors, { tag1: (children) => <strong>{children}</strong> }, null)}</p></Notice>
            )}
            {res.data.unpinned?.length ? (
              <Notice tone="warn" role="status">
                <p>{PAGE_TEXT.unpinnedSettings}</p>
                <Chips items={res.data.unpinned} />
              </Notice>
            ) : null}
          </Section>
          <Section title={PAGE_TEXT.appliedDocuments}>
            {!res.data.documents.length ? <Empty icon="circle-check">{PAGE_TEXT.noAnchorsHaveBeenAppliedYet}</Empty> : (
              <TableWrap cards>
                <table className="board">
                  <thead><tr><th>{PAGE_TEXT.document}</th><th>{PAGE_TEXT.serial}</th><th>{PAGE_TEXT.applied}</th><th>{PAGE_TEXT.signers}</th></tr></thead>
                  <tbody>
                    {res.data.documents.map((d) => (
                      <tr key={`${d.kind}-${d.serial}`}>
                        <td data-label={PAGE_TEXT.document2}>{KIND_TITLES[d.kind] ?? d.kind}</td>
                        <td data-label={PAGE_TEXT.serial2}><Badge tone="neutral">№ {d.serial}</Badge></td>
                        <td data-label={PAGE_TEXT.applied2}><LocalTime iso={d.applied_at} /></td>
                        <td data-label={PAGE_TEXT.signers2}>{(d.signers ?? []).map((s) => <div key={s}>{rich(PAGE_TEXT.tag1Value2Tag1, { tag1: (children) => <code className="code" title={PAGE_TEXT.signerKeyFingerprint}>{children}</code> }, { value2: s })}</div>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Section>
          <Section title={PAGE_TEXT.newDocumentForSigning} hint={PAGE_TEXT.theDraftUsesTheCurrentStatePinnedAnchorSettings}>
            {draftError ? <Notice tone="danger" role="alert">{draftError}</Notice> : null}
            {session?.role === "security_auditor" ? <p className="hint">{PAGE_TEXT.aMemoryAdministratorPreparesTheDraft}</p> : (
              <a className="btn" href="/admin/anchors/draft" download>{PAGE_TEXT.downloadTrustAnchorsInnerJsonDraft}</a>
            )}
          </Section>
        </>
      )}
    </PageFrame>
  );
}
