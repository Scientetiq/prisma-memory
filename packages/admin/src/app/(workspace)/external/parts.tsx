import { CopyBlock } from "@/components/copy-block";
import { Empty } from "@/components/ui";
import type { ExternalProgram } from "@/lib/external-access";
import { WS_EXTERNAL_MESSAGES } from "@/messages/ws-external";

export function ProgramsList({ programs, enabled }: { programs: readonly ExternalProgram[]; enabled: boolean }) {
  if (!programs.length) return <Empty icon="plug">{WS_EXTERNAL_MESSAGES.externalConnectionsHaveNotBeen}</Empty>;
  return (
    <ul className="plain-list">
      {programs.map((p) => (
        <li key={p.client_id}>
          <b>{p.title}</b>
          {p.command ? (
            <>
              <p className="hint">{enabled ? WS_EXTERNAL_MESSAGES.runInATerminalTo : WS_EXTERNAL_MESSAGES.afterEnablingAccessRunIn}</p>
              <CopyBlock text={p.command} label={WS_EXTERNAL_MESSAGES.connectionCommandFor(p.title)} wrap />
            </>
          ) : <p className="hint">{WS_EXTERNAL_MESSAGES.connectThroughTheAppS}</p>}
        </li>
      ))}
    </ul>
  );
}
