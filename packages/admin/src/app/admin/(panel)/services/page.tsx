import { servicesPage as m } from "@/messages/panel-services";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { AdminTabs } from "@/components/admin-tabs";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { CursorPager } from "@/components/pager";
import { Badge, Chips, Code, Empty, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { issueKeyHref as issueHref, pickTab, SERVICES_TABS, tabHref } from "@/lib/admin-tabs";
import { tryGw } from "@/lib/api";
import { clientKindTitle, KEY_KIND_TITLES, SERVICE_KINDS, SERVICE_KIND_TITLES, SERVICE_OPS, TIERS } from "@/lib/labels";
import { isNetBound } from "@/lib/net-bound";
import { settingHref } from "@/lib/setting-labels";
import { offsetOf, PAGE_SIZE, param, type SearchParams } from "@/lib/paging";
import { formatDay } from "@/lib/plain";
import type { ApiKey, Page, Service, SettingsResponse } from "@/lib/types";
import { bindKeyAction, createServiceAction, createTranscriberAction, issueKeyAction, revokeKeyAction, setKeyOpenWriteAction, setServiceActiveAction, setServiceOboReadAction, setServiceWriteSpaceAction, unpauseKeyAction } from "./actions";
import { KeyForm, type KeyFormService } from "./key-form";

export function generateMetadata(): Metadata { return { title: m.servicesAndKeys }; }

const isPaused = (k: ApiKey): boolean => !k.revoked_at && !!k.paused_until && Date.parse(k.paused_until) > Date.now();
const isBound = (k: ApiKey): boolean => isNetBound(k.net_cidrs);
const cidrOf = (ip: string): string => `${ip}/${ip.includes(":") ? 128 : 32}`;

function keyStatus(k: ApiKey) {
  if (k.revoked_at) return <><Badge tone="muted">{m.revoked}</Badge><div className="cell-sub"><LocalTime iso={k.revoked_at} /></div></>;
  if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) return <Badge tone="warn">{m.expired}</Badge>;
  if (isPaused(k)) return <><Badge tone="warn" title={m.repeatedOnBehalfOfFailuresSeeAuthFailure}>{m.paused}</Badge><div className="cell-sub">{rich(m.until, null, { value: <LocalTime iso={k.paused_until!} relative={false} /> })}</div></>;
  return <Badge tone="ok">{m.active}</Badge>;
}

function OboKeysOff({ text }: { text: string }) {
  return <>{rich(text, { link1: (children) => <Link href={settingHref("access", "obo_service_keys")} prefetch={false}>{children}</Link> })}</>;
}

function keyOpenWrite(k: ApiKey) {
  if (k.kind !== "extended") return <span className="muted">—</span>;
  const on = k.open_write === true;
  return (
    <>
      {on ? <Badge tone="warn" title={m.openRecordsCreatedWithThisKeyAreMarked}>{m.allowed}</Badge> : <span className="muted">{m.no}</span>}
      {k.revoked_at ? null : on ? (
        <ActionForm action={setKeyOpenWriteAction} submitLabel={m.disallow} pendingLabel="…" compact quiet
          confirm={m.disallowOpenRecordsForKeyFromTheNext(k.key_prefix, k.principal ? ` (${k.principal})` : "")}>
          <input type="hidden" name="id" value={k.id} />
          <input type="hidden" name="open_write" value="false" />
        </ActionForm>
      ) : (
        <details>
          <summary>{m.allow}</summary>
          <ActionForm action={setKeyOpenWriteAction} submitLabel={m.allow2} pendingLabel="…" compact
            confirm={m.allowOpenRecordsForKeyTheAgentReads(k.key_prefix, k.principal ? ` (${k.principal})` : "")}>
            <input type="hidden" name="id" value={k.id} />
            <input type="hidden" name="open_write" value="true" />
            <input type="text" name="open_write_basis" required minLength={3} maxLength={500} placeholder={m.reasonRequestOrDecision} aria-label={m.reasonForPermission} />
          </ActionForm>
        </details>
      )}
    </>
  );
}

