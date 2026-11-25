import { liveLineText as M } from "@/messages/ws-connect";
import { rich } from "@/i18n/rich";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { RetryLater } from "@/components/retry-later";
import { AGENT_UNKNOWN, type AgentFailure } from "@/lib/agent-status";
import { CONNECT_PLAIN } from "@/lib/plain";

export function LiveLine({ title, at, checkHref, waiting = CONNECT_PLAIN.waiting }: { title: string; at: string | null; checkHref: string | null; waiting?: string }) {
  return (
    <p className={`cn-live ${at ? "ok" : "wait"}`} id="check" role="status">
      {at
        ? <><Icon name="circle-check" /><span><b>{rich(M.isConnected, null, { value0: title })}</b> · <LocalTime iso={at} short /></span></>
        : <><Icon name="hourglass" /><span>{waiting}{checkHref ? <> <a href={checkHref}>{rich(M.check, null)}</a></> : null}</span></>}
    </p>
  );
}

export function UnknownLine({ failure, id }: { failure: AgentFailure | null; id?: string }) {
  return (
    <p className="cn-live wait" id={id} role="status">
      <Icon name="hourglass" />
      <span>{AGENT_UNKNOWN.line} <RetryLater seconds={failure?.retryAfter ?? null} limited={failure?.code === "rate_limited"} /></span>
    </p>
  );
}
