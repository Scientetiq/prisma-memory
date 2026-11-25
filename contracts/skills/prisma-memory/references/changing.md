# Changing what is already in memory

Read before `memory_close`, `memory_delete`, `memory_promote`, `memory_correct`, `memory_plan`, `memory_apply`,
`memory_process_now` or `memory_space_*`. These change who sees what: call them only on the person's explicit request
in this conversation about specific records; never "improve" access on your own.

## One record

| The person asks | Call | Say |
|---|---|---|
| "hide it from agents", "close it" | `memory_close` | agents stop finding it at once; whoever read it has read it; only the person can show it again, in the workspace |
| "delete it" | `memory_delete` | it is in the trash and purged after the retention period; only the person can restore it or delete it for good ("Trash") |
| "move it to the project / the team" | `memory_promote` with `to_space` | who sees it now (from the answer); the class does not change |
| "for the whole company", "bring it back" | `company-knowledge.md` | |
| "show it to agents" | `open-check.md` | |
| "this is wrong / outdated" | `memory_correct` (below) | |

- Who may: close and delete — the author and the space owner; move — the author.
- Other people's records, even when you act for the space owner: only when the person asks about specific ones. The
  server would allow more; this rule does not.
- Outdated or wrong: correct, don't delete. Delete only on the person's word.
- More than one record: a plan (below), never a loop of single calls.
- `in_progress` with `retry_after`: repeat the same call later.

## Bulk plan

1. `memory_plan`: the exact list and consequences; nothing changes. Exactly one of `ids`, `criteria` or `correct`.
   "Delete my notes about X": `{"op": "delete", "criteria": {"author": "me", "query": "X"}}`.
2. Show the person the list with titles and consequences. They exclude something: `exclude_ids` (the id ends each
   line of the list; don't show ids to the person).
3. `memory_apply` with the `plan_id` of exactly the list the person saw, after their explicit "yes" in this
   conversation. Don't build a new plan after the "yes": they have not seen its list.

- `status: applying` with `remaining > 0`: continue with the same `plan_id`.
- `plan_expired`: build a new plan and show the list again.
- `apply_via: workplace`, or `forbidden` with `workplace_only` (several spaces, over the limit, a script key, `purge`,
  `correct_bulk`): the person applies it in the workspace — pass the link on.
- Showing records to agents in bulk is not supported.

## Corrections (`memory_correct`)

Nothing is deleted: a correction or a new version is put beside the record.

| What is wrong | `kind` | Pass |
|---|---|---|
| a meeting event was extracted wrongly | `extraction_error` | `fields` — only what changes (`title`, `statement`, `due`, `actors`); `quote` — a verbatim phrase from the transcript, only if the person gave it |
| said so, but wrong in substance | `wrong` | `text` — what is right, in the person's words |
| no longer applies | `outdated` | `newer_id`, or `text` — what applies now |
| the person's own note | `own_note` | the new `text` |

- `origin: human` only for the person's words from this conversation. On your own you may only replace your own note
  (`own_note`) or mark a record outdated when a newer one exists (`outdated` with `newer_id`). Never correct by a
  guess: ask.
- `status: applied`: corrected. `status: proposed`: say "I sent the correction for a decision: the author or the
  owner will confirm it" and give the link ("Record edits", `/corrections`).
- `quote_not_found`: ask the person to copy the phrase exactly, or correct without a quote. `quote_not_allowed`: you
  cannot see the meeting — correct without a quote. `not_current`: take `current_id` from the answer.
  `already_known`: don't send it again.
- You cannot see the meeting or the event (`not_found`): don't correct something else instead. The person corrects it
  on the meeting page ("Meetings with me", `/meetings`).
- Never delete a meeting event: re-extraction brings it back. Wrong — `wrong`; cancelled — `outdated`.
- A correction is saved in the record's class: into the open, without personal data, contract numbers or secrets.
- After: say what was corrected, where, and who will see it.

"In all decisions of the meeting, B instead of A": `memory_plan {"op": "correct_bulk", "correct": {"meeting_id":
"<meeting id>", "actors_map": {"from": "A", "to": "B"}}}`, show the list, give the link — only the person applies it.
You cannot see the meeting: the person does the same on the meeting page.

## Spaces, members, processing

- `memory_space_add_member`, `memory_space_remove_member`: the space owner, on the person's explicit request. A membership that comes from
  a directory group, an assignment or the org table is removed at its source (`invalid_argument`): retell the answer.
- `memory_space_create`, "create a project": `spaces.md`.
- `memory_process_now`: only with the person's consent; it moves a record to the front of the processing queue.
- Keys, permissions and roles: only the person ("Keys and agents") and the administrator.
