# Errors, keys and workspace pages

Read when an error's own hint does not settle what to do, or when you need to send the person to a workspace page.

An error is `<code>: <message>`, then optional lines `Hint:` (what to do next), `retry_after:` (seconds), `Reason:`
(retell it to the person) and `Link:` (a workspace page for the person). Never name the code to the person; retell
the meaning. A tool this skill names is missing from your list: call it as an action of `memory_manage` or
`memory_manage_destructive` (`memory_manage {"action": "help", "topic": "<action>"}` gives its description and
schema); the same rules apply. Otherwise, where your tool list and this skill differ, trust the list.

## Codes

| Code | Do |
|---|---|
| `not_found` | Say it was not found or is not available. Don't try other identifiers. |
| `class_denied` | The space is read-only for this key: tell the person, don't write elsewhere. `details.archived`: ask where to save. `details.gate: extended_open`: `spaces.md`. |
| `open_check` | `open-check.md`. |
| `never_open` | A rule forbids opening: explain the reason. |
| `forbidden` | Only the person does this: pass on the link (`details.workplace_url`, the `Link:` line, or `details.workplace_path`). Don't open it yourself. |
| `rate_limited` | Wait `retry_after`, repeat the same call. `details.reason: upload_daily`: don't repeat — "you can continue tomorrow, or ask the administrator to raise the limit". `disk_low`: don't repeat — the person tells the memory administrator; reading and search still work. |
| `in_progress` | Repeat the same call after `retry_after`. |
| `invalid_argument` | Read the text. `memory_read` with `search_id`: repeat without it. A meeting without consent: `meetings.md`. `memory_correct`: `changing.md`. |
| `too_large` | Shorten the text, or upload it as a document. |

## Connection and keys

- No `memory_*` tools: the server is not connected (the core has the phrase). In a chat product without MCP: say that
  memory works from an agent connected to it, such as a coding agent on the person's computer.
- `memory_me.key.expires_warning`: pass it on; the person issues a new key themselves.
- A revoked or expired connection needs a new sign-in from "Connect an agent". Never ask for a password, a token or a
  key, and don't try to get around a revocation.
- A service key has only the operations allowed to the service and no plans.

## Workspace pages

Address: `memory_me.workplace_url` plus the path. No address: name the section.

| Section | Path | For |
|---|---|---|
| "Overview" | `/` | what is new; quick actions |
| "My records" | `/materials` | upload a document, write a note, the person's records |
| "Meetings with me" | `/meetings` | the person's meetings; ask to delete, leave, correct a decision |
| "Trash" | `/trash` | restore or delete for good |
| "Bulk changes" | `/plans/<id>` | apply or cancel a plan |
| "Record edits" | `/corrections` | confirm, reject or withdraw a correction |
| "Search" | `/search` | search that includes the person's closed records |
| "Spaces and projects" | `/browse`, `/projects/new`, `/projects/<slug>` | spaces; create a project; members, the repository line, settings |
| "Colleagues" | `/colleagues` | find a colleague and their records |
| "Company knowledge review" | `/review` | curators only |
| "My actions" | `/activity` | what was done on the person's behalf |
| "Connect an agent" | `/connect` | connect an agent, install these rules |
| "Keys and agents" | `/keys` | keys; whether agents' personal records are open |
| a record | `/records/<id>` | show to or hide from agents, return to personal, correct, marks |
