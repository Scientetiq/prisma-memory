# Configuration

This guide is for administrators who configure **Prisma Memory** after installation.
It explains settings, startup variables, secrets, language, time zones, and changes without the panel.
See also: [installation](./installation.md), [models](./models.md), and the [glossary](./glossary.md).

## The essentials in one minute

| Area | Required | Where to configure | How to check |
| --- | --- | --- | --- |
| Application settings | Required keys are flagged in the registry | Administrator panel or settings API | Read `missing_required` from the settings API |
| Startup credentials | Instance identifier and database credentials | Installation environment for the instance identifier and credential files for database access | Check process startup and health |
| Model connections | Depends on the configured processing features | Model settings | Inspect the model checks in health |
| Agent text language | Optional | `locale.mcp_language` | Start a new agent session |
| Protected settings | Depends on the security mode and setting policy | Administrator panel, approval, or signed anchors | Inspect the API response and effective value |

**Settings live in the database.** Environment variables provide startup information; they do not replace application
settings.
The machine-readable inventory is [the settings registry](../contracts/settings/registry.json).

## Settings and defaults

**What it provides.** Each setting belongs to an instance and has a category, key, value, and default value.
The category and key form a name such as `processing.night_window`.

The administrator settings API returns masked values, defaults, types, and missing required keys.
Changes use JSON values: `true` is a boolean, `"true"` is a string, and `null` explicitly clears a value.
A value with the wrong JSON type is rejected when the default defines its type.

**Settings:**

| Categories | Purpose |
| --- | --- |
| `models`, `retrieval`, `search` | Model requests, vector preparation, and search behavior |
| `processing`, `limits` | Processing schedules and resource limits |
| `storage`, `integrations` | Object storage and optional connected services |
| `access`, `security`, `admin` | Access policy, security mode, and administrator controls |
| `ldap`, `oidc`, `oauth`, `agent_auth` | Directory, human sign-in, and agent authorization settings |
| `smtp`, `observability` | Mail and operational reporting |
| `meetings`, `open_check` | Meeting handling and checks before writing open records |
| `onboarding`, `topics`, `approvals` | Optional onboarding, topic, and approval features |
| `edge` | External access services |
| `locale` | Installation language, installation time zone, agent text language and the code page of legacy text |

On reads, most object values merge at the top level: code fallback, then seed default, then stored fields.
`oauth.allowed_clients` and `agent_auth.dcr_limits` are read whole, so removed fields do not reappear from defaults.
An unset value uses the caller's fallback; clearing a required key can make the instance refuse normal requests.

**Address check.** Before it connects, the gateway checks every address that a server name of `ldap.servers`
resolves to. It skips a server whose name resolves to a refused address, such as a link-local or a cloud metadata
address.

**How to check.** Read the saved value through the administrator API and inspect health after a change.
Settings normally reload on a one-minute cache; the settings API forces a reload in the gateway handling the change.

**Common errors:**

| Condition | What to do |
| --- | --- |
| Wrong value type | Send the JSON type shown by the setting's default |
| Unknown key | Check the key against the installed registry; saving does not create new settings |
| Missing required value | Restore the required setting and check health again |
| Saved value differs from the effective value | Check signed anchors and the security mode |

## Startup variables

**What it provides.** Startup configuration identifies the instance and opens the databases before settings can be read.
On the Docker Compose install, `deploy/compose/setup` prepares all of it: it writes `MEMORY_INSTANCE_ID` into
`deploy/compose/.env` and creates the credential files of each service under `secrets` of the home directory. Set
no password variable yourself.

| Variable | Purpose |
| --- | --- |
| `MEMORY_INSTANCE_ID` | Selects the installation's settings and data |
| `PG_PASSWORD` | Not used by the Compose install, which gives PostgreSQL a file through `POSTGRES_PASSWORD_FILE` |
| `PG_APP_PASSWORD` | Read only with `MEMORY_SECRETS_MODE=legacy-derived`, as the root of derived credentials. In the default mode `files`, a set `PG_APP_PASSWORD` stops the start |

Preserve the credential files and their key versions with the installation's recovery material.

The [environment allow-list](../contracts/env-allowlist.json) defines which application packages may read each variable.
It includes deployment and test controls; inclusion does not mean that an administrator should set every entry.

