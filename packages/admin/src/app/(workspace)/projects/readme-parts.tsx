import Link from "next/link";
import { ActionForm, type FormAction } from "@/components/action-form";
import { Field, Notice } from "@/components/ui";
import { PROJECT_README_MAX } from "@/lib/form";
import { SPACE_README } from "@/lib/plain";
import { readmeValue } from "@/lib/space-readme";

export function ReadmeNudge({ href }: { href?: string }) {
  return (
    <Notice tone="info">
      <span className="readme-nudge">
        <span>{SPACE_README.nudge}</span>
        {href ? <Link href={href} prefetch={false} className="btn sm">{SPACE_README.fill}</Link> : null}
      </span>
    </Notice>
  );
}

export function ReadmeForm({ action, slug, readme, template }: { action: FormAction; slug: string; readme: string | null; template: string | null }) {
  return (
    <ActionForm action={action} submitLabel={SPACE_README.save} pendingLabel={SPACE_README.saving} quiet>
      <input type="hidden" name="space" value={slug} />
      <Field label={SPACE_README.fieldLabel} wide hint={SPACE_README.clearHint}>
        <textarea name="readme" rows={12} defaultValue={readmeValue(readme, template)} maxLength={PROJECT_README_MAX} className="readme-text" />
      </Field>
    </ActionForm>
  );
}
