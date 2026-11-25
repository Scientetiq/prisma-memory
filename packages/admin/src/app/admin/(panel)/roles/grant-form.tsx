"use client";
import { coreRoleName, rolesGrantForm } from "@/messages/panel-roles";
import { useState } from "react";
import { ActionForm, type FormAction } from "@/components/action-form";
import { Field } from "@/components/ui";
import { BASIS_SOURCES, BASIS_TITLES, EFFECT_ORDER, EFFECT_TITLES, GRANT_ACTIONS, SCOPE_KINDS, SCOPE_NEEDS_REF, SCOPE_REF_HINTS, SCOPE_TITLES } from "@/lib/labels";
import type { MemoryEffect } from "@/lib/types";

export interface AssignableRole { code: string; name: string; memory_effect: MemoryEffect }

export function GrantForm({ roles, action }: { roles: AssignableRole[]; action: FormAction }) {
  const [role, setRole] = useState("");
  const [scope, setScope] = useState("own");
  const needsRef = SCOPE_NEEDS_REF.has(scope);
  const picked = roles.find((r) => r.code === role);

  return (
    <ActionForm action={action} submitLabel={rolesGrantForm.createGrant} pendingLabel={rolesGrantForm.creating} resetOnSuccess>
      <div className="form-grid">
        <Field label={rolesGrantForm.recipientLogin} hint={rolesGrantForm.anActivePersonFromTheOrgTable}>
          <input type="text" name="login" placeholder={rolesGrantForm.loginExample} autoCapitalize="none" spellCheck={false} required />
        </Field>
        <Field label={rolesGrantForm.role} hint={picked ? (picked.memory_effect === "none" ? rolesGrantForm.thisRoleDoesNotAffectAccessTo : rolesGrantForm.memoryEffect(EFFECT_TITLES[picked.memory_effect])) : rolesGrantForm.rolesDerivedFromTheOrgTableCannot}>
          <select name="role_code" value={role} onChange={(e) => setRole(e.target.value)} required>
            <option value="">{rolesGrantForm.chooseARole}</option>
            {EFFECT_ORDER.map((effect) => {
              const group = roles.filter((r) => r.memory_effect === effect);
              return group.length ? (
                <optgroup key={effect} label={effect === "none" ? rolesGrantForm.noEffectInMemory : EFFECT_TITLES[effect]}>
                  {group.map((r) => <option key={r.code} value={r.code}>{r.code} — {coreRoleName(r.code, r.name)}</option>)}
                </optgroup>
              ) : null;
            })}
          </select>
        </Field>
        <Field label={rolesGrantForm.scope}>
          <select name="scope_kind" value={scope} onChange={(e) => setScope(e.target.value)}>
            {SCOPE_KINDS.map((k) => <option key={k} value={k}>{SCOPE_TITLES[k]} ({k})</option>)}
          </select>
        </Field>
        <Field label={rolesGrantForm.scopeIdentifierScopeRef} hint={needsRef ? rolesGrantForm.required(SCOPE_REF_HINTS[scope]) : rolesGrantForm.notUsedForThisScope}>
          <input type="text" name="scope_ref" key={scope} disabled={!needsRef} required={needsRef} placeholder={needsRef ? SCOPE_REF_HINTS[scope] : "—"} spellCheck={false} />
        </Field>
        <Field label={rolesGrantForm.basisSource} hint={rolesGrantForm.requiredAGrantCannotBeCreatedWithout}>
          <select name="basis_source" defaultValue="" required>
            <option value="">{rolesGrantForm.chooseABasis}</option>
            {BASIS_SOURCES.map((b) => <option key={b} value={b}>{BASIS_TITLES[b]} ({b})</option>)}
          </select>
        </Field>
        <Field label={rolesGrantForm.basisRequestOrDecisionReference} hint={rolesGrantForm.basisRefUsedToFindTheGrant}>
          <input type="text" name="basis_ref" placeholder={rolesGrantForm.forExampleREQ} />
        </Field>
        <Field label={rolesGrantForm.approvedBy} hint={rolesGrantForm.approverSRoleOrLoginOptional}>
          <input type="text" name="approved_by" />
        </Field>
        <Field label={rolesGrantForm.validUntilInclusive} hint={rolesGrantForm.blankMeansNoExpiryTemporaryAccessExpires}>
          <input type="date" name="valid_to" />
        </Field>
        <div className="field field-wide">
          <span className="field-label">{rolesGrantForm.actions}</span>
          <div className="checks">
            {GRANT_ACTIONS.map((a) => (
              <label className="check" key={a}><input type="checkbox" name="actions" value={a} defaultChecked={a === "view"} /> <code className="code">{a}</code></label>
            ))}
          </div>
        </div>
      </div>
    </ActionForm>
  );
}
