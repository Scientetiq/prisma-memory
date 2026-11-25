# Glossary

This glossary explains the product terms and implementation terms used in **Prisma Memory** documentation.
Use the product terms when explaining access and records to people; use the technical names when investigating a
failure.
See also: [configuration](./configuration.md), [installation](./installation.md), and [models](./models.md).

## The essentials in one minute

- A record is stored content; a space groups records and their membership.
- A data class controls which database stores a record; membership still determines who can read it.
- An agent key identifies the caller; it does not grant access to every space.
- Processing prepares records for search and extracted results.

## Product terms

| Term | Meaning |
| --- | --- |
| Instance | One installation identity, used to scope settings, people, and spaces |
| Record | A stored item with an identifier, content, type, owner, space, and version |
| Space | A named collection of records with an owner and membership rules |
| Personal space | A person's own space; the schema permits one per person |
| Project space | A space of kind `project`, with its own owner and members |
| Organization space | A space of kind `org`; the schema permits one per instance |
| Slug | A space's unique short identifier, used instead of its display name in paths and tool arguments |
| Data class | The `open` or `closed` classification that selects the record database |
| Open record | A record in the open database; readable only when the caller also has the required access |
| Closed record | A record in the closed database; the closed class does not by itself grant anyone access |
| Owner | The person associated with a record or space as its owner |
| Member | A person assigned to a space, with an owner or member role |
| Agent key | A credential used to authenticate an agent; the key's scope and caller's visibility limit what it can read |
| Personal key | An API key associated with a person, represented by the `mem_p_…` prefix |
| System key | An API key for system operations; it is distinct from a personal agent key |
| Current version | The record version selected by `is_current`; deleted versions are excluded from `records_live` |
| Processing stage | A tracked step for a record, with a status, attempt count, and possible retry time |
| Open check | Checks applied before content can be written as an open record; a failed checker can refuse the write |
| Setting | A category/key pair with a JSON value, a default, and metadata describing secrets and required values |
| Approval | A second-signature request that can hold a protected change until its approval requirements are met |

## Developer terms

| Term | Meaning |
| --- | --- |
| Gateway | The service exposing the REST routes and MCP interface |
| Worker | The process that claims and runs queued record processing work |
| Contract | A checked interface definition, such as an SQL schema, MCP tool schema, or API schema |
| Control database | Database holding settings, identities, spaces, and record locations |
| Record database | A database dedicated to one data class, guarded against writes of the other class |
| Locator | A `record_locations` row identifying a record's class, space, and owner |
| Live record view | `records_live`, which filters out deleted and non-current record versions |
| Chunk | A text part associated with a record, with section, page, or time information for retrieval |
| Embedding | A vector stored for a chunk and an embedder identifier |
| Embedder | A registered vector-preparation version, with an identifier and an active flag |
| Full-text search | Text matching through the chunk's indexed `tsv` field |
| Signed anchor | A signed configuration input that pins values or secret fingerprints and can impose a security floor |
| Effective setting | The value a reader receives after defaults, pins, and security-mode rules have been applied |
| Encryption key identifier | The `enc_kid` stored with an encrypted setting, selecting the decryption key |
| Health check | A named diagnostic result with `ok`, optional detail, and an optional severity level |
| `fail_closed` | A health state that makes the health endpoint return HTTP 503 and blocks normal requests |
| `degraded` | A health state reported with HTTP 200, indicating a failing check without the global fail-closed response |
| `not_found` | The response used by record reads when the requested record is absent or unavailable to the caller |

## If something goes wrong

Use [troubleshooting](./troubleshooting.md) to connect a symptom with its diagnostic check and next action.

---

[README](../README.md) · [Quick start](./quickstart.md) · [Installation](./installation.md) ·
[Backup and restore](./backup.md) · [Configuration](./configuration.md) · [Models](./models.md) ·
[Troubleshooting](./troubleshooting.md) · [Glossary](./glossary.md)
