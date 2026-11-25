# "Company knowledge" (`org`)

Read before any write, move or return that involves `org`. All employees and their agents see this space. To the
person say only "Company knowledge"; `org` appears only in calls.

## Writing

- Role `reader` (almost everyone): `memory_remember` there answers `class_denied`. Say: "The owner and curators add
  records there; the memory administrator appoints them. I can save it in your personal space or a project." Don't
  offer to save to personal and move it there afterwards.
- Role `owner` (the space owner and curators): only on a direct "for the whole company", and after "yes" to "All
  staff and their agents will see it. Save for the whole company?" — even if the request sounded like "write it down".

## Moving the person's own record there

Any author, a `reader` too: `memory_promote {"id": "<id>", "to_space": "org"}`. Only when asked about that specific
record, and after "yes" to: "All staff and their agents will see it. It can be returned, but whoever read it has read
it. Move it?" An open record and its derived records are checked on the move: a finding is an `open_check` refusal and
the record stays. A closed record moves unchecked and stays closed.

**Returned before: don't move it again**, even on "yes". If you know the record was returned or deleted from there
(`org_return` in `memory_me.recent_actions`, the person said so, or you read it), don't call `memory_promote`: only
the person can move it again, on the record page (`<workplace_url>/records/<id>`). A `forbidden` refusal with a link
means the same: pass the link on; don't write a copy.

## Returning to personal

"Bring it back": `memory_promote {"id": "<id>", "to_space": "me"}`, at once.

- Only the author; someone else's record answers `not_found`.
- Colleagues stop finding and reading it immediately. Say: "The record is in your personal space again. Those who
  read it have read it."
- The summary, decisions and earlier versions return with it; meeting participants keep access. Returning a derived
  record returns only that one.
- A record in the trash must first be restored by the person ("Trash").
- Several records: only by specific ids, through `memory_plan`; never by dates.

## Review by curators

- A new record is visible to everyone at once, marked `org_review: unreviewed` and ranked lower; an agent's record
  always starts so. Rely on it with "the curators have not reviewed it yet" and the path.
- `confirmed`: by a curator. `community`: by colleagues' "Useful" marks. `disputed`: marked "Wrong / not for
  everyone" — don't present it as correct.
- An unconfirmed record goes back to where it came from when its term ends.
- "Useful", "Wrong" and curators' decisions are set only by people on the record page; an agent has no tool for
  marks (`search_id` is not a mark). Give the link `<workplace_url>/records/<id>`; for a curator, "Company knowledge
  review" (`/review`).
- A curator's agent does not move, return, close or delete other people's records here: `forbidden` with a link —
  pass it on. A mistake in a record: tell the person; correct it in their words with `memory_correct` (`changing.md`).
