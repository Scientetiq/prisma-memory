# Quick start

This guide takes one Linux server from a clean system to the first answer of an agent: install, first
administrator, models, a first person with a key, and one search over MCP. The first build of the images takes
most of the time. Every option and the preparation of the server are described in [installation](./installation.md).
See also: [installation](./installation.md), [models](./models.md), and [backup and restore](./backup.md).

## What you need

| | |
| --- | --- |
| Server | A Linux server with the resources of [Installation](./installation.md#requirements) |
| Docker | Rootful Docker Engine 24 or newer, not rootless, with Compose 2.40.3 or newer; check with `docker compose version` |
| Tools | `git` and `curl`; `setup` checks the rest and names what is missing |
| Account | The account that will own the installation must be in the group `docker`, and must log in again after it is added; on a server of your own, [Prepare the server](./installation.md#prepare-the-server) makes such an account |
| Models | An OpenAI-compatible endpoint with a chat model and an embedding model, and its API key |

People sign in to the workplace through your directory, LDAP or OpenID Connect, or with an e-mail and a password:
without a directory, the administrator adds each person on the panel page `/admin/people/local` and gives them the
one-time link that the page shows; it works once, for 72 hours, and there the person sets a password of at least 12
characters. For a first check from the server alone, step 5 makes a test person and a personal key.

## 1. Download and prepare

As the account that will own the installation:

```bash
git clone https://github.com/Scientetiq/prisma-memory.git && cd prisma-memory
bash deploy/host/prepare-host.sh --check
```

The check changes nothing. It lists what the server still needs; how to prepare it is described in
[Prepare the server](./installation.md#prepare-the-server).

It ends with exit code 0 when everything is in place and 1 when something is still to do. Run as an account
other than root, it marks the items that need root `UNKNOWN` and ends with 1; run it with `sudo` to see them too.
On a system that is not supported, it ends with exit code 69 and says `unsupported system`.

When it names something to do, prepare the server first, log in again as the account that will own the
installation, and run the check again before step 2.

## 2. Start

```bash
deploy/compose/setup
```

`setup` asks no questions. It builds the images on the server, starts the stack and ends with exit code 0 and a
summary with the effective agent and panel URLs, the home directory, and the install code file. Both ports listen on
loopback by default. For a loopback install, the summary also prints the SSH tunnel command.

## 3. Create the first administrator

For a loopback install, run the SSH tunnel command printed in the summary from your own computer. Then open the panel
URL it gives with `/admin/first-run` added (`http://127.0.0.1:8081/admin/first-run` with the default ports).

Read the install code on the server with the `cat` command of the summary. The panel asks for the code, a login
and a password of at least 12 characters, and creates the first administrator.

After the administrator is created, the page shows the system key of the installation once. Keep it in a password
manager: step 5 uses it, and the page does not show it again. The system key does not expire. If it is exposed,
replace it on the server: after `umask 077`, `deploy/bin/memory-admin system-key rotate > ~/system-key.json` revokes
every system key of the installation and writes the new one to the field `system_key` of that file. This works in the
security mode `basic`, the default.

## 4. Connect the models

Copy the example file, put in the address of your endpoint and your model names, and apply it on the server.
`--dry-run` shows what would be written:

```bash
cp deploy/compose/provision/models.example.json ~/models.json
deploy/bin/memory-admin provision apply --dry-run - < ~/models.json
deploy/bin/memory-admin provision apply - < ~/models.json
```

The file lists both models in `models.allow_open`, so open records may be sent to them and closed records never
are. Then enter the API key in the panel, on the page `/admin/settings?cat=models`, in the fields
**Chat model: API key** and **Embedding model, connection 1: key**, and save. The legacy gateway key
`models.gateway_api_key` does not reach the connections that the file made.

**How to check.** The search by meaning of step 6 finds the note only when the embedding model answers; until then
search works by keyword only. `deploy/bin/memory-admin health` reports the state of the installation, not of the
models. The details are in [Models](./models.md).

## 5. Add a first person and a personal key

Without a directory, the administrator can issue a personal key only to a person marked as a test person, for a
first check. A real person issues their own key in the workplace after signing in, through the directory or with
the e-mail and password of an account made in the panel.

Run these commands on the server as the account that owns the installation. They use the system key of step 3 and
the admin socket in the home directory; `<home>` is the `Home:` line of the summary of `setup`:

```bash
umask 077
read -rs SYSTEM_KEY
printf 'Authorization: Bearer %s\n' "$SYSTEM_KEY" > ~/admin-header
unset SYSTEM_KEY
SOCK=<home>/run/admin/api.sock
curl -sS --unix-socket "$SOCK" -H @"$HOME/admin-header" -H 'Content-Type: application/json' \
  -X PUT http://admin/api/v1/admin/people \
  --data '{"people":[{"login":"<login>","display_name":"Test Person","active":true,"attrs":{"test":true}}]}'
```

`read -rs` shows no prompt: paste the system key and press Enter. The key goes from the shell into the file
`~/admin-header`, which only you can read, and curl reads it from there with `-H @file`. This keeps the key out of the
shell history and out of the process list, where other accounts on the server could read it. `<login>` has the form
of a mail address under the reserved domain `.test`. The answer must count one person as created; the HTTP code is 200 even when a row is
refused, and the refused row says why. Then issue the key:

```bash
curl -sS -o ~/first-key.json -w '%{http_code}\n' --unix-socket "$SOCK" -H @"$HOME/admin-header" \
  -H 'Content-Type: application/json' -X POST http://admin/api/v1/admin/keys \
  --data '{"kind":"personal","principal":"<login>","client_label":"first agent","basis":"quick start","expires_at":"<date>T00:00:00Z"}'
```

`<date>` is at most 90 days ahead. The command prints `201` when the key is issued; `000` means that curl reached
no socket, so check `SOCK`; any other code means a refusal, whose reason is in the file. The file
`~/first-key.json` holds the key in the field `secret`; it starts with `mem_p_`, and `umask 077` makes a new file
readable by you only. Delete `~/admin-header` now, and delete `~/first-key.json` once the agent is connected.

## 6. Connect an agent

For Claude Code, replace `<agent-url>` with the `Agents:` URL from the setup summary. If you use a tunnel,
forward to the reported agent port and use the tunnel's local address and port in the URL.

```bash
read -rs MEMORY_KEY
claude mcp add --transport http --scope user prisma-memory "<agent-url>" --header "Authorization: Bearer $MEMORY_KEY"
unset MEMORY_KEY
```

`read -rs` shows no prompt: paste the personal key and press Enter. The key stays out of your shell history, and
Claude Code keeps it in its user configuration.

Ask the agent to remember a short note, then to find it by meaning, in other words. The search finds the note.

A meeting that an agent uploads is closed until a person opens it in the workplace; until then no agent finds it,
not even the agent that uploaded it. Notes that an agent remembers are open and are found at once.

## Stop and remove

To stop the installation, from the root of the repository:

```bash
docker compose --project-directory deploy/compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env stop
```

To start it again, run `deploy/compose/setup`. To remove it completely, run the same `docker compose` command with
`down` instead of `stop`, then delete the home directory and `deploy/compose/.env` as the account that owns the
installation. Do not delete the images while another installation on the server uses them. To keep the data, make a
copy first, as described in [backup and restore](./backup.md).

## If something goes wrong

| Symptom | What to check |
| --- | --- |
| `setup` ends with exit code 3 | The line that starts with `setup: refused:` names the reason. Fix it and run `setup` again |
| The panel does not open | The SSH tunnel must run while you use the panel: by default, both ports listen on `127.0.0.1` only |
| Search finds nothing by meaning | The embedding model has no key or is not listed in `models.allow_open`; see step 4 |
| A model on the same server does not answer | The containers reach the server through the network bridge of the installation: the endpoint must listen on an address that bridge reaches, and the host firewall must let the bridge's subnet in; the commands are in [installation](./installation.md) |
| PDF files are not processed | PDF needs an external converter (`integrations.converter_url`); Markdown and text work out of the box |

---

[README](../README.md) · [Quick start](./quickstart.md) · [Installation](./installation.md) ·
[Backup and restore](./backup.md) · [Configuration](./configuration.md) · [Models](./models.md) ·
[Troubleshooting](./troubleshooting.md) · [Glossary](./glossary.md)
