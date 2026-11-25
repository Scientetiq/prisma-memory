"use client";
export { servicesKeyForm as KEY_FORM_TEXT } from "@/messages/panel-services";
import { BASIS_HINTS } from "@/messages/panel-services";
import { servicesKeyForm as m } from "@/messages/panel-services";
import { rich } from "@/i18n/rich";
import { useMemo, useState } from "react";
import { ActionForm, type FormAction } from "@/components/action-form";
import { Field, Notice } from "@/components/ui";
import { compareText } from "@/i18n/format";
import { inDaysUtc as inDays } from "@/lib/format";
import { CLIENT_KIND_PANEL_HINTS, CLIENT_KIND_TITLES, CLIENT_KINDS, EXTENDED_KEY_DEFAULT_DAYS, KEY_KINDS, KEY_KIND_TITLES, PERSON_KEY_MAX_DAYS, PERSONAL_KEY_DEFAULT_DAYS, SERVICE_KIND_TITLES } from "@/lib/labels";
import { GEN_SERVICE_KEY_COMMAND } from "@/lib/key-fingerprint";
import { OBO_READ_KEY_MAX_DAYS } from "@/lib/types";

export interface KeyFormService { name: string; kind: string; write_space: string | null; obo_allowed?: boolean; obo_read?: boolean }

export const serviceOptionLabel = (s: KeyFormService): string =>
  m.serviceLabel(s.name, s.kind, s.write_space ?? "");

export function serviceGroups(services: readonly KeyFormService[], o: { filter?: string; showTest?: boolean; selected?: string } = {}): Array<{ kind: string; title: string; items: KeyFormService[] }> {
  const q = (o.filter ?? "").trim().toLowerCase();
  const shown = services.filter((s) => (s.name === o.selected) || ((!q || s.name.toLowerCase().includes(q)) && (o.showTest || !s.write_space)));
  const order = Object.keys(SERVICE_KIND_TITLES);
  const kinds = Array.from(new Set(shown.map((s) => s.kind))).sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || compareText(a, b));
  return kinds.map((kind) => ({ kind, title: m.groupLabel(kind), items: shown.filter((s) => s.kind === kind).sort((a, b) => compareText(a.name, b.name)) }));
}

export function fingerprintHint(o: { required: boolean; obo: boolean }): string {
  return m.fingerprintHint(o.required, o.obo, GEN_SERVICE_KEY_COMMAND);
}

export function cidrsHint(o: { extended: boolean; obo: boolean }): string {
  if (o.extended) return m.requiredCommaSeparatedAddressesOrNetworksTheProgram;
  if (o.obo) return m.requiredForAnOnBehalfOfServiceComma;
  return m.optionalCommaSeparatedServiceAddressesOrNetworksOr;
}

