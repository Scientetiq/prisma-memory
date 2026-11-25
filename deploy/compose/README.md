# deploy/compose — the public install

One compose file, `compose.yaml`, run by `deploy/compose/setup`, the command that installs. `setup` writes `.env`
next to the file, creates the directories and secret files under `MEMORY_HOME`, builds the images on this machine, or
loads them from an offline kit with `--offline KIT`, and starts the stack. Every variable is described in
`.env.example`.

Docker Compose **2.40.3** is the minimum known to work, tested with the distribution's client. `setup` requires
2.40.3 or newer. This version honors `create_host_path: false` at runtime but omits it from `config --format json`;
read that key in `compose.yaml` itself.

Once `setup` has run, this command starts the stack by hand. On a new server run `setup` first: it makes `.env`, the
home directory and the secrets that the command needs.

```bash
docker compose --project-directory deploy/compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env up -d
```

Without `.env` Compose stops at once, because the file that `--env-file` names is missing; with an incomplete `.env` it
stops on the first missing variable (`MEMORY_INSTANCE_ID`, `MEMORY_HOME`, `MEMORY_UID`, `MEMORY_GID`,
`MEMORY_VERSION` have no default). It does not create root-owned directories. It does not check what the secret files
hold: `setup` does, before it starts the stack.
Do not add a `compose.override.yaml` or a second `-f`: `setup` refuses an override file, because one could silently
widen what is published.

## Services

| Service | Image | Networks | Published | Mounts under `MEMORY_HOME` |
| --- | --- | --- | --- | --- |
| `db` | `prisma-memory-db` (pgvector + `memory-schema` + own `pg_hba.conf`) | `db` | — | `data/pg`, `run/pg`, `secrets/db` (ro) |
| `migrate` (job) | `prisma-memory-db` | none (`network_mode: none`) | — | `run/pg`, `secrets/migrate` (ro) |
| `s3` | versitygw, pinned by digest | `s3` | — | `data/s3`, `data/s3-iam`, `secrets/s3` (ro) |
| `gateway` | `prisma-memory-app` | `db`, `s3`, `models`, `egress` | `${MEMORY_PUBLISH_ADDR:-127.0.0.1}:${GATEWAY_PORT:-8080}` → 8080 | `run/admin`, `run/workplace`, `run/cli`, `secrets/gateway` (ro), `data/guard` (ro) |
| `workers` | `prisma-memory-app` | `db`, `s3`, `models`, `egress` | — | `secrets/workers` (ro), `data/audit-ship` |
| `web` | `prisma-memory-web` (panel and workplace) | `webpub` | `${MEMORY_PUBLISH_ADDR:-127.0.0.1}:${WEB_PORT:-8081}` → 3000 | `run/admin` (ro), `run/workplace` (ro) |
| `demo-models` (profile `demo`) | `prisma-memory-demo-models` | `models` | — | — |

- **Order of start:** `db` healthy → `migrate` applies the schema and exits 0 → `gateway` and `workers` → `web` once the
  gateway is healthy (`/livez`). `migrate` runs on every `up`. Run on an existing database, it finds every fresh step
  already applied, sets the role logins again and exits 0. A failure there keeps the gateway down instead of starting
  new code on an old schema.
- **The superuser** is reachable only on the database's unix socket (`run/pg`), which only `db` and `migrate` mount.
  No network line of `pg_hba.conf` names `postgres`.
- **Networks:** `db`, `s3` and `models` are internal (no way out). `egress` carries the gateway port and the way out to
  model providers and connectors. `webpub` carries only the web port, with no outbound NAT. `web` shares no network with
  the gateway: it talks to it through the workplace and admin unix sockets. The gateway therefore sees the panel's
  requests on its internal channel, even in profile `internet`, where only loopback counts as internal. Every network is
  IPv4 only.
- **Secrets:** one directory per service, read-only at `/run/credentials` (`CREDENTIALS_DIRECTORY`). `web` has none.
  `s3` reads its two root keys with a small shell entrypoint into the process environment, not into `environment:`.
  The two storage account pairs stay in `secrets/setup` on the host and are mounted nowhere. Back up
  `MEMORY_HOME/secrets`: without `settings-key-1` the encrypted settings cannot be read.
- **Free space:** the gateway measures free space on `data/guard`, an empty directory on the filesystem of
  `MEMORY_HOME`. It stops accepting files when under 10 % is free. The data itself is not mounted into the gateway,
  because every container runs as the same uid.

## Rules every service follows

Read-only root, `cap_drop: [ALL]`, `no-new-privileges`, tmpfs `/tmp`, `pids_limit`, a memory limit from `.env`,
json-file logs 20m × 5, one `user: ${MEMORY_UID}:${MEMORY_GID}` (never root). Nobody uses the host network, the
host's namespaces, `privileged`, `cap_add`, devices or the Docker socket. There is no named volume, no mount of this
clone, no `env_file`, no `secrets:` / `configs:` block, and no secret value anywhere in the file. There are two
exceptions: `db` has `shm_size`; `migrate` has `restart: "no"` and `network_mode: none`.

A new service, including a module profile such as document processing or speech, takes the same anchor and follows
the same rules.

## Compose environment variables

`.env.example` lists every variable that `compose.yaml` reads. This table explains the instance name and the limits
that `setup` writes into `.env` when it sizes the install for the server's memory.

