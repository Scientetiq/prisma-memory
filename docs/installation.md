# Installation

This guide is for the administrator who installs **Prisma Memory** on one Linux server with Docker Compose.
It covers the requirements, the preparation of the server, the installer, the first sign-in and the models.
See also: [quick start](./quickstart.md), [models](./models.md), [configuration](./configuration.md) and
[troubleshooting](./troubleshooting.md).

## In brief

1. Take a supported Linux server and, as an account with `sudo`, put a copy of the repository on it, a `git clone`
   or an unpacked archive.
2. Prepare the server once from that copy, as [Prepare the server](#prepare-the-server) shows: it installs Docker,
   creates the account that will own the installation, in the group `docker`, and closes the server.
3. Log in as that account, put a copy of the repository in its home, for example `~/prisma-memory`, and install
   from there: `deploy/compose/setup` builds the images on the server and starts the stack.
4. Open the panel through an SSH tunnel and create the first administrator with the install code.
5. Connect a chat model and an embedding model. Until then, search works by keyword.

## Requirements

| What | Requirement |
| --- | --- |
| System | Ubuntu 22.04, 24.04 or 26.04; Debian 12 or 13; amd64 or arm64 |
| Docker | Rootful Docker Engine 24 or newer, not rootless, on its default local socket, with the Compose plugin 2.40.3 or newer |
| Memory | 7 GiB (7168 MiB) of RAM and swap together, or more |
| Disk | 20 GiB free, or more |
| Tools | `openssl`, `mktemp`, `flock`, `ss`, `cmp` and `free`; `sha256sum` too for an install from an offline kit |
| Account | The account that runs `setup` must be in the group `docker` and have logged in again since it was added, or be root; on a server of your own, [Prepare the server](#prepare-the-server) makes such an account |
| Network | An online install downloads the base images of Node.js and of PostgreSQL with pgvector and the storage server's image from Docker Hub, and pnpm (through Corepack) and the npm packages of `pnpm-lock.yaml` from the npm registry; nothing else is contacted; an install from an offline kit (`--offline KIT`) downloads nothing. Preparing the server downloads system packages from the server's package sources and, where it is missing, Docker from Docker's own repository |

The installer checks Docker, memory, disk and tools before it starts anything. It also checks paths, ownership,
configuration, conflicts with existing deployments, ports and credential files.
`deploy/compose/setup --check` runs the same preflight without taking the lock or writing files. Check the system and
network requirements separately.

## Prepare the server

Run the preparation script once, as root, before the installer. It installs Docker from Docker's own repository,
creates the account that runs the installation when `--user` names it, closes the firewall, switches SSH to
key-only login and sets a few safe system limits. Running it again is safe. The installation needs no open port
besides SSH: both of its ports listen on `127.0.0.1`.

```bash
# a server of your own: every block
sudo bash deploy/host/prepare-host.sh --user memory --pubkey-file ~/memory.pub

# a server run by your IT team: Docker only, nothing else is touched
sudo bash deploy/host/prepare-host.sh --managed

# look without changing anything
bash deploy/host/prepare-host.sh --check
```

`~/memory.pub` is your public SSH key: copy it to the server before you run the script. With `--managed` the script
creates no account: the IT team gives you an account in the group `docker`, and you log in with it.

Important: closing password login and the firewall could lock you out, so the script asks for proof.

- **It prints** `ACTION: open a second connection now` with the exact `ssh` command.
- **You open** a second terminal and log in with your key.
- **It keeps** the two changes only after it has seen that login. Otherwise it does not keep them: it rolls both back,
  or never applies them when no account has an authorized key, and exits with 75.

When one of the last lines of its report reads `reboot-required` and `yes`, reboot the server before the installer
and log in again by key.

The blocks, the firewall rules, the Docker guard and the exit codes are described in `deploy/host/README.md`.

## Install

Run the installer as the account that will own the installation. It asks no questions.

```bash
deploy/compose/setup
```

It works in this order. Each step can be run again: it keeps the data, the secrets and `.env` that exist, and it
builds the images and starts the services again:

1. It checks the server and stops with exit code 3 if a check fails. Its lock directory
   `deploy/compose/.setup.lock` stays in the folder of `deploy/compose`.
2. It writes `deploy/compose/.env`, which never holds a secret.
3. It creates the directories and the secret files under the home directory: `~/prisma-memory-home` by default,
   `/var/lib/prisma-memory` when it runs as root. The home directory must lie outside the copy of the repository.
4. It builds the images on this server and starts the database, the storage, the gateway, the workers and the
   web interface.
5. It stores the storage settings and checks that each data class has its own storage key.
6. It prints a summary: the addresses, the home directory and the file that holds the install code.

| Option | Purpose |
| --- | --- |
| `--check` | Only the checks of step 1; writes nothing; exit 0 when all pass, 3 when one fails |
| `--home DIR` | Where data, secrets and sockets live. Use an absolute path outside the copy of the repository with an existing parent. Use only letters `A–Z` and `a–z`, digits, `.`, `_`, `-` and `/`. Path parts cannot be `.` or `..`. This option wins over the default |
| `--instance NAME` | The name of this installation on the server, `core` by default; a second installation needs its own name, its own home and two free ports |
| `--profile internal-http --publish ADDR` | A closed company network reached over plain HTTP, on the given IPv4 address |
| `--demo` | Also starts a model simulator for a first look; its answers do not come from a model |
| `--offline KIT` | Installs from an offline kit made with `tools/release/offline-kit.sh` from the same commit; it loads the kit's images and neither builds nor pulls |

Exit codes: 0 done; 1 failed in the middle, run it again and it continues; 2 wrong call; 3 refused, with the
reason on the line that starts with `setup: refused:`.

With `--profile internal-http` on a server prepared with every block, the Docker guard lets the closed network in
only after you run the command that the `Firewall:` line of the summary prints.

If the address of `--publish` belongs to an interface that comes up after Docker, a VPN for example, the
containers that publish on it fail at boot with `cannot assign requested address` and are not started again. Once
the interface is up, remove them with the `down` command of [Stop and start](#stop-and-start) and run `setup`
again; `docker start` alone leaves a container without a network.

The installer names the version after the copy of the repository: `git describe --tags --always` in a git clone,
with `-dirty` when a tracked file was changed; the first line of a file `VERSION` in an unpacked archive;
otherwise `0.0.0-local`. The version tags the images it builds, and an installation runs only with the copy it
was installed from.

Important: keep a copy of the directory `secrets` of the home directory. Without it the encrypted settings
cannot be read.

The services, the networks and the rules every container follows are described in `deploy/compose/README.md`.

## Stop and start

From the root of the copy of the repository, this command stops the installation. Its data, its secrets and its
images stay. For an installation made with `--demo`, add `--profile demo` before `stop` or `down`.

```bash
docker compose --project-directory deploy/compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env stop
```

To start it again, run `deploy/compose/setup` again with the options of the installation. The same command with
`down` in place of `stop` also removes the containers and the networks of the installation; the data stays in the
home directory, and `setup` creates them again. A demo installation and
a second installation on the same server are described in `deploy/compose/README.md`, in the sections
[Stop and start](../deploy/compose/README.md#stop-and-start) and
[A second install on one server](../deploy/compose/README.md#a-second-install-on-one-server).

## First sign-in

Both ports listen on `127.0.0.1`. From your own computer, open a tunnel for the agents' port and the panel's port,
then the panel:

```bash
ssh -N -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 <you>@<server>
```

8080 and 8081 are the default ports; the `Tunnel:` line in the summary printed by `setup` shows the ports of your
installation.

Open `http://127.0.0.1:8081/admin/first-run`; the address `http://127.0.0.1:8081` alone opens the sign-in page of
the workplace. The panel asks for the install code once and creates the first administrator. The summary of `setup`
names the file with the code; read it on the server with `cat`.

People sign in through a company directory (LDAP or OpenID Connect). Its settings are protected settings, and on a new installation you set them from the server; see [Protected settings](#protected-settings) and [Sign-in through OpenID Connect](#sign-in-through-openid-connect).
Without a directory, the administrator adds each person on the panel page `/admin/people/local`, with an e-mail and a
name, and gives them the one-time link that the page shows: it works once, for 72 hours, and opens the page
`/set-password`, where the person sets a password of at least 12 characters. The person then signs in to the
workplace with the e-mail and that password. These accounts work in the security mode `basic`, the default.
Agents connect to `http://127.0.0.1:8080/mcp` with a personal key. On a default installation the gateway's port 8080
answers only what agents use, also for a request from the server itself: MCP and the sign-in of agents (`/mcp`,
`/oauth/…`, `/.well-known/…`), the agent skill, signed links to original files, uploads with an upload ticket and a
health check that shows only the status. The second published port, 8081, serves the panel and the workplace. The
administrator works in the panel or on the server: `deploy/bin/memory-admin` reaches the gateway through its
command-line socket, and the admin API answers on the socket `run/admin/api.sock` of the home directory. The
[quick start](./quickstart.md) makes a first person and a key through that socket.

Until the first administrator exists, `deploy/bin/memory-admin health` reports `fail_closed`. This is expected on a
new installation and ends when the panel has created the first administrator.

Some settings of the directory are protected settings: on a new installation set them from the server, as
[Protected settings](#protected-settings) describes.

## Models

**What it provides.** A chat model writes the summaries and extracts the events of each record. An embedding
model adds search by meaning. An installation without models stores records and searches them by keyword.

**Which data goes where:**

- The chat model receives the text of records. The embedding model receives passages and search queries.
- A model call goes out only to an endpoint and a model that the data policy lists: `models.allow_open` for open
  records, `models.allow_closed` for open and closed records. Any other call is refused and the record waits.
- A fresh installation lists nothing, so connect the models and list them before you load the first documents.

**Settings** (the model settings of the panel, or one provisioning file):

| Key | Default | Purpose |
| --- | --- | --- |
| `models.chat_provider`, `models.chat_base_url`, `models.chat_model`, `models.chat_api_key` | empty | The chat model connection |
| `models.embeddings_provider`, `models.embeddings_base_url`, `models.embeddings_model`, `models.embeddings_api_key` | empty | The embedding model connection |
| `models.embeddings_params` | `{}` | Overrides of the embedding profile, for example the dimension |
| `models.allow_open`, `models.allow_closed` | `[]` | The endpoints and models that may receive records |

To set them from the server, copy `deploy/compose/provision/models.example.json`, put in your addresses and
model names, and apply the copy. An item can be written when its stored value is NULL or the seed default. If the
proposed value is already in force, provisioning reports `same_value`.

```bash
deploy/bin/memory-admin provision apply - < models.json
```

Enter the API keys in the panel, where they are stored encrypted: the fields of `models.chat_api_key` and
`models.embeddings_api_key` on the page `/admin/settings?cat=models`. The legacy gateway key `models.gateway_api_key`
is used for a role only when that role has no key of its own and its address has the same origin as the legacy
gateway address `models.gateway_base_url`. The recommended embedding model and the measurements behind it are in
[models](./models.md#recommended-models).

**How to check.** In the authenticated admin `GET /api/v1/health` response, look at `checks.embedder.detail`: with
no active embedder it gives a `keyword-only` reason, and a search in the default mode `hybrid` carries the note
`No embedding model is configured: results are keyword-only`. `deploy/bin/memory-admin health` shows the status,
the version and the storage check of the installation, not the state of the models.

**A model endpoint on the same server.** The containers cannot reach an endpoint that listens only on `127.0.0.1`
of the server. Let the endpoint listen on another address of the server (in the example `192.0.2.10`, port `4000`),
write that address into the base URL (`http://192.0.2.10:4000/v1`), and let the installation's `egress` network in
through the host firewall; with ufw (`prepare-host.sh` sets incoming to deny), as root:

```bash
N=prisma-memory-core_egress   # prisma-memory-<instance>_egress
ID=$(docker network inspect -f '{{.Id}}' "$N" | cut -c1-12)
SUB=$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$N")
ufw allow in on "br-$ID" from "$SUB" to 192.0.2.10 port 4000 proto tcp
```

The network exists after the first `setup`. When it is created anew (for example after `docker compose down`), its
id changes: add the rule again.

## Protected settings

Some settings decide who may sign in and from where. Among them are the addresses of the directory and of the OpenID
Connect provider, the sign-in of administrators, the sign-in of agents (`agent_auth.mode` and its apps), the mail
transport of alerts, and additions to `access.internal_networks` and `access.trusted_proxies`. In the security mode
`basic`, the default, the panel accepts a change to them only in the session of a person who signed in through the
directory. Anyone else, the first administrator too, gets the refusal `human_session_required`, and the refusal names
the settings it concerns.

On a new installation, set them from the server. Write them into a provisioning file in the format of
`deploy/compose/provision/models.example.json`, look at the dry run, then apply it. Each setting that nobody has
changed yet is written through the same checks as in the panel; a setting whose save needs checks of the panel only
is refused with `panel_only` and is changed in the panel. Apply the agents' address and the workplace address
(`access.cloud_agent_base_url` or `access.public_base_url`, and `access.workplace_url`) and the directory in a first
file, and the sign-in of agents (`agent_auth.mode` and its apps) in a second file once the first is applied.

```bash
deploy/bin/memory-admin provision apply - --dry-run < settings.json
deploy/bin/memory-admin provision apply - < settings.json
```

To change one of them later, run `deploy/bin/memory-admin recover set '<key>=<value as JSON>'`. It accepts only
protected settings: any other key is refused with `recovery_key_not_allowed` and is changed in the panel. Every change
is written to the audit log. This works only in the security mode `basic`.

## Sign-in through OpenID Connect

The OpenID Connect settings are the keys of category `oidc`. All of them except `oidc.timeout_sec` are protected settings, so on a new installation you set them from the server with a provisioning file. The template is [oidc.example.json](../deploy/compose/provision/oidc.example.json). A file that holds the complete section (issuer, client, secret, groups, enabled) applies in one call. The client secret is stored encrypted; do not keep the file on the server after applying it.

Set up the client at the provider like this:

- Create a confidential client: client authentication on, authorization code flow.
- Set its valid redirect URI to exactly the value of `oidc.redirect_uri`: `<workplace address>/auth/oidc/callback`. The path is fixed, with no `?` or `#`. Use https; plain http is accepted, and the check marks it with a warning. The workplace address is where people open the workplace (port 8081, or the address of a proxy in front of it).
- Make the provider send these claims in the ID token or from the userinfo endpoint: the person's stable id (`LDAP_ID` by default, a GUID in the form 8-4-4-4-12 hex digits), `email`, `email_verified`, `name`, `preferred_username` and `groups`. `department`, `employee_id` and `given_name` are optional. Without the stable id, sign-in is refused with `oidc_claim_missing`.
- Make sure the gateway can reach the issuer over the network.

| Key | Default | Meaning |
| --- | --- | --- |
| `oidc.enabled` | `false` | Turns the sign-in on. When true, `oidc.issuer`, `oidc.client_id`, `oidc.client_secret`, `oidc.redirect_uri` and `oidc.login_groups` are required, otherwise the file is refused. |
| `oidc.issuer` | `""` | Issuer URL exactly as the provider publishes it, for example `https://idp.example.com/realms/example`. |
| `oidc.client_id` | `""` | Client ID. |
| `oidc.client_secret` | none | Client secret. Secret setting. |
| `oidc.redirect_uri` | `""` | `https://memory.example.com/auth/oidc/callback`, as described above. |
| `oidc.login_groups` | `[]` | Required. Only a person who sends one of these groups may sign in; others are refused with `oidc_not_in_group`. At most 20. Write full group paths such as `/memory-users`: a name without the leading slash also matches `/name` and a nested group with the same name. |
| `oidc.ca_cert` | `""` | PEM text of the root certificate of a private CA that signed the provider's TLS certificate. At most 10 certificates, 64000 characters. |
| `oidc.private_networks` | `[]` | Required when the issuer's host name resolves to a private address; otherwise the gateway refuses it with `oidc_address_blocked`. IP addresses or CIDR blocks inside 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 or fc00::/7, at most 20, for example `10.0.0.5/32`. |
| `oidc.scopes` | `"openid profile email"` | Must include `openid`. |
| `oidc.claims` | object: `guid` `LDAP_ID`, `mail` `email`, `mail_verified` `email_verified`, `name` `name`, `department` `department`, `employee_id` `employee_id`, `groups` `groups`, `username` `preferred_username`, `given_name` `given_name` | The claim names the provider uses. A name left out of the stored object keeps its default. `claims.guid` names the claim with the stable id. |
| `oidc.timeout_sec` | `10` | How long one call to the provider may take, in seconds. Not protected. |

Check the file first with a dry run, then apply it:

```bash
deploy/bin/memory-admin provision apply - --dry-run < oidc.json
deploy/bin/memory-admin provision apply - < oidc.json
```

Then open the panel page `/admin/sso` (Single sign-on) to check the connection to the provider.

## Publishing over HTTPS

The installer has no TLS option yet: `setup` does not accept `--domain`. Keep both ports on `127.0.0.1` and reach
them through an SSH tunnel, or use `--profile internal-http` inside a closed network. Do not publish plain HTTP on
the internet.

If you put a TLS proxy of your own in front of the panel and workplace port (8081), make it pass the original `Host`
and the header `X-Forwarded-Proto: https`. The session cookies are marked `Secure` from that header; without it they
are set as for plain HTTP.

A TLS front on a server of its own is described in [deploy/front/README.md](../deploy/front/README.md). That page is
a procedure verified in halves, not shown end to end between two servers; read its warnings before you use it.

With `--profile internal-http`, callers from the loopback and from the private networks (RFC 1918 and the IPv6 unique
local range) count as internal. A company network on other addresses, such as the shared range of RFC 6598, counts
as external until the setting `access.internal_networks` lists it; adding a network is a protected change, see
[Protected settings](#protected-settings).

**The REST API.** In the default profile `internet` every caller of the agents' port counts as external, a caller
through the SSH tunnel too: Docker's port forwarding hands the gateway the address of its network bridge, not the
loopback. The external channel serves only `/mcp`, the OAuth and skill routes, `/api/v1/originals/`,
`/api/v1/uploads/` and `/api/v1/health`; every other REST route answers `404`, `POST /api/v1/ingest/documents` and
`POST /api/v1/ingest/transcripts` among them. Agents upload over MCP (`memory_upload`, `memory_meeting_upload`). A
service that posts to the REST API needs an installation with `--profile internal-http` inside a closed network,
where its private address counts as internal.

## Upgrade and backup

An installation runs the version of the repository it was installed from. To move it to a newer release, get the new
tree in the **same folder** and run `setup upgrade` there, as the user who installed it:

```bash
git fetch --tags && git checkout <tag>
deploy/compose/setup upgrade
```

Pass the options of the installation again, for example `--home` and `--instance` for a second installation on the
server, and `--offline KIT` with a kit made from the new tree. `setup upgrade` asks one question that names both
versions; `--yes` answers it, and without a terminal `--yes` is required. In this order, it:

1. runs the checks of `setup` and refuses (exit 3, nothing changed) when there is no installation here, when the tree
   has no version (an unpacked archive without a `VERSION` file), when the tree is the installed version (`nothing to
   upgrade`, exit 0), when an earlier upgrade is unfinished, when the home's file system has less free space than
   the size of `data/pg` plus 1 GiB, or when `data/pg` is on another file system than the home (a rollback moves the
   database by renaming it);
2. builds the images of the new version, or loads them from the kit, while the installation still runs. The images of
   the installed version stay on the server;
3. stops every service;
4. copies `data/pg` and `.env` into `<home>/upgrade/<UTC time>-from-<installed version>/`, with a file `state` that
   names both versions. `data/s3` and `secrets` are not copied: the upgrade does not change them;
5. writes the new version into `.env`, starts the installation as `setup` does (the schema job `migrate` brings the
   database to the new version), stores the storage settings and checks the storage isolation;
6. prints `Upgraded: <old> -> <new>` and the saved folder.

The installation is down from step 3 until the new version reports healthy: the time to copy the database and to start.
The build runs before, while the installation still serves.

If anything fails after the copy, `setup upgrade` rolls back on its own and exits 1: it stops every service, moves the
upgraded database into the saved folder as `pg.failed`, puts the copy back as `data/pg`, puts the saved `.env` back and
starts the installed version with its own images, without a build. The tree stays at the new version: fix the cause
and run `setup upgrade` again, or check out the installed commit before you run `setup`. An interrupted upgrade
(Ctrl-C) rolls back the same way. Run the upgrade in a session that survives a dropped connection, for example `tmux`
or `screen`: a run that is cut off hard cannot roll back on its own, and the next `setup upgrade` then names the
unfinished upgrade.

To go back after a finished upgrade, or after an upgrade that was stopped hard, run:

```bash
deploy/compose/setup upgrade --rollback
```

It uses the folder of the unfinished upgrade, else the newest finished one, and asks first: everything written since
the upgrade is lost, the database returns to the copy. A rollback needs no free disk space and builds nothing.

`setup upgrade` never deletes anything. The saved folder holds a full copy of the database, and with it every secret
stored in the database: keep it private, and remove it yourself once the new version has proved itself.

`setup upgrade` is not a backup: it keeps one copy of the database on the same disk. Backups stay a manual procedure;
how to make a copy of an installation and how to bring it back is described in [backup and restore](./backup.md).

## Security notes

- Both ports speak plain HTTP and listen on loopback by default. On a closed network,
  `--profile internal-http --publish ADDR` binds both ports to the chosen IPv4 address.
  Do not publish them on the internet.
- Whoever may run Docker on the server may run `deploy/bin/memory-admin`: it needs no key and no session.
- The directory `secrets` of the home directory holds the generated passwords of the installation and the keys that
  decrypt its encrypted settings. Keep it and its copies private.
- In the security mode `basic`, an administrator alone can reset the password of an account made in the panel. The
  reset ends the person's sessions and agent connections and shows a one-time link that works for one hour: whoever
  opens the link sets the new password.

## If something goes wrong

| Symptom | What to check |
| --- | --- |
| `setup` ends with exit code 3 | It refused to go on: the line that starts with `setup: refused:` names the reason. Fix it and run `setup` again |
| `setup` refuses a home inside the clone | Choose a directory outside the copy of the repository and run it again with `--home DIR` |
| `setup` ends with exit code 1 | It failed in the middle; run it again, it continues and creates no secret twice. What it made stays and is used again: `deploy/compose/.env`, the home directory with `secrets` and the storage accounts |
| A port is already in use | Free port 8080 or 8081, or write `GATEWAY_PORT=<port>` or `WEB_PORT=<port>` into `deploy/compose/.env` with mode 0600; the file may be created before the first run, and the installer adds the other keys |
| `storage isolation not confirmed` | The gateway did not report its storage check; run `deploy/bin/memory-admin health` |
| `prepare-host.sh` ends with exit code 75 | Key login proof is missing. The script skips the SSH and firewall changes if no eligible account has an authorized key. If the check expires or the run is interrupted while waiting, it attempts to roll those changes back. Read the access failure before running it again |
| Search finds nothing by meaning | No embedding model is connected or listed; see [Models](#models) |
| `setup` refuses the compose project of another copy | Give this installation its own name with `--instance NAME` and its own home with `--home DIR` |
| `setup` refuses a home that another copy owns, or a folder that is not empty | Choose a new or an empty directory with `--home DIR` |
| `health` reports `fail_closed` on a new installation | The first administrator does not exist yet; create it in the panel with the install code |
| The panel refuses with `human_session_required` | The setting is protected; set it from the server, see [Protected settings](#protected-settings) |
| `setup` ends with exit code 1 after `all predefined address pools have been fully subnetted` | Docker has no free address range left for the five networks of the installation. Each installation on the server needs five: remove the networks of installations you no longer use with their `down` command, see [Stop and start](#stop-and-start) |
| `setup: refused: git describe failed in …` | The copy has a `.git` folder without a commit. Install from a `git clone` of the repository, or from a copy without the `.git` folder |

See also: [models](./models.md), [configuration](./configuration.md), [troubleshooting](./troubleshooting.md).

---

[README](../README.md) · [Quick start](./quickstart.md) · [Installation](./installation.md) ·
[Backup and restore](./backup.md) · [Configuration](./configuration.md) · [Models](./models.md) ·
[Troubleshooting](./troubleshooting.md) · [Glossary](./glossary.md)