export function KeyForm({ services, action, oauthAgents = false, oboKeys = false, fingerprintOnly = false, initialKind, initialPrincipal }: {
  services: KeyFormService[]; action: FormAction; oauthAgents?: boolean; oboKeys?: boolean; fingerprintOnly?: boolean; initialKind?: string; initialPrincipal?: string;
}) {
  const [kind, setKind] = useState<string>(initialKind && (KEY_KINDS as readonly string[]).includes(initialKind) ? initialKind : "service");
  const [service, setService] = useState<string>(initialKind === "personal" || initialKind === "extended" ? "" : services.some((s) => s.name === initialPrincipal) ? initialPrincipal! : "");
  const [filter, setFilter] = useState("");
  const [showTest, setShowTest] = useState(false);
  const groups = useMemo(() => serviceGroups(services, { filter, showTest, selected: service }), [services, filter, showTest, service]);
  const testCount = services.filter((s) => s.write_space).length;
  const forPerson = kind === "personal" || kind === "extended";
  const extended = kind === "extended";
  const selected = kind === "service" ? services.find((s) => s.name === service) : undefined;
  const oboService = selected?.obo_allowed === true, oboRead = oboService && selected?.obo_read === true;
  return (
    <ActionForm action={action} submitLabel={m.issueAKey} pendingLabel={m.issuing} resetOnSuccess
      confirm={extended ? m.anExtendedKeyWillOpenThisPersonS : undefined}>
      <div className="form-grid">
        <Field label={m.keyKind} hint={m.kindHint(kind, oauthAgents)}>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KEY_KINDS.map((k) => <option key={k} value={k}>{KEY_KIND_TITLES[k]}</option>)}
          </select>
        </Field>
        {kind === "service" ? (
          <div className="field field-wide">
            <label className="field-label" htmlFor="key-service">{m.serviceOwner}</label>
            {services.length > 8 ? (
              <div className="svc-filter">
                <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={m.findByName} aria-label={m.findServiceByName} autoCapitalize="none" spellCheck={false} />
                {testCount ? <label className="check">{rich(m.showTestServices, null, { value: <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} />, value2: testCount })}</label> : null}
              </div>
            ) : testCount ? (
              <label className="check">{rich(m.showTestServices, null, { value: <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} />, value2: testCount })}</label>
            ) : null}
            <select id="key-service" name="principal" value={service} onChange={(e) => setService(e.target.value)} required key="service">
              <option value="">{m.chooseAService}</option>
              {groups.map((g) => (
                <optgroup key={g.kind} label={g.title}>
                  {g.items.map((s) => <option key={s.name} value={s.name}>{serviceOptionLabel(s)}</option>)}
                </optgroup>
              ))}
            </select>
            <span className="field-hint">{services.length ? m.activeServicesProductionServicesWriteAsUsualTest : m.noServicesYetCreateOneOnTheServices}</span>
            {oboService && !oboKeys ? (
              <Notice tone="warn">{m.oboKeysOffHint}</Notice>
            ) : null}
          </div>
        ) : (
          <Field label={m.ownerSLogin} hint={m.testPeopleOnlyALoginOnATest}>
            <input type="text" name="principal" key="person" defaultValue={initialKind === "personal" || initialKind === "extended" ? initialPrincipal ?? "" : ""} autoCapitalize="none" spellCheck={false} required />
          </Field>
        )}
        {kind === "service" ? (
          <Field label={m.keyFingerprintSha} hint={fingerprintHint({ required: fingerprintOnly, obo: oboService })}>
            <input type="text" name="fingerprint" key="fingerprint" placeholder={m.fingerprintExample} autoCapitalize="none" spellCheck={false} autoComplete="off"
              required={fingerprintOnly || oboService} />
          </Field>
        ) : null}
        <Field label={m.reasonForIssuing} hint={forPerson ? BASIS_HINTS[kind] : m.optionalForAServiceKeyButAddsDetail}>
          <input type="text" name="basis" placeholder={m.forExampleRequestSd} minLength={forPerson ? 3 : undefined} maxLength={500} required={forPerson} key={forPerson ? "basis-person" : "basis-other"} />
        </Field>
        {forPerson ? (
          <Field label={m.program} hint={CLIENT_KIND_PANEL_HINTS[extended ? "extended" : "personal"]}>
            <select name="client_kind" required defaultValue="" key="client-kind">
              <option value="">{m.chooseAProgram}</option>
              {CLIENT_KINDS.map((k) => <option key={k} value={k}>{CLIENT_KIND_TITLES[k]}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label={m.clientLabel} hint={m.whereTheKeyWillBeUsedShownIn}>
          <input type="text" name="client_label" placeholder={m.forExampleLaptopNNTranscriberProd} />
        </Field>
        {kind === "service" || extended ? (
          <Field label={m.allowedAddresses} hint={cidrsHint({ extended, obo: oboService })}>
            <input type="text" name="net_cidrs" key={extended ? "net-extended" : "net-service"} placeholder={extended ? m.forExample : m.forExample2}
              autoCapitalize="none" spellCheck={false} required={extended || oboService} />
          </Field>
        ) : null}
        {extended ? (
          <div className="field field-wide">
            <span className="field-label">{m.openRecords}</span>
            <label className="check">{rich(m.allowTheAgentUsingThisKeyToCreate, null, { value: <input type="checkbox" name="open_write" /> })}</label>
            <span className="field-hint">{m.offByDefaultTheAgentReadsThePerson}</span>
            <input type="text" name="open_write_basis" key="ow-basis" placeholder={m.reasonForPermissionSuchAsRequestSd} maxLength={500} aria-label={m.reasonForAllowingOpenRecords} />
          </div>
        ) : null}
        {forPerson ? (
          <Field label={m.validThroughInclusive} hint={m.aPersonSKeyMustExpireWithinDays(PERSON_KEY_MAX_DAYS, extended ? EXTENDED_KEY_DEFAULT_DAYS : PERSONAL_KEY_DEFAULT_DAYS)}>
            <input type="date" name="expires_at" key={extended ? "exp-extended" : "exp-personal"} required defaultValue={inDays(extended ? EXTENDED_KEY_DEFAULT_DAYS : PERSONAL_KEY_DEFAULT_DAYS)} min={inDays(1)} max={inDays(PERSON_KEY_MAX_DAYS)} />
          </Field>
        ) : oboRead ? (
          <Field label={m.validThroughInclusive} hint={m.theServiceReadsOnBehalfOfPeopleExpiry(OBO_READ_KEY_MAX_DAYS)}>
            <input type="date" name="expires_at" key="exp-obo-read" required defaultValue={inDays(OBO_READ_KEY_MAX_DAYS)} min={inDays(1)} max={inDays(OBO_READ_KEY_MAX_DAYS)} />
          </Field>
        ) : (
          <Field label={m.validThroughInclusive} hint={m.leaveEmptyForNoExpiryUntilRevoked}>
            <input type="date" name="expires_at" key="exp-plain" />
          </Field>
        )}
      </div>
    </ActionForm>
  );
}
