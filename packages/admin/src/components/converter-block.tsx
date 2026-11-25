import { CONVERTER_BLOCK_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import { ActionForm, type FormAction } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { Badge, Code, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import type { Result } from "@/lib/api";
import { converterBlockView } from "@/lib/converter-state";
import { shortId } from "@/lib/format";
import type { ConverterState } from "@/lib/types";

export interface ConverterActions { hold: FormAction; resume: FormAction; probe: FormAction }

export function ConverterBlock({ state, actions }: { state: Result<ConverterState>; actions: ConverterActions }) {
  if (!state.ok) return <Section title={CONVERTER_BLOCK_TEXT.title} id="converter"><LoadError result={state} what={CONVERTER_BLOCK_TEXT.state} /></Section>;
  const v = converterBlockView(state.data);
  const buttons = (
    <>
      {v.canHoldNew ? (
        <ActionForm action={actions.hold} submitLabel={CONVERTER_BLOCK_TEXT.holdNew} pendingLabel="…" compact quiet confirm={CONVERTER_BLOCK_TEXT.holdNewConfirm}>
          <input type="hidden" name="scope" value="new" />
        </ActionForm>
      ) : null}
      {v.canHoldAll ? (
        <ActionForm action={actions.hold} submitLabel={CONVERTER_BLOCK_TEXT.holdAll} pendingLabel="…" compact quiet confirm={CONVERTER_BLOCK_TEXT.holdAllConfirm}>
          <input type="hidden" name="scope" value="all" />
        </ActionForm>
      ) : null}
      {v.canResume ? <ActionForm action={actions.resume} submitLabel={CONVERTER_BLOCK_TEXT.resume} pendingLabel="…" compact quiet>{null}</ActionForm> : null}
      {v.canProbe ? (
        <ActionForm action={actions.probe} submitLabel={CONVERTER_BLOCK_TEXT.probe} pendingLabel={CONVERTER_BLOCK_TEXT.probing} compact quiet>
          <label className="check" title={CONVERTER_BLOCK_TEXT.accountChangedHint}>
            <input type="checkbox" name="confirm_new_principal" defaultChecked={false} /> {CONVERTER_BLOCK_TEXT.accountChanged}</label>
        </ActionForm>
      ) : null}
    </>
  );
  return (
    <Section title={CONVERTER_BLOCK_TEXT.title} id="converter" actions={buttons}
      hint={CONVERTER_BLOCK_TEXT.lead}>
      {v.lines.map((l) => <Notice key={l.text} tone={l.tone}>{l.text}</Notice>)}
      {v.needsConfirm ? <Notice tone="warn">{CONVERTER_BLOCK_TEXT.confirmNewAccount}</Notice> : null}
      {v.recent.length ? (
        <details className="hint">
          <summary>{rich(CONVERTER_BLOCK_TEXT.recent, null, { value1: v.recent.length })}</summary>
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{CONVERTER_BLOCK_TEXT.record}</th><th>{CONVERTER_BLOCK_TEXT.status}</th><th>{CONVERTER_BLOCK_TEXT.atConverter}</th><th>{CONVERTER_BLOCK_TEXT.waiting}</th><th>{CONVERTER_BLOCK_TEXT.retries}</th></tr></thead>
              <tbody>
                {v.recent.map((r) => (
                  <tr key={r.id}>
                    <td data-label={CONVERTER_BLOCK_TEXT.record}><Code title={r.id}>{shortId(r.id)}</Code></td>
                    <td data-label={CONVERTER_BLOCK_TEXT.status}><Badge tone={r.tone}>{r.state}</Badge></td>
                    <td data-label={CONVERTER_BLOCK_TEXT.atConverter}><span title={r.dcCode ?? undefined}>{r.dc}</span></td>
                    <td data-label={CONVERTER_BLOCK_TEXT.waiting}>{r.since}</td>
                    <td data-label={CONVERTER_BLOCK_TEXT.retries} className="cell-sub">{r.repeats}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </details>
      ) : null}
      {v.orphans.length ? (
        <details className="hint">
          <summary>{rich(CONVERTER_BLOCK_TEXT.orphans, null, { value1: v.orphans.length })}</summary>
          <p className="hint">{CONVERTER_BLOCK_TEXT.orphansHint}</p>
          <TableWrap cards>
            <table className="board">
              <thead><tr><th>{CONVERTER_BLOCK_TEXT.when}</th><th>{CONVERTER_BLOCK_TEXT.record}</th><th>{CONVERTER_BLOCK_TEXT.whyUnused}</th><th>{CONVERTER_BLOCK_TEXT.converterId}</th></tr></thead>
              <tbody>
                {v.orphans.map((o) => (
                  <tr key={`${o.document ?? o.run ?? ""}|${o.at}`}>
                    <td data-label={CONVERTER_BLOCK_TEXT.when}><LocalTime iso={o.at} /></td>
                    <td data-label={CONVERTER_BLOCK_TEXT.record}>{o.record ? <Code title={o.record}>{shortId(o.record)}</Code> : "—"}</td>
                    <td data-label={CONVERTER_BLOCK_TEXT.whyUnused}>{o.why}</td>
                    <td data-label={CONVERTER_BLOCK_TEXT.converterId}>{o.run ? <Code>{o.run}</Code> : "—"}{o.document ? <div className="cell-sub">{rich(CONVERTER_BLOCK_TEXT.document, null, { document: <Code>{o.document}</Code> })}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </details>
      ) : null}
    </Section>
  );
}
