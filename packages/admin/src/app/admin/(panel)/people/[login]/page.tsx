import { coreRoleName } from "@/messages/panel-roles";
import { personPage } from "@/messages/panel-people";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { PersonSuggest } from "@/components/person-suggest";
import { guardAuditorPage } from "@/lib/admin-guard";
import { Badge, Chips, Code, Empty, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { issueKeyHref, SPACE_TABS, tabHref } from "@/lib/admin-tabs";
import { tryGw } from "@/lib/api";
import { instanceTz } from "@/lib/checks";
import { activateSpec, closedOpenedLine, CUSTODY_PANEL, custodyHint, custodyLines, holdsLine, REACTIVATION_ACK_FIELD, CUSTODY_VIEW_TEXT } from "@/lib/custody-view";
import { BASIS_TITLES, clientKindTitle, provenanceTitle, deactivationEffects, EFFECT_TITLES, KEY_KIND_TITLES, RECORD_TYPE_TITLES, RELATION_TITLES, SCOPE_TITLES, SOURCE_TITLES, SPACE_KIND_TITLES, SPACE_ROLE_HINTS, SPACE_ROLE_TITLES, VIA_TITLES } from "@/lib/labels";
import { formatDay, personAccessLines, PERSON_ACCESS_PLAIN } from "@/lib/plain";
import type { PersonAccess, SettingsResponse } from "@/lib/types";
import { revokeKeyAction } from "../../services/actions";
import { revokePersonConnectionsAction, setActiveAction, setCustodianAction } from "./actions";

const loadPerson = cache(async (login: string) => {
  await guardAuditorPage();
  return tryGw<PersonAccess>(`/api/v1/admin/people/${encodeURIComponent(login)}/access`);
});

export async function generateMetadata({ params }: { params: Promise<{ login: string }> }): Promise<Metadata> {
  const res = await loadPerson(decodeURIComponent((await params).login).toLowerCase());
  return { title: res.ok ? res.data.person.display_name || res.data.person.login : personPage.permissionsAndVisibility };
}

type AccessKeyRow = PersonAccess["keys"][number];

const keyLive = (k: AccessKeyRow): boolean => !k.revoked_at && !(k.expires_at && Date.parse(k.expires_at) <= Date.now());

function keyStatus(k: AccessKeyRow) {
  if (k.revoked_at) return <Badge tone="muted">{personPage.revoked}</Badge>;
  if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) return <Badge tone="warn">{personPage.expired}</Badge>;
  return <Badge tone="ok">{personPage.active}</Badge>;
}

