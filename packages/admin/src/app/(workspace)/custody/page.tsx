import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { Empty, LoadError, Notice, PageHead, Section } from "@/components/ui";
import { custodyHref, custodyPersonCard, custodyRefusal } from "@/lib/custody-read";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { CUSTODY_PLAIN, SECTION_TITLES } from "@/lib/plain";
import type { CustodyPeople } from "@/lib/types";
import { WS_CUSTODY_MESSAGES } from "@/messages/ws-custody";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.custody }; }

export default async function CustodyPage() {
  const { session } = await requireWorkspace();
  const res = await meGw<CustodyPeople>(session.key, "/api/v1/me/custody");
  const refusal = res.ok ? null : custodyRefusal(res);
  return (
    <>
      <PageHead title={SECTION_TITLES.custody} lead={CUSTODY_PLAIN.lead} />
      {res.ok ? (
        !res.data.items.length ? <Empty icon="archive">{CUSTODY_PLAIN.empty}</Empty> : (
          <Section title={SECTION_TITLES.custody} icon="archive">
            <ul className="trash-list custody-people">
              {res.data.items.map((p) => {
                const card = custodyPersonCard(p);
                return (
                  <li key={p.slug} className="trash-card">
                    <div className="trash-main">
                      <p className="trash-title"><Link href={custodyHref(p.slug)} prefetch={false}><strong>{card.title}</strong></Link></p>
                      <p className="trash-meta"><span className="trash-kind"><Icon name="user" />{card.basis}</span><span>{card.count}</span></p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Section>
        )
      ) : refusal!.off ? <Notice tone="info">{refusal!.text}</Notice> : <LoadError result={res} what={WS_CUSTODY_MESSAGES.recordsHandedOver} />}
    </>
  );
}
