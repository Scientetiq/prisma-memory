# Documents

Read before `memory_upload` and when a read shows `conversion`.

## What is accepted

- Formats: only by `memory_me.upload.accepted_formats`, not by what you know. Markdown and plain text always; PDF and
  office files when the instance has a converter and the administrator enabled them. Size: `memory_me.upload.max_bytes`.
- Refused: macros, a password, old `.xls`, a name that does not match the content, a damaged archive. The refusal
  already says in plain words what to do: retell it.
- Don't go around a refusal: no renaming, no changed type, no rewriting a spreadsheet as a note, no converting the
  file yourself. The person decides.
- A meeting transcript is not a document: `memory_meeting_upload` (`meetings.md`).

## While it waits

Until the text is ready `memory_read` shows `conversion.status: pending` and `conversion.phase`. Say it in plain
words:

| `phase` | Say |
|---|---|
| `queued` | "Waiting in the queue for the converter", with `position`: "3 documents ahead of it" |
| `uploading` | "Being sent to the converter" |
| `at_converter` | "At the converter since 14:05" (`since`, the person's local time); not "being recognized" |
| `retry_later` | "Some pages are not recognized yet — the converter will process the document again later" |

- Don't upload the file again, under any name: it returns `already_known` and keeps its place.
- `memory_process_now` only on the person's request; for a waiting document it only checks the state. Don't promise
  a speed-up.
- `status: failed`: retell the reason from the answer; the author can run "Process now" on the record page.

## The file and the text

- `conversion.agent_file: false` (for a finished document a lean answer shows `conversion` only with
  `include: ["details"]`): the text is available to agents, the file only to people in the workspace
  (`original.url` is empty for you). Always so for office files, and for files with pictures, comments, attachments,
  form fields or scanned pages.
- Answer from the text. Say "I cannot open the file itself — it is available to you in the workspace" and link the
  record (`/records/<id>`). Don't invent what the pictures show.
- Speaker notes, hidden slides and hidden sheets are in the text: say so when you rely on them.
- A document with scanned pages is not accepted into a shared space. In personal it is closed; only the author can
  show its text to agents, in the workspace (`open-check.md`).