| Allowed names | Purpose |
| --- | --- |
| `PG_HOST`, `PG_PORT`, `MEMORY_INSTANCE_ID` | Database connection and instance startup |
| `PG_APP_PASSWORD` | Credential derivation in legacy mode |
| `PORT`, `HTTPS_PORT` | Process listener ports |
| `MEMORY_ROLE`, `MEMORY_WEB_ROLE` | Gateway, worker, and web process roles |
| `GATEWAY_URL`, `GATEWAY_ADMIN_URL` | Web process connections to gateway listeners |
| `MEMORY_ADMIN_LISTEN`, `MEMORY_WORKPLACE_LISTEN` | Separate administrator and workplace listeners |
| `MEMORY_CLI_LISTEN`, `MEMORY_CLI_SOCKET` | Administrator command listener and socket |
| `CREDENTIALS_DIRECTORY`, `RUNTIME_DIRECTORY`, `XDG_RUNTIME_DIR` | Service credentials and runtime directories |
| `NODE_EXTRA_CA_CERTS` | Additional certificate authorities trusted by Node.js |
| `MEMORY_ANCHORS_DIR`, `MEMORY_RELEASE_UPLOAD` | Signed anchors and release activation topology |
| `MEMORY_DISK_GUARD_PATHS` | Data filesystem markers used by the disk guard |
| `MEMORY_SCRYPT_PARALLEL` | Scrypt runs of local accounts at once (1 or 2); the gateway refuses to start when they do not fit its memory limit |
| `MEMORY_LOG_LEVEL`, `MEMORY_COMMIT`, `MEMORY_CONTRACTS_DIR` | Early logging, build identity, and contract location |
| `MEMORY_FIRST_RUN_CODE` | Initial administrator bootstrap |
| `MEMORY_LLM_REQUIRE_FLOOR` | Require the model request arbiter |
| `MEMORY_TEST_HOOKS`, `MEMORY_LLM_STUB` | Test-only switches: leave them unset |
| `NODE_ENV` | Next.js runtime mode |
| `DB_PASS` | A scanner example entry; it is not a configuration input |

**How to check.** Compare variable names with the allow-list and the installed deployment recipe.
Use the installation procedure to change startup credentials; changing a password alone can break decryption or database
access.

## Secrets

**What it provides.** Settings marked `secret` are encrypted with AES-256-GCM before they are written to the database.
The stored row carries an encryption key identifier, `enc_kid`, so the reader can select the matching key.

The legacy encryption key is derived from `PG_APP_PASSWORD` with HKDF-SHA256.
A service credential keyring can supply versioned settings keys; writes use its current key and reads select by
identifier.
The panel API masks populated secrets and rejects the displayed mask as a replacement value.

**How to check.** Inspect `isSet` in the masked settings response and `undecryptable` for secrets that cannot be read.
Keep actual secret values out of terminal arguments, shell history, issue reports, and copied health output.
Use a credential-aware recovery procedure when a settings key is missing; clearing ciphertext does not recover the
secret.

**Common errors:**

| Condition | What to do |
| --- | --- |
| Secret reported as undecryptable | Restore the matching credential key before changing the setting |
| Secret mask rejected | Leave the value unchanged or enter the actual replacement through a protected input |
| `access.link_signing_key` cannot be changed | Use its dedicated lifecycle procedure; the ordinary settings API cannot replace a populated key |

## Language and time zone

**What it provides.** `locale.mcp_language` selects English or Russian text for MCP tool descriptions and instructions.
Tool names and schemas remain the same in both languages.

| Key | Default | Purpose |
| --- | --- | --- |
| `locale.language` | `"en"` | Language of the installation: e-mails, alerts, the panel and other texts people see; accepts `en` or `ru` |
| `locale.timezone` | `"UTC"` | Time zone of the installation, an IANA name such as `Europe/Berlin` |
| `locale.mcp_language` | `"en"` | Language of agent-facing MCP texts; accepts `en` or `ru` |
| `locale.legacy_charset` | `"windows-1252"` | Code page for document text and imported people files that are not UTF-8: one of `windows-1250` to `windows-1258` |

Most messages that the server writes itself, such as API errors and tool answers, are in English whatever the language;
the sign-in and local-account messages of the gateway follow it.
Times in notices and security e-mails read `YYYY-MM-DD HH:MM UTC`.

Due dates written in words in meeting records ("tomorrow", "next Friday", "end of the month") are read in the
language of the installation, `locale.language`. In English the words are dates in the form `YYYY-MM-DD`, today,
tonight, tomorrow, the day after tomorrow, yesterday, this or next week or month, the end of the week or month, in N
days or weeks, and weekday names with this, next or last; other phrases give no date.

Days and hours in searches, plans and e-mails are counted in `locale.timezone`. When it is empty or not valid, an
older `processing.night_window.tz` is used, and then UTC. The night window follows `locale.timezone` unless it has a
zone of its own.

**How to check.** Reconnect the agent to check MCP text changes, and read `locale.language` and `locale.timezone` in
the settings to check the language and the zone.

## Uploads

One uploaded file is at most `limits.upload_max_bytes`: 20 MiB (20971520 bytes) by default and at most, 1 MiB at
least. The same limit holds for a file that an agent uploads over MCP with `memory_upload`.

## Agent tools

