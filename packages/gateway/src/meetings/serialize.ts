export const MEETING_REVISIONS = ["base"] as const;
export type MeetingRevision = (typeof MEETING_REVISIONS)[number];

type FieldRule = "value" | "open"
  | { readonly fields: Readonly<Record<string, FieldRule>> }
  | { readonly items: FieldRule };

function closed(names: readonly string[], nested: Readonly<Record<string, FieldRule>> = {}): FieldRule {
  return { fields: { ...Object.fromEntries(names.map((name) => [name, "value"] as const)), ...nested } };
}

const list = (items: FieldRule): FieldRule => ({ items });
const valueList = list("value");

const stageFields = ["stage", "status", "version", "attempts", "terminal", "last_error", "updated_at"];
const participant = closed(["input", "status", "login", "display_name", "department", "matched_by"]);
const participants = list(participant);
const ambiguous = list(closed(["input", "truncated"], {
  candidates: list(closed(["display_name", "department", "login"])),
}));
const consent = closed(["version", "accepted_at", "by", "channel", "client"]);
const upload = closed(["url", "method", "expires_at", "max_bytes"]);
const existing = closed(["id", "path", "version"]);
const toolResult = closed([
  "mode", "meeting_ref", "command", "id", "path", "version", "already_known", "supersedes_id",
  "format", "participants_changed", "workplace_url",
], {
  upload, existing, participants, consent,
  participants_unknown: valueList,
  stages: list(closed(stageFields)),
  warnings: valueList,
});

const base = {
  IngestResult: closed([
    "id", "path", "type", "space", "class", "version", "supersedes_id", "already_known", "placed", "note",
    "extended_write", "participants_changed", "workplace_url", "format",
  ], {
    stages: list(closed([...stageFields, "retry_at", "busy_retries", "slow_retries", "first_busy_at"])),
    queue: closed(["lane", "position", "eta_sec", "reason", "retry_at"]),
    open_check: closed(["result", "via", "at", "openable", "by_word", "text_checked", "unchecked"], {
      kinds: valueList,
      findings: list(closed(["rule", "kind", "reason", "field", "at"])),
    }),
    participants, consent,
    participants_unknown: valueList,
    participants_left: valueList,
    warnings: valueList,
  }),
  IngestAccessResult: closed(["source_ref", "records_updated", "readers", "promoted_restricted"], {
    readers_unknown: valueList, readers_left: valueList, warnings: valueList,
  }),
  ParticipantsCheck: closed(["space", "class"], {
    owner: closed(["login", "display_name"]),
    participants, ambiguous, warnings: valueList,
  }),
  ParticipantsAmbiguous: ambiguous,
  ConsentText: closed(["version", "text"]),
  UploadTicket: closed(["meeting_id", "command"], {
    upload, existing, participants, consent: closed(["version"]), warnings: valueList,
  }),
  ReconcileResult: closed(["date", "next_cursor"], {
    accepted: list(closed(["meeting_id", "id", "version", "received_at", "stages_done", "stages_total"])),
  }),
  MeetingToolResult: toolResult,
  McpReply: closed(["jsonrpc", "id"], {
    result: closed(["isError", "resultType"], {
      content: list("open"),
      structuredContent: toolResult,
      _meta: closed([], { "io.modelcontextprotocol/serverInfo": closed(["name", "title", "version"]) }),
    }),
  }),
  Error: closed(["code", "message", "hint", "retry_after", "reason"], { details: "open" }),
} as const;

export type MeetingShape = keyof typeof base;
export const MEETING_FIELDS = { base } as const satisfies Readonly<Record<MeetingRevision, Readonly<Record<MeetingShape, FieldRule>>>>;

function project(body: unknown, rule: FieldRule): unknown {
  if (rule === "value" || rule === "open" || body === null || typeof body !== "object") return body;
  if ("items" in rule) {
    if (!Array.isArray(body)) throw new TypeError();
    return body.map((item) => project(item, rule.items));
  }
  if (Array.isArray(body)) throw new TypeError();
  return Object.fromEntries(Object.entries(body)
    .filter(([key]) => Object.hasOwn(rule.fields, key))
    .map(([key, value]) => [key, project(value, rule.fields[key]!)]));
}

// The static type is the builder's: a field the revision's table does not list is absent at run time.
export function serializeMeeting<Body>(shape: MeetingShape, body: Body, revision: MeetingRevision = "base"): Body {
  if (!Object.hasOwn(MEETING_FIELDS, revision)) throw new TypeError();
  return project(body, MEETING_FIELDS[revision][shape]) as Body;
}
