# Changelog

All notable changes to Prisma Memory are recorded in this file. The project uses semantic versioning.
Changes to the MCP tool contract and the REST API are recorded per contract version in
[`contracts/MCP-CHANGELOG.md`](contracts/MCP-CHANGELOG.md).

## 0.1.1 — 25 November 2026

Maintenance release: dependency updates that clear the known advisories, and a smaller admin panel image. Nothing
changes in how Prisma Memory is used or configured.

To move an installation of 0.1.0 to this release, check out the tag `v0.1.1` in the same folder and run
`deploy/compose/setup upgrade` ([upgrade](docs/installation.md#upgrade-and-backup)).

### Changed

- The admin panel image is built in two stages and holds only the packages the panel needs to run; the test tooling
  is no longer in the image.
- `@hono/node-server` 2.1.11, with the MCP SDK 2.4.0 and `@modelcontextprotocol/node` 2.1.2 that it requires.
- Development tooling: `vitest` 4.1.12 and `vite` 7.3.8; the `esbuild` copy under the database tooling is 0.25.12.

### Known limitations

- Two packages under the storage client `minio` 8.0.7 (its newest release) still carry advisories: `stream-json`
  1.9.1 and `decode-uri-component` 0.2.2. `minio` cannot load their fixed versions. Prisma Memory does not call the
  affected code: it never listens to bucket notifications, and `minio` only builds query strings with these packages,
  it does not parse them.
- The limitations listed under 0.1.0 still apply.

## 0.1.0 — 24 November 2026

First public release of a self-hosted memory server for AI agents. Agents look up stored documents, meetings and
decisions with the access rights of the person they act for.

### Included

- Connect AI agents over MCP with a personal key or browser sign-in, and let them save notes and decisions. The
  connection commands that the workplace and the panel show name the server `prisma-memory`.
- Browse spaces and records in the web workplace.
- Manage settings, people and keys, and view the audit log and installation health in the admin panel.
- Upload documents and meeting transcripts, up to 20 MiB per file; their originals and versions are kept in their
  spaces.
- Search by keyword, or connect an embedding model to also search by meaning. Results quote the source and show where
  each quote comes from.
- Choose chat and embedding models and set which models may receive open or closed records. With a chat model
  configured, background processing writes summaries and extracts events and decisions.
- Create the first administrator with a one-time install code. People sign in through LDAP or OpenID Connect, or with
  an e-mail and a password on an account that an administrator makes in the panel.
- Defaults are international: English, the time zone UTC, times in notices as `YYYY-MM-DD HH:MM UTC`, and
  `windows-1252` for legacy text that is not UTF-8. The administrator can change the language, the time zone and the
  code page.
- Install the server on Linux with Docker Compose.
- Back up and restore an installation by the documented procedure.
- Upgrade an installation to a newer release with `deploy/compose/setup upgrade`: it copies the database first, rolls
  back on its own when the new version fails to start, and `setup upgrade --rollback` goes back on demand.

### Known limitations

- Preparing the server requires root. The installer's preflight check covers Docker, memory, disk space and the
  required tools.
- Access from the internet is a preview. HTTPS needs separate setup.
- PDF processing needs an external document converter.
- A meeting uploaded by an agent stays out of agent search until someone opens it in the workplace.
- Most messages that the server writes itself, such as API errors, tool answers and notices, are in English only. The
  sign-in and local-account messages of the gateway, the admin panel, the workplace, e-mails and the MCP tool
  descriptions also have a Russian version.
- Backups are manual and need the installation stopped; the copy that `setup upgrade` keeps is on the same disk and is
  not a backup. A restore needs the same version and paths as the backup.
- The repository holds the product, not its test suites; see [CONTRIBUTING.md](CONTRIBUTING.md).
