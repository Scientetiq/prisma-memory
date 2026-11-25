# Memory export format `prisma-memory-export/1`

The open format in which Prisma Memory exports a space (a person in the workplace) or the whole instance (the operator,
with a server-side job). An export is one gzip-compressed POSIX tar archive (`ustar`, with `pax` extended headers for
long or non-ASCII names). Any `tar` reads it: `tar -xzf <file>`.

Versioned contract `memory-export`; the version is `x-version` of
`manifest.schema.json` and the `version` field of every `manifest.json`. A change of this folder raises the minor
version and adds a note to `x-version-notes`.

## Layout

```
README.md                                   what the archive is and how to read it
spaces/<slug>/space.json                    name, kind, default class, description, created_at, owner, archived_at, export_scope
spaces/<slug>/<type>/<yyyy>/<mm>/<id>.md    YAML front matter, then the text in Markdown
spaces/<slug>/<type>/<yyyy>/<mm>/<id>.json  full metadata of the record (record.schema.json)
spaces/<slug>/originals/<id>/<file name>    the original file, byte for byte as it was stored
index.jsonl                                 one line per record (manifest.schema.json, $defs/indexLine)
manifest.json                               the LAST entry (manifest.schema.json)
```

- `<type>` is one of `document`, `transcript`, `event`, `summary`, `profile`, `note`; `<yyyy>/<mm>` is the UTC year and
  month of `occurred_at`; `<id>` is the record id (UUID).
- The record path is the path agents cite: `/spaces/<slug>/<type>/<yyyy>/<mm>/<id>`. Strip the leading `/` and add
  `.md` or `.json` to find the record in the archive.
- `<file name>` is the uploaded name made safe: letters, digits, `.`, `_` and `-` only (anything else becomes `_`), no
  leading dots, at most 200 bytes with the extension kept, `original` when nothing is left. Entry names never contain
  `..`, never start with `/` and contain no control characters.
- Derived records (summaries and events of a meeting or a document) are records of their own with `parent_id`.
  Previous versions are included with `is_current: false`; records in the trash are not.
- Not exported: search chunks and embeddings, marks and fingerprints of the secrets check, access-control internals,
  storage keys, link-signing material, the audit log.

## The Markdown file

```
---
id: "0193b6a4-…"
path: "/spaces/team-sales/document/2026/11/0193b6a4-…"
title: "Pricing 2027"
type: "document"
event_kind: null
class: "closed"
origin: "human"
occurred_at: "2026-11-12T08:00:00.000Z"
version: 1
---

<the text of the record>
```

Strings in the front matter are YAML double-quoted scalars with escapes, so a title such as `---` or `!!tag` is read as
plain text by YAML 1.1 and 1.2 readers.

## Complete and incomplete archives

`manifest.json` is written last, and only when every record was written. If an export stops after it started, the
archive ends with `EXPORT-INCOMPLETE.txt` (the reason code and the last record written) and has **no** `manifest.json`.
An archive without `manifest.json` is incomplete. Reason codes: `audit_unavailable` (the audit log did not accept a
batch), `access_revoked` (the person lost the right to export the space while it ran: removed from the space, the
export switched off, the session ended), `time_limit` (the export ran longer than allowed, or stalled), `original_size_mismatch`
and `original_unreadable` (a file in storage did not match its size or could not be read), `internal`.

A record whose original file is missing from storage is exported without it: `original.missing: true` in its JSON and
`skipped.original_missing` in the manifest. An open record whose conversion and secrets check are not done yet is
exported without its file: `original.withheld: "unchecked"` (`file`, `bytes`, `sha256` are null) and
`skipped.original_unchecked`.

## What a space export contains

The records of that space (its home records, not records placed there from elsewhere) that the exporting person can read
there, of both classes, as of the moment each batch of records is read. Records the person cannot read (for example a
meeting shared with named people only) are counted in `skipped.no_access`; records deleted while the export ran — in
`skipped.gone`. A record whose class was being changed at that moment (shown to agents or hidden from them) is in
neither class: it is counted in `skipped.moving` and the archive is still complete — export again once the change is
done. A record that changed class while the export ran is written once (`skipped.moved` counts the later copy that was
left out); the rights of the exporting person are checked again before every batch. Every export is in the audit log before the first byte is sent; closed records are logged by id.

## What an instance export contains

The server operator exports the whole instance with a job on the server (`run-job.ts export_instance --out <dir>
[--space <slug>] [--no-originals]`); there is no HTTP route for it. The archive holds every record of both classes that
is not in the trash, previous versions included, of every space of the instance (or of the one space named by
`--space`); `by` is `null` and `scope.kind` is `instance`. Records hidden from everyone at that moment (their class was
being changed, or they were held back after a failed check) are in it too, each once, with `hidden: true` in their JSON;
`skipped.moving` does not occur in an instance export. Every original is written exactly as stored, with the stored size. It is written to
`prisma-memory-export-<instance>-<YYYYMMDD>T<HHMMSS>Z.tar.gz` (UTC) with mode `0600` inside the directory the deployment
allows (`MEMORY_EXPORT_DIR`), and never overwrites a file. With `--no-originals` every original is left out:
`original.withheld: "excluded"` in the record JSON and `skipped.originals_excluded` in the manifest. Records whose space
is not a space of this instance are counted in `skipped.no_space`. The start of the export is in the audit log and raises a
high alert before the first record is read.

The archive is plain data: whoever holds the file can read every record in it, including records hidden from AI agents.

## Examples

`examples/manifest.json` and `examples/record.json` are valid instances of the two schemas.
