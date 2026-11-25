import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field, Notice, Section } from "@/components/ui";
import { formatDay, HANDOVER_PLAIN, handoverDefaultText } from "@/lib/plain";
import type { HandoverForm } from "@/lib/types";
import { handoverAction } from "../../actions";

export function HandoverBlock({ id, form, own }: { id: string; form: HandoverForm; own: boolean }) {
  const P = HANDOVER_PLAIN;
  if (form.reason === "not_meeting_decision") return null;
  if (!form.allowed) {
    return (
      <Section title={P.title} id="handover" icon="send">
        {form.reason === "not_current" ? (
          <p className="hint">{P.notCurrent}{form.current_id ? <> <Link href={`/records/${form.current_id}`} prefetch={false}>{P.openCurrent}</Link></> : null}</p>
        ) : <p className="hint">{form.reason === "no_projects" ? P.noProjects : P.cannot}</p>}
      </Section>
    );
  }
  const target = form.preview ? form.targets.find((t) => t.slug === form.preview!.slug) ?? null : null;
  const prior = form.preview?.already[0] ?? null;
  return (
    <Section title={P.title} id="handover" icon="send" hint={P.explain}>
      {form.done.length ? (
        <>
          <p className="hint"><strong>{P.doneTitle}</strong></p>
          <ul className="derived">
            {form.done.map((d) => <li key={d.id}>{P.doneLine(d.space_name, formatDay(d.at))} — <Link href={`/records/${d.id}`} prefetch={false}>{P.open}</Link></li>)}
          </ul>
        </>
      ) : null}
      <form method="get" action={`/records/${id}#handover`} className="filter-form">
        <label className="field grow">
          <span className="field-label">{P.project}</span>
          <select name="to" defaultValue={target?.slug ?? form.targets[0]?.slug}>{form.targets.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}</select>
        </label>
        <button type="submit" className="btn">{P.choose}</button>
      </form>
      {form.preview && target && form.source ? (
        <>
          <Notice tone={form.preview.wider ? "warn" : "info"}>{form.preview.wider ? P.wider(target.name, form.preview.class === "open") : P.notWider(target.name)}</Notice>
          {prior ? <p className="hint">{P.already(target.name, formatDay(prior.at))} <Link href={`/records/${prior.id}`} prefetch={false}>{P.open}</Link></p> : null}
          <ActionForm action={handoverAction} submitLabel={P.button} pendingLabel="…">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="to_space" value={target.slug} />
            <input type="hidden" name="to_name" value={target.name} />
            {own ? <input type="hidden" name="own" value="1" /> : null}
            <div className="form-grid">
              <Field label={P.titleField} wide><input name="title" required maxLength={200} defaultValue={form.source.title ?? ""} /></Field>
              <Field label={P.textField} hint={P.textHint} wide>
                <textarea name="text" required rows={5} maxLength={20_000} defaultValue={handoverDefaultText(form.source.statement, form.source.due)} />
              </Field>
            </div>
            <label className="check"><input type="checkbox" name="confirm" /> {P.confirm}</label>
          </ActionForm>
        </>
      ) : null}
    </Section>
  );
}
