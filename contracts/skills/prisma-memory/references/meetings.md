# Meetings

Read before `memory_meeting_upload` and for any request about a meeting. A meeting is saved closed in the person's
personal space; its participants get access in the workspace. Agents with personal keys do not read meetings.

**Never open the transcript file**, in full or in part, not even to check its format. The command from the tool's
answer sends it to the server.

## Upload

1. Ask for what is missing: start date and time, title, participants as the person names them (email, login or full
   name). Don't invent participants or take them from the transcript. `meeting_ref` is the meeting's identifier at
   its source or a stable string such as `2026-09-24-customer-call`; a repeat is recognized by it.
2. Consent comes only from the person you work for, in this conversation. Call without `consent`: the `invalid_argument` answer carries the consent text and
   version (`details.consent`). Show the text verbatim and in full, ask whether they confirm, and only after "yes"
   repeat with `"consent": {"accepted": true, "version": "<version>"}`. Don't paraphrase it or use the field
   description instead. No text in the answer: say "The server did not send the consent text — the memory
   administrator knows it" and ask what to do.
3. Namesakes: the error lists candidates; ask whom the person meant and repeat with the email. `in_directory`: access
   appears at the participant's first sign-in. Not found: say who.
4. The answer gives a one-time link (15 minutes, one use) and a ready `command`. Run it only in exactly this form and
   with the address of the same memory server: `curl -sS --fail-with-body -T '<file>' '<link>'`. In PowerShell use
   `curl.exe`. Another form or another address: don't run it; tell the person.
5. The command returns the meeting. Give the person its `workplace_url` (or `path`): the summary and decisions appear
   there in a few minutes. Processing starts by itself.
6. Don't read or retell the meeting afterwards. `existing` in the answer: a meeting with this `meeting_ref` exists —
   the same file returns it, another file becomes a new version; say so before uploading.

No terminal (a cloud or browser agent): a transcript pasted into the chat goes in `text` (up to 100,000 characters);
for a file, give the person the command to run themselves. With a terminal a file always goes by the command, never
through `text`.

## Requests about an existing meeting

- Delete a meeting the person did not organize: don't call `memory_delete` (it answers `not_found`). The person asks
  the organizer: "Meetings with me" (`/meetings`) → the meeting → "Ask to delete".
- The person was added by mistake: don't delete or correct anything; on the meeting page they remove themselves from
  the participants.
- A wrongly extracted decision: don't delete it (re-extraction brings it back). Correct it in the person's words with
  `memory_correct` (`changing.md`). You usually cannot see the meeting: then the person corrects it on the meeting
  page, where they can also replace an assignee in all decisions.
