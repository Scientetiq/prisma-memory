# Spaces: where a record goes and who will see it

Read when the choice of a space is not settled by the core: a team, closed or archived space, an extended or script
key, "create a project".

## Who sees what

- Open record: the space's members and their AI agents. You find it next session; in personal, so do the person's
  other agents.
- Closed record: only people in the workspace (and keys that read closed records). You can save one, but you will not
  find it next session.
- The class of a new record comes from the space (`memory_me.spaces[].default_class`), in personal from the key
  (`key.personal_class`), never from the kind of the space. Meetings are always closed.

| `kind` | Say to the person | Who sees | Who writes |
|---|---|---|---|
| `personal` | "Personal" | the person (open: their agents too) | the person and their agents |
| `project` | "Project" | the project's members | `owner`, `member` |
| `team` | "Team" | the members | `owner`, `member` |
| `org` | "Company knowledge" | all employees | `owner` only (`company-knowledge.md`) |

Role `reader` gets `class_denied` on a write. Not a member, or no such space: `not_found` (the two are not told apart).

## Choosing

- The person named a project themselves: find it in `spaces` (kind `project`, role `owner` or `member`), ask them to
  confirm, write there.
- Team space: on a direct "for the team", or from the hint of an `open_check` refusal (`open-check.md`). It is usually
  closed: warn "I won't read it with this key".
- Role `reader`, not a member, no such space: say that the project's owner gives access. Don't write elsewhere.
- Several project lines, project or team, disputable content: ask.
- Work shared with colleagues but no project line: save to personal and suggest creating a project.
- A record written to a project gets the entity `project:<slug>` by itself. For a personal record about a project
  pass `entities: ["project:<slug>"]`.
- The project line sets the search context; it does not give the right to write.
- A lasting preference about how you work: look for the `profile` field in the `memory_me` answer.
  - The field is there, `profile: null` included (profiles are on; `null` is an empty profile or one the person hid
    from agents): `memory_remember` with `kind: profile`, `origin: human`, `mode: append`, no `space`, and
    `section: agent` (how you answer and work for them) or `work_with_me` (how people should work with them); `text`
    is the lasting fact in their own words. Always `mode: append`: it adds a line; without it `text` replaces the
    whole section. A preference that reverses an earlier one is added the same way: the new line, in their words or
    words they approve, says what it replaces. Never edit or delete a line a person wrote. Then say it is in their
    work profile. Refused: pass on the reason and keep the preference in your own notes.
  - No `profile` field (profiles are off or not given to this key): write nothing to memory; keep the preference in
    your own notes and say so.

## Personal: what to say after saving

By `memory_me.key.personal_class_reason`:

| Reason | Class | Say |
|---|---|---|
| `notebook` | open | "Saved: you and your agents see it." |
| `notebook_off` | closed | "Agents' records in your personal space are closed now, so I won't read this one. You can make new ones open in 'Keys and agents'." |
| `script` | closed | "The record is closed and cannot be read with this key." Only the person can show it to agents, in the workspace. |
| `reads_closed` | closed | "The record is closed: only people in the workspace see it, and this key reads it." |

The switch affects only new records. The person chooses the key's mode; you don't change it. A connection through a
company account (`key.kind: connection`) behaves like a personal key.

## Extended key (`key.kind: extended`)

It reads the person's closed records, so by default it does not write to open spaces. `key.open_write_mode`:

- `allowed` or absent: an ordinary key.
- `denied`: any write, upload, move or correction that lands in the open answers `class_denied` with
  `details.gate: extended_open`. Don't go around it (a neighbouring open space, split or reworded text, a later move).
  By `details.attempt`:
  - `remember`, `upload`: save to personal (`space: me`, closed for this key) and say: "I did not save it to
    '<name>': this key reads closed records, so it does not write to the open. I saved it in your personal space,
    closed. Only the memory administrator can allow this key to write to the open."
  - `promote`, `placement`, `correct`, `link`, `space_meta`: write nothing. Say the key cannot do this and give the
    link from the answer; the person can do it in the workspace.
- `marked`: the write goes through, is marked `extended_write` and logged. Write to the open only what all members may
  see; never move or retell closed content there (meetings, workspace documents, closed notes).

In a `memory_plan` list, items skipped with the reason `extended_open` are skipped for this key: say so.

## Archived projects

A finished project is archived: records stay readable, nothing new is written.

- A write answers `class_denied` with `details.archived`. Say "The project '<name>' is in the archive — nothing is
  written there any more" and ask where to save: personal, another project, or not at all. Don't choose yourself,
  even if the project line names the archived space.
- An archived project is not in `memory_me.spaces` (`archived_spaces` counts them). The project line names a space
  that is not there: before saying "no access", check `memory_list /spaces` with `filters.archived: true`.
- The person's own record there can be returned to personal (`"to_space": "me"`), deleted or closed; it cannot be
  moved to another project.

## Creating a space

- "Create a project": the person does it in the workspace, "Spaces and projects" → "New project" (`/projects/new`);
  they become its owner, and it is open by default. Give the link; don't call `memory_space_create`. The project
  page then gives the line for the repository.
- `memory_space_create` makes a closed team space: only on a direct "create a space for the team". Warn that agents
  with personal keys don't read records there. Its name, description and slug pass the open check; name an NDA
  customer by the project's code name.
- Limit refusal (`invalid_argument` with `details.limit`): "You already have N projects and spaces — this is the
  limit. The memory administrator can archive unneeded ones or raise it."

## What memory holds

- Holds: meeting transcripts (closed; summary and decisions appear within minutes), documents with their originals,
  events (`decision`, `action`, `question_risk`, `fact`) with a quote, employee profiles, notes of people and agents.
- Does not hold: live records of source systems (CRM deals, tasks) — only their identifiers as entities (such as
  `crm:deal:123`); anything uploaded before the launch; anything outside your permissions.