| Variable | Explanation |
| --- | --- |
| `MEMORY_INSTANCE_NAME` | Display name used when the schema job first creates the instance. Defaults to `Prisma Memory`. |
| `MEMORY_MEM_DB` | Container memory limit for `db`. |
| `MEMORY_MEM_MIGRATE` | Container memory limit for the `migrate` schema job. |
| `MEMORY_MEM_GATEWAY` | Container memory limit for `gateway`. |
| `MEMORY_MEM_WORKERS` | Container memory limit for `workers`. |
| `MEMORY_MEM_WEB` | Container memory limit for `web`. |
| `MEMORY_MEM_S3` | Container memory limit for `s3`. |
| `MEMORY_MEM_DEMO_MODELS` | Container memory limit for `demo-models` in the `demo` profile. |
| `MEMORY_HEAP_GATEWAY` | Node.js old-generation heap limit for `gateway`, in MiB. |
| `MEMORY_HEAP_WORKERS` | Node.js old-generation heap limit for `workers`, in MiB. |
| `MEMORY_HEAP_WEB` | Node.js old-generation heap limit for `web`, in MiB. |
| `MEMORY_PG_SHARED_BUFFERS` | Memory allocated to PostgreSQL shared buffers. |
| `MEMORY_PG_EFFECTIVE_CACHE_SIZE` | Estimate of cache available to the PostgreSQL query planner. |
| `MEMORY_PG_WORK_MEM` | Base memory limit for PostgreSQL query operations such as sorts or hash tables. |
| `MEMORY_PG_SHM_SIZE` | Size of the `db` container's `/dev/shm` filesystem. |

## Checks

On the server, Docker is enough to see what the running install publishes:

```bash
docker compose --project-directory deploy/compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env \
  ps --format '{{.Service}} {{.Ports}}' | grep -F -e '->'
```

It prints exactly two lines: `gateway` with `127.0.0.1:8080->8080/tcp` and `web` with `127.0.0.1:8081->3000/tcp`,
or the publish address and the two ports that `.env` sets. Any other line, or another address, is a finding: stop
the stack with the same `docker compose` options and `stop`, then compare `compose.yaml` and `.env` with this tree.

The resolved configuration holds no secret. To compare it with the tables above, render it on the server:

```bash
docker compose --project-directory deploy/compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env \
  config --format json > compose.json
```

Look in it at what this page promises for every service: the two published ports and nothing else, the mounts of
the table, the networks, `read_only`, `cap_drop`, `security_opt`, `user`, and no `env_file`, `secrets` or `configs`
block. The automated check of this file is a maintainers' tool and is not part of this repository.

## Profiles and closed networks

`MEMORY_DEPLOY_PROFILE=internet` is the default and the only value `setup` writes without `--profile internal-http`.
An `internal-http` install treats RFC 1918 and ULA client addresses as internal. It also inherits the softer handling
of zoned IPv6 addresses outside `internet`. No such address can reach the gateway on this
file's IPv4-only networks, but it is a difference from `internet`, written here on purpose.

The gateway port is 8080 unless `GATEWAY_PORT` says otherwise. Until a public address is configured (the settings
`access.cloud_agent_base_url` or `access.public_base_url`, see
[Protected settings](../../docs/installation.md#protected-settings)), links the gateway writes into answers name port
8080. With another port `setup` prints a warning line. `setup` never writes `MEMORY_PUBLIC_URL` or
`MEMORY_TRUSTED_PROXIES`; only the overlay `compose.proxy.yaml` of the TLS front
([deploy/front/README.md](../front/README.md)) passes them to the gateway.

## Stop and start

From the root of the clone, this stops the install; its data, its secrets and its images stay:

```bash
docker compose --project-directory deploy/compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env stop
```

For an install made with `--demo`, put `--profile demo` before `stop`, or the model simulator keeps running. The
command acts on the install of this clone only, the one its `.env` names. A stopped install stays stopped after a
reboot of the server; a running one starts again when Docker starts.

To start it again, run `deploy/compose/setup` again with the options of the install. It keeps the data, the secrets
and `.env` that exist, builds the images again, starts the stack and checks the storage isolation again, as on the
first run.

## A second install on one server

Every install has its own copy of the code, its own name, its own home and its own two ports. The name gives the
compose project `prisma-memory-<name>`: `setup` writes `core` unless `--instance NAME` gives another one (1 to 63
characters, starting with a lowercase letter or digit, followed only by lowercase letters, digits, `_` or `-`). Without
`--instance`, the second copy is refused: the project `prisma-memory-core` belongs to the first copy, and the refusal
names `--instance NAME`.

Before the first run of the second copy, write its two ports into its `deploy/compose/.env`. Group and others must
have no access to the file (the command below creates it with mode 0600 when it does not exist yet), and `setup` adds
the other keys. Then run
`setup` with a name and a home of its own. From the root of that copy:

```bash
(umask 077 && printf 'GATEWAY_PORT=8090\nWEB_PORT=8091\n' > deploy/compose/.env)
deploy/compose/setup --instance second --home ~/prisma-memory-second
```

`setup` refuses a home that the install of another copy owns (its file `.setup-tree` names that copy), and a folder
that is not an install's home but holds anything `setup` never makes there. Both refusals name `--home DIR`.
