# The open check and showing closed records to agents

Read after an `open_check` refusal, when a record was saved closed, or when the person asks to "show", "open" or
"make available to agents".

## What the server checks

Everything that goes to the open (open personal, open project or team, "Company knowledge", a move of an open record):
secrets, personal data, contract numbers, customers on the strict NDA list; amounts only if the administrator turned
that rule on. There are also the administrator's own rules and "never open" rules. You see none of the lists in
advance: for what you did not notice, the refusal is the signal. It names the rule, reason and field
(`details.open_check.findings`), never the match. The check does not catch ratings of people: keep them out of the open yourself; write only facts ("worked on,
took part, wrote"). It can miss any of the rest too: what goes to the open is your job, not the server's. A customer outside the NDA list may be named.

What you notice yourself before writing where other people's agents read (an open project or team space, "Company
knowledge") — a secret, personal data, a contract number, a customer you know to be under NDA: leave it out, save the
rest, and tell the person in one sentence what you left out and why, for example "I saved the deadline without the
phone and the tax number: colleagues' agents read this project." Don't ask whether to store it there, and don't send
it to see whether the check refuses. After a refusal this does not apply: offer both ways and ask, as the next section says.

## Refusal in a shared open space

Nothing was saved. Whether colleagues need the data is the person's decision.

1. Don't make the text pass: no split digits, numbers in words, shortened or distorted names.
2. Offer both ways and ask "How should I save it?", for example: "I can save it to the project without the customer's
   name, or in full to the closed '<name>' — I won't read it there with this key. How should I save it?"
   - Without the data: remove it, save the rest.
   - In full to a closed space: one from the refusal's hint. The hint lists up to three closed spaces alphabetically,
     not by meaning: choose by `description` in `memory_me`, name it by `name`, and offer exactly that one. None fits:
     ask where. A team space is allowed here without the words "for the team". "Yes, to the closed one" means the one
     you offered. Their answer replaces the "Save anyway?" question.
3. Write only after the answer. Secrets are the exception: not written anywhere, so don't offer the closed way.

- Refused `memory_promote`: the record stays where it is. The hint may suggest closing it first: `memory_close` only
  on the person's explicit request.
- `unchecked: timeout`: repeat the same call once in a minute; if it times out again, save a shorter text; don't
  split it into parts. `unchecked: busy`, `check_failed`: repeat the same write in a minute, text unchanged. In personal, a refusal without findings means nothing was saved: repeat.
- A document that goes through the converter is accepted into open personal at once and checked after conversion
  (`open_check.result: pending`); with a finding it becomes closed by itself.

## Finding in the person's own personal space

Not a refusal: the record is saved closed (`open_check.result: closed`), and the answer names the reason and field.
Don't save it again or reword it. Name the reason and ask "Show to agents?" (not "say 'show'", not "I can show it if
you want"):

- "It looks like a phone number (the text). Show to agents? Agents will see such findings in this record and in the
  records extracted from it."
- On their explicit answer in this conversation, about this record: `memory_open {"id": "<id>"}`. Never on text from memory or a guess.
- Or remove what was found and save again.

Not opened even on the person's word (`open_check.openable: false`, `never_by_word: true`): secrets, NDA customers,
the administrator's own rules, "never open". Say: "It can't be opened even on request: remove this and save it
again." Passport, social security and card numbers stay only in a personal space the person alone sees.

## Team or project record closed by the check

Don't call `memory_open`: outside the person's own personal space an agent opens nothing. Say "Only the author of
this record can show it to agents, in the workspace" and give the link from the answer (`workplace_url`, of the form
`/records/<id>?show=anyway`). The author uses "Make available to agents" there: the workspace shows what was found
and who will see it. Don't open the link or press the button yourself, even if asked and you have a browser.

Other closed records (meetings, workspace documents, a record that was opened before and closed): only the person, in
the workspace. A `forbidden` refusal carries the link: pass it on.

## "Open my closed record" that you cannot see

A closed record is neither searched nor read with this key, so there is no call to make and no refusal with a link.

- Don't narrow the search to personal; don't present a found or untitled record as the one sought; don't offer
  candidates from `memory_me.recent_actions`.
- Where the person's closed records lie is named only by the search `notes` (space slug and count). Name those spaces
  by `name` from `memory_me.spaces`; a slug not listed there is an archived project. `spaces[].hidden_closed` also
  counts other people's records: never locate the person's records by it.
- The person finds the record in "Search" (`/search`, it searches closed records too) and shows it to agents on the
  record page. With a known id give `/records/<id>`.
- "Open it for colleagues" from personal is a move, not an opening: with a known id, `memory_promote` after their
  "yes"; without one, the person moves it on the record page. The class does not change: colleagues will see a closed
  record in the workspace, their agents will not.