function keyAddress(k: ApiKey, obo: boolean) {
  const bound = isBound(k), keep = k.kind === "extended" || obo;
  return (
    <>
      {bound ? <Chips items={k.net_cidrs ?? []} empty="—" /> : obo && !k.revoked_at ? <Badge tone="warn" title={m.aLeakedOnBehalfOfKeyWorksFrom}>{m.unbound}</Badge> : <span className="muted">{m.any}</span>}
      {k.last_used_ip ? <div className="cell-sub">{rich(m.lastRequest, null, { value: <Code>{k.last_used_ip}</Code> })}</div> : null}
      {k.revoked_at ? null : !bound && k.last_used_ip ? (
        <ActionForm action={bindKeyAction} submitLabel={m.bindTo(k.last_used_ip)} pendingLabel="…" compact quiet
          confirm={m.bindKeyToAddressRequestsFromOtherAddresses(k.key_prefix, k.last_used_ip)}>
          <input type="hidden" name="id" value={k.id} />
          <input type="hidden" name="cidrs" value={cidrOf(k.last_used_ip)} />
        </ActionForm>
      ) : bound && keep ? (
        <div className="cell-sub muted" title={m.withoutAddressBindingALeakedKeyWouldWork}>{m.addressBindingRequired}</div>
      ) : bound ? (
        <ActionForm action={bindKeyAction} submitLabel={m.removeBinding} pendingLabel="…" compact quiet
          confirm={m.removeAddressBindingForKeyItWillBe(k.key_prefix)}>
          <input type="hidden" name="id" value={k.id} />
          <input type="hidden" name="cidrs" value="" />
        </ActionForm>
      ) : null}
    </>
  );
}

