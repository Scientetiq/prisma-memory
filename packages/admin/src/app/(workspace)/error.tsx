"use client";
import { errorText as M } from "@/messages/ws-error";
import { rich } from "@/i18n/rich";

import { SectionError } from "@/components/error-actions";
import { RetryLater } from "@/components/retry-later";
import { parseUnavailable, unavailableText } from "@/lib/retry";

export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const memory = parseUnavailable(error.digest);
  if (memory?.code === "rate_limited") return (
    <div className="notice info" data-error-code="rate_limited"><RetryLater seconds={memory.retryAfter} limited carry="workspace" onRetry={reset} /></div>
  );
  if (memory) return (
    <div className="notice danger" role="alert" data-error-code={memory.code}>{rich(M.ifThisContinuesContactTheAdministrator, { tag0: (children) => <strong>{children}</strong>, tag1: () => <RetryLater seconds={memory.retryAfter} carry="workspace" onRetry={reset} /> }, { value0: unavailableText(memory.code) })}</div>
  );
  return <SectionError digest={error.digest} reset={reset} home="/" />;
}