`contracts/mcp-tools.json` describes 18 tools. What `tools/list` shows an agent depends on `access.mcp_tools_profile`:

| Value | `tools/list` shows |
| --- | --- |
| `"core"` (default) | `memory_search`, `memory_read`, `memory_list`, `memory_me`, `memory_remember`, and two dispatchers: `memory_manage` runs `upload`, `meeting_upload`, `process_now`, `space_create`, `space_add_member`, `close`, `correct` and `plan` by `action` (`help` describes them); `memory_manage_destructive` runs `space_remove_member`, `promote`, `open`, `delete` and `apply` |
| `"full"` | every tool the key may use, each by its own name, and no dispatcher |

With a personal key of a new installation, `tools/list` therefore shows seven entries. Listing is not permission:
a tool the key may use is also accepted by its own name when it is not listed, and in both profiles a dispatcher
offers only the actions of such tools. `memory_open` is offered only to a cloud agent with a personal key that reads
no closed records, not to a script key and not through the external agent address; a service key gets no tool of the
group `owner` and no `memory_meeting_upload`; the system key has no MCP tools. The setting is read per request; an agent sees a change after it reconnects.

## Profiles and protected settings

**What it provides.** `security.mode` selects `basic` or `advanced` security behavior.
In advanced mode, effective settings can enforce stricter values and sensitive changes can require another approval.
Signed anchors can fix a non-secret value or require a secret to match its signed fingerprint.
An ordinary setting change cannot replace an anchored value.

Model configuration has a separate lifecycle from the security mode; use the [models guide](./models.md) for
connections.
To change the embedding model on a filled database, put the next model into the second embedding connection; see
[Changing the embedding model on a filled database](./models.md#changing-the-embedding-model-on-a-filled-database).

**How to check.** Inspect the effective value, pinned state, and response to the proposed change.
Follow the approval or anchor procedure indicated by the response instead of editing the database directly.

## Change a value without the panel

For a standard Compose installation, use an API client that supports Unix sockets. Send
`PUT /api/v1/admin/settings` through `${MEMORY_HOME}/run/admin/api.sock` with an authorized system key as a bearer
token. To set `locale.mcp_language` to English, send this JSON body:

```json
{"items":[{"category":"locale","key":"mcp_language","value":"en"}]}
```

If the admin API is mounted on the gateway's TCP listener, the repository helper can send the same request:

```bash
python3 tools/admin/set_setting.py locale mcp_language '"en"'
```

The helper sends `PUT /api/v1/admin/settings` with a JSON `items` array.
It reads the gateway address from `MEMORY_BASE_URL` and the key from `MEMORY_KEY_SYSTEM` or `MEMORY_KEY_FILE`.
These are inputs to the operator script, outside the application environment allow-list.
Use an existing protected key file; do not paste a key into a command or copy its contents into a report.

The helper prints the HTTP status and exits successfully for any 2xx response.
Check whether the API applied the value or created an approval request: HTTP 202 can mean that nothing was saved yet.
A protected setting can refuse a system key, and the helper grants no additional permissions.

For a batch, the API accepts objects with `category`, `key`, and `value` inside `items`.
Every item must contain `value`; duplicate keys are rejected, and the settings writer validates the batch before
writing.
Use the panel or an authenticated API client to inspect the resulting value after the request.

## Tools on the server

| Tool | What it does |
| --- | --- |
| `deploy/bin/memory-admin` | The administrator's command line on the server: `health`, `provision apply`, `recover set`; it reaches the gateway through its command-line socket |
| `tools/keys/gen-service-key.mjs` | Makes a service key `mem_s_…` on the host of the service that will use it. It prints the secret and its fingerprint; the administrator enters only the fingerprint in the panel (**Services**, **Key**), so the memory never holds the secret. It needs Node.js only |
| `tools/admin/breakglass-halves.mjs` | Makes the two halves of the emergency access key, shows each once to its holder, and writes the hash file `--out <file>`, which the gateway reads as `breakglass-halves` from its credentials directory (`secrets/gateway` of the home directory on the Compose install). It needs Node.js on the machine that runs it. The tool writes the file with mode 0600, but the gateway runs as `MEMORY_UID:MEMORY_GID` of `deploy/compose/.env`, so give the file that owner (`chown`) before you put it in place, also when root made it. Without the file, emergency access answers `breakglass_not_configured` |

## If something goes wrong

Start with [troubleshooting](./troubleshooting.md) and the named failing health check.
See also: [backup and restore](./backup.md) and the [security policy](../SECURITY.md).

---

[README](../README.md) · [Quick start](./quickstart.md) · [Installation](./installation.md) ·
[Backup and restore](./backup.md) · [Configuration](./configuration.md) · [Models](./models.md) ·
[Troubleshooting](./troubleshooting.md) · [Glossary](./glossary.md)