export default async function ServicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const tab = pickTab(param(sp, "tab"), SERVICES_TABS, "services");
  const scur = param(sp, "scur"), kcur = param(sp, "kcur"), principal = param(sp, "principal"), revoked = param(sp, "revoked") === "1";
  const params = { tab: tab === "services" ? "" : tab, scur, kcur, principal, revoked: revoked ? "1" : "" };
  const offset = offsetOf(kcur), sOffset = offsetOf(scur);

  const [services, active, keys, settings, pausedKeys] = await Promise.all([
    tab === "services" ? tryGw<Page<Service>>("/api/v1/admin/services", { query: { limit: PAGE_SIZE, cursor: sOffset || undefined } }) : null,
    tab === "issue" ? tryGw<Page<Service>>("/api/v1/admin/services", { query: { limit: 500, active: "true" } }) : null,
    tab === "keys" ? tryGw<Page<ApiKey>>("/api/v1/admin/keys", { query: { limit: PAGE_SIZE, cursor: offset || undefined, principal, include_revoked: revoked ? "true" : undefined } }) : null,
    tab === "issue" || tab === "services" ? tryGw<SettingsResponse>("/api/v1/admin/settings") : null,
    tryGw<Page<ApiKey>>("/api/v1/admin/keys", { query: { paused: "true", limit: 200 } }),
  ]);
  const oauthAgents = Boolean(settings?.ok && settings.data.items.some((i) => i.category === "oauth" && i.key === "enabled" && i.value === true));
  const oboKeys = Boolean(settings?.ok && settings.data.items.some((i) => i.category === "access" && i.key === "obo_service_keys" && i.value === true));
  const fingerprintOnly = Boolean(settings?.ok && settings.data.items.some((i) => i.category === "admin" && i.key === "service_keys_by_fingerprint" && i.value === true));
  const activeServices: KeyFormService[] = active?.ok
    ? active.data.items.map((s) => ({ name: s.name, kind: s.kind, write_space: s.write_space ?? null, obo_allowed: s.obo_allowed === true, obo_read: s.obo_read === true })) : [];
  const askedKind = param(sp, "kind");
  const isOboKey = (k: ApiKey): boolean => k.principal_type === "service" && k.service_obo === true;
  const paused = pausedKeys.ok ? pausedKeys.data.items.filter(isPaused) : [];
  const unbound = keys?.ok ? keys.data.items.filter((k) => !k.revoked_at && isOboKey(k) && !isBound(k)) : [];

  return (
    <PageFrame title={m.servicesAndKeys} lead={m.aServiceIsAnExternalSystemWithIts}
      actions={tab === "issue" ? undefined : <Link href={issueHref()} prefetch={false} className="btn primary">{m.issueAKey}</Link>}>
      {paused.length && tab !== "keys" ? (
        <Notice tone="warn" role="alert">{rich(m.pausedAfterRepeatedOnBehalfOfFailuresOpen(paused.length), { link1: (children) => <Link href={tabHref("/admin/services", "keys", "services", {}, "keys")} prefetch={false}>{children}</Link> })}</Notice>
      ) : null}
      <AdminTabs path="/admin/services" tabs={SERVICES_TABS} active={tab} fallback="services" label={m.servicesAndKeysSections}
        counts={{ keys: { n: paused.length, tone: "danger" } }} />
      {services ? <>
      <Section title={m.services} id="services">
        {!services.ok ? <LoadError result={services} what={m.services2} /> : !services.data.items.length ? <Empty icon="server">{scur ? m.thereAreNoServicesOnThisPage : m.noServicesYet}</Empty> : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead>
                  <tr><th>{m.name}</th><th>{m.status}</th><th><span className="vis-hidden">{m.actions}</span></th><th>{m.kind}</th><th>{m.tier}</th><th>{m.onBehalfOfPeople}</th><th>{m.readsOnBehalf}</th><th>{m.allowedOperations}</th><th>{m.writesOnlyTo}</th></tr>
                </thead>
                <tbody>
                  {services.data.items.map((s) => (
                    <tr key={s.id} className={s.active ? undefined : "off"}>
                      <td data-label={m.name}><Code>{s.name}</Code><div className="cell-sub">{rich(m.created, null, { value: <LocalTime iso={s.created_at} /> })}</div></td>
                      <td data-label={m.status}>{s.active ? <Badge tone="ok">{m.active2}</Badge> : <Badge tone="muted">{m.disabled}</Badge>}</td>
                      <td className="acts" data-label="">
                        {s.active ? <Link href={issueHref(s.name)} prefetch={false} className="btn sm">{m.issueAKey2}</Link> : null}
                        <ActionForm action={setServiceActiveAction} submitLabel={s.active ? m.disable : m.enable} pendingLabel="…" compact danger={s.active} quiet={!s.active}
                          confirm={s.active ? m.disableServiceItsKeysWillBeRevokedAnd(s.name) : undefined}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="active" value={s.active ? "false" : "true"} />
                        </ActionForm>
                      </td>
                      <td data-label={m.kind}>{SERVICE_KIND_TITLES[s.kind] ?? s.kind}</td>
                      <td data-label={m.tier}><Badge tone={s.tier === "T0" ? "neutral" : "warn"}>{s.tier}</Badge></td>
                      <td data-label={m.onBehalfOfPeople}>{s.obo_allowed ? <Badge tone="info" title={m.theServiceActsOnBehalfOfPeopleWhose}>{m.allowed2}</Badge> : <span className="muted">{m.no}</span>}</td>
                      <td data-label={m.readsOnBehalf}>
                        {!s.obo_allowed ? <span className="muted">—</span> : (
                          <>
                            {s.obo_read ? <Badge tone="info" title={m.searchReadAndListOnBehalfOfA}>{m.yes}</Badge> : <span className="muted">{m.noWriteAndIngestOnly}</span>}
                            {s.active && !s.obo_read && !oboKeys ? (
                              <div className="cell-sub muted"><OboKeysOff text={m.readingDisabled} /></div>
                            ) : s.active ? (
                              <ActionForm action={setServiceOboReadAction} submitLabel={s.obo_read ? m.disallow : m.allow2} pendingLabel="…" compact quiet
                                confirm={s.obo_read ? m.disallowSearchAndReadOnBehalfOfPeople(s.name) : m.allowServiceToSearchAndReadMemoryOn(s.name)}>
                                <input type="hidden" name="id" value={s.id} />
                                <input type="hidden" name="obo_read" value={s.obo_read ? "false" : "true"} />
                              </ActionForm>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td data-label={m.allowedOperations}><Chips items={s.allowed_ops} empty={m.none} /></td>
                      <td data-label={m.writesOnlyTo}>
                        {s.write_space ? (
                          <>
                            <Code>{s.write_space}</Code>
                            {s.active ? (
                              <ActionForm action={setServiceWriteSpaceAction} submitLabel={m.remove} pendingLabel="…" compact quiet
                                confirm={m.removeTheWriteSpaceForServiceItsMeetings(s.name)}>
                                <input type="hidden" name="id" value={s.id} />
                                <input type="hidden" name="write_space" value="" />
                              </ActionForm>
                            ) : null}
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/services" params={params} cursorName="scur" cursor={scur} nextCursor={services.data.next_cursor}
              prevCursor={sOffset ? String(Math.max(0, sOffset - PAGE_SIZE)) : null} shown={services.data.items.length} anchor="services" />
          </>
        )}
      </Section>

      <Section title={m.connectATranscriber} id="transcriber" hint={m.theTranscriberSSaveToMemoryButtonConnects}>
        <details className="how-details">
          <summary>{m.howToConnectATranscriber}</summary>
          <ol>
            <li>{m.enableIssueKeysToServicesActingOnBehalf}</li>
            <li>{m.forATestEnvironmentOnlyCreateATeam}</li>
            <li>{m.chooseTheEnvironmentHereAndClickCreateTranscriber}</li>
            <li>{m.issueAKeyToTheServiceUsingThe}</li>
            <li>{m.copyTheSecretNowAndGiveItTo}</li>
            <li>{m.clickCheckConnectionInTheTranscriberTheKey}</li>
          </ol>
        </details>
        {!oboKeys ? (
          <Notice tone="info"><OboKeysOff text={m.transcriberDisabled} /></Notice>
        ) : null}
        {oboKeys ? <ActionForm action={createTranscriberAction} submitLabel={m.createTranscriberService} pendingLabel={m.creating} resetOnSuccess quiet>
          <div className="form-grid">
            <div className="field">
              <span className="field-label">{m.environment}</span>
              <label className="check">{rich(m.productionMeetingsGoToTheirOwnersPersonalSpaces, null, { value: <input type="radio" name="variant" value="prod" defaultChecked /> })}</label>
              <label className="check">{rich(m.testMeetingsGoToOneSpaceOnly, null, { value: <input type="radio" name="variant" value="test" /> })}</label>
            </div>
            <Field label={m.serviceName}>
              <input type="text" name="name" defaultValue="transcriber" autoCapitalize="none" spellCheck={false} required />
            </Field>
            <Field label={m.writeSpaceForTestEnvironments} hint={m.teamSpaceSlugSuchAsTranscriberTestLeave}>
              <input type="text" name="write_space" placeholder={m.testSpaceExample} autoCapitalize="none" spellCheck={false} />
            </Field>
            <p className="field-hint field-wide">{m.theServiceWillReceiveAnInternalTrustTier}</p>
          </div>
        </ActionForm> : null}
      </Section>

      <Section title={m.newService} id="new-service" hint={m.useALatinScriptNameToSelectThe}>
        <ActionForm action={createServiceAction} submitLabel={m.createService} pendingLabel={m.creating} resetOnSuccess quiet>
          <div className="form-grid">
            <Field label={m.serviceName}>
              <input type="text" name="name" placeholder={m.forExampleTranscriberProd} autoCapitalize="none" spellCheck={false} required />
            </Field>
            <Field label={m.kind}>
              <select name="kind" defaultValue="other">
                {SERVICE_KINDS.map((k) => <option key={k} value={k}>{SERVICE_KIND_TITLES[k]}</option>)}
              </select>
            </Field>
            <Field label={m.trustTier} hint={m.tInternalEnvironmentTTrustedExternalProvider}>
              <select name="tier" defaultValue="T0">
                {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <div className="field">
              <span className="field-label">{m.actOnBehalfOfPeople}</span>
              <label className="check" title={m.xOnBehalfOfHeader}>{rich(m.allowActingOnBehalfOfPeople, null, { value: <input type="checkbox" name="obo_allowed" disabled={!oboKeys} /> })}</label>
              <label className="check">{rich(m.andReadingOnTheirBehalfSearchReadList, null, { value: <input type="checkbox" name="obo_read" disabled={!oboKeys} /> })}</label>
              <span className="field-hint">
                {oboKeys ? m.chatsAssistantsAndTranscribersNeedToActOn
                  : <OboKeysOff text={m.actingDisabled} />}
              </span>
            </div>
            <Field label={m.writesOnlyToSpace} hint={m.optionalATeamSpaceSlugEverythingTheService}>
              <input type="text" name="write_space" autoCapitalize="none" spellCheck={false} />
            </Field>
            <div className="field field-wide">
              <span className="field-label">{m.allowedOperations}</span>
              <div className="checks">
                {SERVICE_OPS.map((op) => <label className="check" key={op}><input type="checkbox" name="allowed_ops" value={op} /> <code className="code">{op}</code></label>)}
              </div>
            </div>
          </div>
        </ActionForm>
      </Section>

      </> : null}

      {keys ? <>
      {paused.length ? (
        <Notice tone="warn" role="alert">{rich(m.pausedRepeatedOnBehalfOfFailuresTheService(paused.length), { link1: (children) => <Link href="/admin/audit?event_type=auth_failure" prefetch={false}>{children}</Link> }, { value: paused.map((k) => `${k.key_prefix}…${k.principal ? ` (${k.principal})` : ""}`).join(", ") })}</Notice>
      ) : null}
      {unbound.length ? (
        <Notice tone="info" role="status">{rich(m.onBehalfOfServiceKeysWithoutAddressBinding, null, { value: unbound.length })}</Notice>
      ) : null}
      <Section title={m.keys4} id="keys" hint={m.onlyTheHashAndKeyPrefixAreStored}>
        <form method="get" action="/admin/services#keys" className="filter-form">
          <input type="hidden" name="tab" value="keys" />
          <label className="field">
            <span className="field-label">{m.owner}</span>
            <input type="search" name="principal" defaultValue={principal} placeholder={m.personSLoginOrServiceName} />
          </label>
          <label className="check">{rich(m.showRevokedKeys, null, { value: <input type="checkbox" name="revoked" value="1" defaultChecked={revoked} /> })}</label>
          <button type="submit" className="btn">{m.show}</button>
          {principal || revoked ? <Link href={tabHref("/admin/services", "keys", "services", {}, "keys")} prefetch={false} className="quiet">{m.reset}</Link> : null}
        </form>

        {!keys.ok ? <LoadError result={keys} what={m.keys3} /> : !keys.data.items.length ? (
          <>
            <Empty icon="key">{kcur ? m.thereAreNoKeysOnThisPage : principal ? m.thisOwnerHasNoKeys : m.noKeys}</Empty>
            {kcur ? <CursorPager path="/admin/services" params={params} cursorName="kcur" cursor={kcur} nextCursor={null} prevCursor={String(Math.max(0, offset - PAGE_SIZE))} shown={0} anchor="keys" /> : null}
          </>
        ) : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead>
                  <tr><th>{m.key2}</th><th>{m.status}</th><th><span className="vis-hidden">{m.actions}</span></th><th>{m.owner}</th><th>{m.tier}</th><th>{m.addresses}</th><th>{m.openRecords}</th><th>{m.dates}</th></tr>
                </thead>
                <tbody>
                  {keys.data.items.map((k) => (
                    <tr key={k.id} id={`key-${k.id}`} className={k.revoked_at ? "off" : undefined}>
                      <td data-label={m.key2}>
                        <Code title={k.id}>{k.key_prefix}…</Code> {KEY_KIND_TITLES[k.kind] ?? k.kind}
                        {k.client_label ? <div className="cell-sub">{rich(m.label, null, { value: k.client_label })}</div> : null}
                        {k.principal_type !== "person" || k.preview ? null : <div className="cell-sub">{rich(m.program, null, { value: clientKindTitle(k.client_kind ?? null) })}</div>}
                      </td>
                      <td data-label={m.status}>{keyStatus(k)}</td>
                      <td className="acts" data-label="">
                        {isPaused(k) ? (
                          <ActionForm action={unpauseKeyAction} submitLabel={m.clearPause} pendingLabel="…" compact quiet
                            confirm={m.clearThePauseForKeyIfOnBehalf(k.key_prefix)}>
                            <input type="hidden" name="id" value={k.id} />
                          </ActionForm>
                        ) : null}
                        {k.revoked_at ? null : (
                          <ActionForm action={revokeKeyAction} submitLabel={m.revoke} pendingLabel="…" compact danger
                            confirm={m.revokeKeyClientsUsingThisKeyWillLose(k.key_prefix, k.principal ? ` (${k.principal})` : "")}>
                            <input type="hidden" name="id" value={k.id} />
                          </ActionForm>
                        )}
                      </td>
                      <td data-label={m.owner}>{k.principal ? <Code>{k.principal}</Code> : <span className="muted">{m.instance}</span>}</td>
                      <td data-label={m.tier}>{k.tier}</td>
                      <td data-label={m.addresses}>{keyAddress(k, isOboKey(k))}</td>
                      <td data-label={m.openRecords}>{keyOpenWrite(k)}</td>
                      <td data-label={m.dates}>
                        <div className="cell-sub">{rich(m.issued, null, { value: <LocalTime iso={k.created_at} /> })}</div>
                        <div className="cell-sub">{k.last_used_at ? <>{rich(m.used, null, { value: <LocalTime iso={k.last_used_at} /> })}</> : m.neverUsed}</div>
                        <div className="cell-sub">{k.expires_at ? m.validThroughInclusive(formatDay(k.expires_at)) : m.noExpiry}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/services" params={params} cursorName="kcur" cursor={kcur} nextCursor={keys.data.next_cursor}
              prevCursor={offset ? String(Math.max(0, offset - PAGE_SIZE)) : null} shown={keys.data.items.length} anchor="keys" />
          </>
        )}
      </Section>

      </> : null}

      {active ? (
        <Section title={m.issueAKey3} id="issue" hint={m.theSecretWillAppearBelowTheFormOnce}>
          {!active.ok ? <LoadError result={active} what={m.services2} /> : null}
          <KeyForm services={activeServices} action={issueKeyAction} oauthAgents={oauthAgents} oboKeys={oboKeys} fingerprintOnly={fingerprintOnly}
            initialKind={askedKind} initialPrincipal={principal} />
        </Section>
      ) : null}
    </PageFrame>
  );
}
