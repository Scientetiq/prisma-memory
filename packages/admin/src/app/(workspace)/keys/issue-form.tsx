"use client";
import { issueFormText as M } from "@/messages/ws-keys";
import { rich } from "@/i18n/rich";

import { ActionForm, type FormAction } from "@/components/action-form";
import { Field } from "@/components/ui";
import { inDaysUtc } from "@/lib/format";
import { CLIENT_KIND_TITLES, CLIENT_KINDS, PERSON_KEY_MAX_DAYS, PERSONAL_KEY_DEFAULT_DAYS } from "@/lib/labels";
import { mcpUrlByKind, type McpUrls } from "@/lib/snippets";
import { Snippets } from "./snippets";


export function IssueKeyForm({ action, urls, remaining }: { action: FormAction; urls: McpUrls; remaining: number | null }) {
  const exhausted = remaining !== null && remaining <= 0;
  return (
    <ActionForm action={action} submitLabel={M.issueKey} pendingLabel={M.issuing} resetOnSuccess disabled={exhausted}
      extra={(state) => (state.ok && state.secret ? <Snippets mcpUrl={mcpUrlByKind(urls, state.clientKind)} secret={state.secret.value} /> : null)}>
      <div className="form-grid">
        <Field label={M.program} hint={M.aScriptOrLocalProgramWrites}>
          <select name="client_kind" required defaultValue="">
            <option value="">{rich(M.chooseAProgram, null)}</option>
            {CLIENT_KINDS.map((k) => <option key={k} value={k}>{CLIENT_KIND_TITLES[k]}</option>)}
          </select>
        </Field>
        <Field label={M.whereItWillRun} hint={M.thisLabelHelpsYouRecogniseThe}>
          <input type="text" name="client_label" maxLength={60} placeholder={M.forExampleAReportOnThe} />
        </Field>
        <Field label={M.validThrough} hint={M.inclusiveUpToDaysKeysCannot(PERSON_KEY_MAX_DAYS)}>
          <input type="date" name="expires_at" required defaultValue={inDaysUtc(PERSONAL_KEY_DEFAULT_DAYS)} min={inDaysUtc(1)} max={inDaysUtc(PERSON_KEY_MAX_DAYS)} />
        </Field>
      </div>
      {exhausted ? <p className="field-error">{rich(M.activeKeyLimitReachedRevokeAn, null)}</p> : null}
    </ActionForm>
  );
}
