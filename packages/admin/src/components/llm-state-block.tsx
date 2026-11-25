import { LLM_STATE_BLOCK_TEXT } from "../messages/components";
import { ActionForm, type FormAction } from "@/components/action-form";
import { LoadError, Notice, Section } from "@/components/ui";
import type { Result } from "@/lib/api";
import { llmView } from "@/lib/llm-state";
import type { LlmGateState } from "@/lib/types";

export function LlmStateBlock({ state, clearHolds, probeNow }: { state: Result<LlmGateState>; clearHolds: FormAction; probeNow: FormAction }) {
  if (!state.ok) return <Section title={LLM_STATE_BLOCK_TEXT.title} id="llm"><LoadError result={state} what={LLM_STATE_BLOCK_TEXT.state} /></Section>;
  const v = llmView(state.data);
  const actions = v.canClearHolds || v.canProbe ? (
    <>
      {v.canClearHolds ? <ActionForm action={clearHolds} submitLabel={LLM_STATE_BLOCK_TEXT.resume} pendingLabel="…" compact quiet confirm={LLM_STATE_BLOCK_TEXT.resumeConfirm}>{null}</ActionForm> : null}
      {v.canProbe ? <ActionForm action={probeNow} submitLabel={LLM_STATE_BLOCK_TEXT.tryNow} pendingLabel="…" compact quiet>{null}</ActionForm> : null}
    </>
  ) : undefined;
  return (
    <Section title={LLM_STATE_BLOCK_TEXT.title} id="llm" hint={LLM_STATE_BLOCK_TEXT.lead} actions={actions}>
      {v.lines.map((l) => <Notice key={l.text} tone={l.tone}>{l.text}</Notice>)}
      {v.holdDetails.length ? (
        <details className="hint">
          <summary>{LLM_STATE_BLOCK_TEXT.pausedBy}</summary>
          <ul>{v.holdDetails.map((d) => <li key={d}>{d}</li>)}</ul>
        </details>
      ) : null}
    </Section>
  );
}