function KeysTable({ keys, login }: { keys: AccessKeyRow[]; login: string }) {
  return (
    <TableWrap cards>
      <table className="board">
        <thead><tr><th>{personPage.key}</th><th>{personPage.status}</th><th><span className="vis-hidden">{personPage.action}</span></th><th>{personPage.validUntil}</th><th>{personPage.kind}</th><th>{personPage.program}</th><th>{personPage.clientLabel}</th><th>{personPage.basis}</th><th>{personPage.issued}</th><th>{personPage.used}</th></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className={keyLive(k) ? undefined : "off"}>
              <td data-label={personPage.key}><Code>{k.key_prefix}…</Code></td>
              <td data-label={personPage.status}>{keyStatus(k)}</td>
              <td className="acts" data-label="">
                {!keyLive(k) ? null : (
                  <ActionForm action={revokeKeyAction} submitLabel={personPage.revoke} pendingLabel="…" compact danger
                    confirm={personPage.revokeKeyTheProgramUsingItWill(k.key_prefix, login, k.client_label ?? null)}>
                    <input type="hidden" name="id" value={k.id} />
                  </ActionForm>
                )}
              </td>
              <td data-label={personPage.validUntil}>{k.expires_at ? personPage.untilInclusive(formatDay(k.expires_at)) : <span className="muted">{personPage.noExpiry}</span>}</td>
              <td data-label={personPage.kind}>{KEY_KIND_TITLES[k.kind] ?? k.kind}</td>
              <td data-label={personPage.program}>{k.client_kind ? clientKindTitle(k.client_kind) : <span className="muted">{clientKindTitle(null)}</span>}</td>
              <td data-label={personPage.clientLabel}>{k.client_label ?? <span className="muted">—</span>}</td>
              <td data-label={personPage.basis}>{provenanceTitle(k.basis) ?? <span className="muted">—</span>}</td>
              <td data-label={personPage.issued}><LocalTime iso={k.created_at} /></td>
              <td data-label={personPage.used}>{k.last_used_at ? <LocalTime iso={k.last_used_at} /> : <span className="muted">{personPage.never}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function CustodySection({ a, tz }: { a: PersonAccess; tz: string }) {
  const lines = custodyLines(a, Date.now(), tz);
  if (!lines.length) return null;
  const of = a.custody?.of_person ?? null;
  const manual = of?.basis === "manual";
  return (
    <Section title={CUSTODY_PANEL.title} id="custody" icon="archive" hint={custodyHint(a)}>
      {lines.map((l, i) => <p key={i} className={i ? "hint" : undefined}>{l}</p>)}
      {(() => { const o = closedOpenedLine(a, tz); return o ? <p className="hint"><Link href={o.href} prefetch={false}>{o.text}</Link></p> : null; })()}
      {of && !a.person.demo ? (
        <div className="form-row custody-forms">
          <ActionForm action={setCustodianAction} submitLabel={CUSTODY_PANEL.assign} pendingLabel={personPage.assigning} resetOnSuccess quiet>
            <input type="hidden" name="login" value={a.person.login} />
            <Field label={CUSTODY_PANEL.fieldCustodian}>
              <PersonSuggest textName="custodian_login" pickedFields={{ login: "custodian_login", name: "custodian_name" }} label={CUSTODY_PANEL.fieldCustodian} placeholder={personPage.nameOrLogin} required excludeDemo />
            </Field>
            <Field label={CUSTODY_PANEL.fieldReason} hint={CUSTODY_PANEL.reasonHint}>
              <input name="reason" maxLength={200} defaultValue={manual ? of.reason ?? "" : ""} />
            </Field>
          </ActionForm>
          {manual || !of.custodian ? (
            <ActionForm action={setCustodianAction} submitLabel={CUSTODY_PANEL.toRule} pendingLabel="…" compact quiet>
              <input type="hidden" name="login" value={a.person.login} />
              <input type="hidden" name="op" value="rule" />
              <span className="hint">{CUSTODY_PANEL.toRuleHint}</span>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

export default async function PersonPage({ params }: { params: Promise<{ login: string }> }) {
  await guardAuditorPage();
  const login = decodeURIComponent((await params).login).toLowerCase();
  const res = await loadPerson(login);

  if (!res.ok) {
    return (
      <PageFrame title={login} lead={<Link href="/admin/people" prefetch={false}>{personPage.peopleAndOrganisation}</Link>}>
        {res.status === 404 ? <Empty>{rich(personPage.noPersonWithLoginExistsInThe, { code0: (children) => <Code>{children}</Code> }, { value0: login })}</Empty> : <LoadError result={res} what={personPage.personSCard} />}
      </PageFrame>
    );
  }
  const a = res.data;
  // zone of the installation for the days of the personal space and meetings section and of the Activate dialog (the
  // gateway sends moments in UTC, meetings move at the exact moment) and for the day of the audit log link (the log counts
  // days in it). The settings are read only when a dismissed person has these dates (personal space kept); if they are not
  // read, the zone of the installation that the gateway sends
  const needTz = !a.person.active && !!a.custody?.of_person;
  const settings = needTz ? await tryGw<SettingsResponse>("/api/v1/admin/settings") : null;
  const tz = instanceTz(settings?.ok ? settings.data : null);
  const activeKeys = a.keys.filter(keyLive), oldKeys = a.keys.filter((k) => !keyLive(k));
  const connections = a.oauth_connections;
  const closedVia = a.closed_via ?? [];
  const lines = personAccessLines(a);
  const holds = holdsLine(a.custody?.holds);
  const recordsTotal = a.records.reduce((s, r) => s + r.n, 0);
  const archivedSpaces = a.spaces.filter((s) => s.archived).length, liveSpaces = a.spaces.length - archivedSpaces;
  const owned = a.owned_spaces ?? [];
  const ownedLinks = owned.map((s, i) => <span key={s.slug}>{i ? ", " : ""}<Link href={tabHref(`/admin/spaces/${encodeURIComponent(s.slug)}`, "settings", SPACE_TABS[0]!.id, {}, "owner")} prefetch={false} title={s.slug}>{s.name || s.slug}</Link></span>);

  return (
    <PageFrame title={a.person.display_name} lead={<><Link href="/admin/people" prefetch={false}>{personPage.peopleAndOrganisation}</Link> · <Code>{a.person.login}</Code>{a.person.department ? ` · ${a.person.department}` : ""}{a.person.role ? ` · ${a.person.role}` : ""}
      {" · "}<Link href={`/admin/audit?login=${encodeURIComponent(a.person.login)}#events`} prefetch={false}>{personPage.auditLogEvents}</Link></>}>
      <div className="stat-tiles">
        <div className="stat-tile"><div className={`v ${a.person.active ? "good" : "bad"}`}>{a.person.active ? personPage.activeLabel : personPage.deactivated}</div><div className="k">{rich(personPage.statusLabel, {  }, { value0: a.person.demo ? personPage.demoPerson : "" })}</div></div>
        <div className="stat-tile"><div className="v">{liveSpaces}</div><div className="k">{personPage.visibleSpaces(liveSpaces, archivedSpaces)}</div></div>
        <div className="stat-tile"><div className="v">{a.grants.length}</div><div className="k">{personPage.activeGrants(a.grants.length)}</div></div>
        <div className="stat-tile"><div className="v">{activeKeys.length}</div><div className="k">{personPage.activeKeys(activeKeys.length)}</div></div>
        <div className="stat-tile"><div className="v">{recordsTotal}</div><div className="k">{personPage.ownedRecords(recordsTotal)}</div></div>
      </div>

      {!a.person.active ? <CustodySection a={a} tz={tz} /> : null}

      {!a.person.active && owned.length ? (
        <Notice tone="warn">{rich(personPage.ownsTransferOwnershipThisPersonIsDeactivated, { strong0: (children) => <strong>{children}</strong> }, { value0: ownedLinks })}</Notice>
      ) : null}

      <Section title={personPage.permissionsAndVisibility} icon="eye" hint={<>{rich(personPage.youCanViewTheWorkspaceAsA, { link0: (children) => <Link href="/admin/preview" prefetch={false}>{children}</Link> }, { value0: PERSON_ACCESS_PLAIN.hint })}</>}>
        <div className="kv-list">
          <div className="kv"><span>{PERSON_ACCESS_PLAIN.selfLabel}</span><span className={a.person.active ? undefined : "muted"}>{lines.self}</span></div>
          <div className="kv"><span>{PERSON_ACCESS_PLAIN.agentsLabel}</span><span className={a.person.active ? undefined : "muted"}>{lines.agents}</span></div>
          <div className="kv"><span>{PERSON_ACCESS_PLAIN.viaLabel}</span><span>
            {closedVia.length ? (
              <span className="tags">{closedVia.map((k) => (
                <span className="tag" key={k.key_id} title={personPage.keyLabel(k.key_id)}>{rich(personPage.extendedKey, {  }, { value0: k.key_id.slice(0, 8), value1: k.basis ?? personPage.noBasis, value2: k.expires_at ? personPage.until(formatDay(k.expires_at)) : personPage.noExpiryLabel })}</span>
              ))}</span>
            ) : <span className="muted">{lines.viaNone}</span>}
          </span></div>
          <div className="kv"><span>{personPage.orgUnits}</span><span>{a.org_units.length ? <span className="tags">{a.org_units.map((u) => <span key={`${u.code}:${u.relation}`} className="tag">{u.name} ({u.code}) · {RELATION_TITLES[u.relation] ?? u.relation} · {SOURCE_TITLES[u.source] ?? u.source}</span>)}</span> : <span className="muted">—</span>}</span></div>
          {owned.length ? <div className="kv"><span>{personPage.ownsActiveProjectsAndTeamsPersonalAnd}</span><span>{ownedLinks}{a.person.active ? null : <span className="danger-text">{personPage.transferOwnership}</span>}</span></div> : null}
          <div className="kv"><span>{personPage.updated}</span><LocalTime iso={a.person.updated_at} /></div>
        </div>
        {a.person.active && holds ? <p className="hint">{holds}</p> : null}
      </Section>

      <Section title={personPage.spaces} icon="layers" hint={personPage.theSpaceRoleAndItsBasisArchived}>
        {!a.spaces.length ? <Empty icon="layers">{personPage.noVisibleSpaces}</Empty> : (
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{personPage.space}</th><th>{personPage.role}</th><th>{personPage.kind}</th><th>{personPage.basis}</th><th>{personPage.newRecordsDataClass}</th><th>{personPage.validUntil}</th></tr></thead>
              <tbody>
                {a.spaces.map((s) => (
                  <tr key={s.slug}>
                    <td data-label={personPage.space}><Link href={`/admin/spaces/${encodeURIComponent(s.slug)}`} prefetch={false} className="cell-main">{s.name || s.slug}</Link>{s.archived ? <> <Badge tone="muted" title={personPage.archivedSpaceReadOnlyAndExcludedFrom}>{personPage.archived}</Badge></> : null}<div className="cell-sub"><Code>{s.slug}</Code></div></td>
                    <td data-label={personPage.role}><Badge tone={s.role === "owner" ? "brand" : s.role === "member" ? "info" : "neutral"} title={SPACE_ROLE_HINTS[s.role]}>{SPACE_ROLE_TITLES[s.role] ?? s.role}</Badge></td>
                    <td data-label={personPage.kind}>{SPACE_KIND_TITLES[s.kind] ?? s.kind}</td>
                    <td data-label={personPage.basis}>{VIA_TITLES[s.via] ?? s.via}{s.grant_id ? <div className="cell-sub">{rich(personPage.grant, { code0: (children) => <Code>{children}</Code> }, { value0: s.grant_id.slice(0, 8) })}</div> : null}</td>
                    <td data-label={personPage.newRecordsDataClass}><VisibilityBadge cls={s.default_class} tech /></td>
                    <td data-label={personPage.validUntil}>{s.expires_at ? <>{rich(personPage.untilLabel, {  }, { value0: <LocalTime iso={s.expires_at} relative={false} /> })}</> : <span className="muted">{personPage.noExpiry}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      <Section title={personPage.grants} icon="shield" hint={personPage.activeGrantsOnlyRevokeThemOnThe}>
        {!a.grants.length ? <Empty icon="shield">{personPage.noGrantsAccessIsDerivedFromThe}</Empty> : (
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{personPage.role}</th><th>{personPage.memoryEffect}</th><th>{personPage.actions}</th><th>{personPage.scope}</th><th>{personPage.basis}</th><th>{personPage.approvedBy}</th><th>{personPage.validUntil}</th></tr></thead>
              <tbody>
                {a.grants.map((g) => (
                  <tr key={g.id}>
                    <td data-label={personPage.role}><Code>{g.role_code}</Code><div className="cell-sub">{coreRoleName(g.role_code, g.name)}</div></td>
                    <td data-label={personPage.memoryEffect}>{g.memory_effect === "none" ? <span className="muted">{personPage.noEffect}</span> : EFFECT_TITLES[g.memory_effect]}</td>
                    <td data-label={personPage.actions}><Chips items={g.actions} /></td>
                    <td data-label={personPage.scope}>{SCOPE_TITLES[g.scope_kind] ?? g.scope_kind}{g.scope_ref ? <> · <Code>{g.scope_ref}</Code></> : null}</td>
                    <td data-label={personPage.basis}>{BASIS_TITLES[g.basis_source] ?? g.basis_source}{g.basis_ref ? <div className="cell-sub">{g.basis_ref}</div> : null}</td>
                    <td data-label={personPage.approvedBy}>{provenanceTitle(g.approved_by) ?? <span className="muted">—</span>}</td>
                    <td data-label={personPage.validUntil}>{g.valid_to ? <>{rich(personPage.untilLabel, {  }, { value0: <LocalTime iso={g.valid_to} relative={false} /> })}</> : <span className="muted">{personPage.noExpiry}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="foot-link"><Link href={`/admin/roles?login=${encodeURIComponent(a.person.login)}#grants`} prefetch={false}>{personPage.allThisPersonSGrantsIncludingRevoked}</Link></p>
      </Section>

      <Section title={personPage.keys} id="keys" icon="key" hint={personPage.personalAndExtendedKeysWithTheirIssue}
        actions={<Link href={issueKeyHref(a.person.login, "personal")} prefetch={false} className="btn sm">{personPage.issuePersonalKey}</Link>}>
        {!a.keys.length ? <Empty icon="key">{personPage.noKeysHaveBeenIssued}</Empty> : (
          <>
            {activeKeys.length ? <KeysTable keys={activeKeys} login={a.person.login} /> : <Empty>{personPage.noActiveKeys}</Empty>}
            {oldKeys.length ? (
              <details className="keys-old">
                <summary>{rich(personPage.revokedAndExpired, {  }, { value0: oldKeys.length })}</summary>
                <KeysTable keys={oldKeys} login={a.person.login} />
              </details>
            ) : null}
          </>
        )}
        <p className="foot-link"><Link href={tabHref("/admin/services", "keys", "services", { principal: a.person.login, revoked: "1" }, "keys")} prefetch={false}>{personPage.allThisPersonSKeysInServices}</Link></p>
      </Section>

      <Section title={personPage.records} icon="file" hint={personPage.recordsOwnedByThisPersonBySpace}>
        {!a.records.length ? <Empty icon="file">{personPage.noRecords}</Empty> : (
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{personPage.space}</th><th>{personPage.type}</th><th>{personPage.dataClass}</th><th className="num">{personPage.recordsLabel}</th></tr></thead>
              <tbody>
                {a.records.map((r, i) => (
                  <tr key={i}>
                    <td data-label={personPage.space}>{r.space ? <Link href={`/admin/spaces/${encodeURIComponent(r.space)}`} prefetch={false}><Code>{r.space}</Code></Link> : <span className="muted">—</span>}</td>
                    <td data-label={personPage.type}>{RECORD_TYPE_TITLES[r.type] ?? r.type}</td>
                    <td data-label={personPage.dataClass}><VisibilityBadge cls={r.class} tech /></td>
                    <td className="num" data-label={personPage.recordsLabel}>{r.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      <Section title={a.person.active ? personPage.dangerousActions : personPage.restoreAccess} id="danger">
        <div className={a.person.active ? "danger-zone" : undefined}>
          {connections === undefined || connections > 0 ? (
            <div className="form-row">
              <ActionForm action={revokePersonConnectionsAction} submitLabel={connections ? personPage.disconnectAllAgentConnections(connections) : personPage.disconnectAllAgentConnectionsLabel} pendingLabel={personPage.disconnecting} danger compact
                confirm={personPage.disconnectAllAgentConnectionsThroughTheCompany(a.person.login, connections ? ` (${connections})` : "")}>
                <input type="hidden" name="login" value={a.person.login} />
              </ActionForm>
              <span className="hint">{personPage.agentsConnectedThroughTheCompanyAccountWill}</span>
            </div>
          ) : <p className="hint">{personPage.noAgentConnectionsThroughTheCompanyAccount}</p>}
          <div className="form-row">
            <ActionForm action={setActiveAction} submitLabel={a.person.active ? personPage.deactivate : personPage.activate} pendingLabel="…" compact danger={a.person.active} quiet={!a.person.active}
              confirm={a.person.active ? personPage.deactivateLabel(a.person.login, deactivationEffects(a.custody?.policy)) : activateSpec(a.person.login, a.custody?.of_person?.since, tz)}>
              <input type="hidden" name="login" value={a.person.login} />
              <input type="hidden" name="active" value={a.person.active ? "false" : "true"} />
              {a.person.active ? null : <label className="check ack-fallback"><input type="checkbox" name={REACTIVATION_ACK_FIELD} /> {CUSTODY_VIEW_TEXT.reactivationAckOne}</label>}
            </ActionForm>
            <span className="hint">{a.person.active ? personPage.thePersonLosesAccessToMemoryAnd : personPage.thePersonCanSignInAgainKeys}</span>
          </div>
        </div>
      </Section>
    </PageFrame>
  );
}
