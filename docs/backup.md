# Backup and restore

This guide is for the operator of a **Prisma Memory** installation made with `deploy/compose/setup`. It shows how to
make a cold copy of an installation and how to bring the copy back.
See also: [installation](./installation.md), [configuration](./configuration.md), and [troubleshooting](./troubleshooting.md).

## What a copy holds

An installation keeps all of its state in two places:

- **The home directory** of the installation, named by the `Home:` line of the summary that `setup` prints. It holds
  the database, the stored files, the audit records and every secret of the installation.
- **The file `deploy/compose/.env`** in the copy of the repository the installation was made from. It holds the name,
  the ports, the user and the version of the installation.

The images are not part of a copy: `setup` builds them again from the same copy of the repository.

Important:

- **A copy holds every secret.** Anyone who can read it can read every stored document and every key of the
  installation. Keep it encrypted, readable only by root, and on another machine than the installation.
- **Only the same version.** A copy comes back to the version it was made from; `setup upgrade` moves it to a newer
  one afterwards (see [installation](./installation.md#upgrade-and-backup)). Keep the installed source tree with the
  copy, including any tracked changes and the Git metadata for a clone. `setup` checks both `MEMORY_VERSION` and
  `MEMORY_COMMIT` in `.env`.
- **An unpacked archive has no version.** A tree unpacked from an archive has no `.git` folder and no `VERSION` file,
  so `setup` gives it the version `0.0.0-local` and the commit `unknown`. Every such tree builds its images under the
  same tags: on one host, each `setup` run from one of them replaces the images of the others, and `setup` cannot
  refuse a tree that is not the tree of the installation. Install from a git clone, or keep one unpacked tree per host.
- **The same paths.** A copy comes back to the paths it was made from. The home records the repository's
  `deploy/compose` directory in `.setup-tree`, and `.env` names the home.
- **A cold copy.** The installation is stopped while the copy is made. A copy of a running database is not supported.
- **No command yet.** `setup backup` and `setup restore` are not in this release. The steps below are the procedure.
  `setup upgrade` copies the database before an upgrade, but that copy stays on the same disk and is not a backup.

## Make a copy

The commands use the paths of an installation made by the user `<user>` with the defaults: the repository in
`/home/<user>/prisma-memory` and the home in `/home/<user>/prisma-memory-home`. Put in your own paths. An
installation made by root has its home in `/var/lib/prisma-memory` by default.

Stop the installation. As `<user>`, from the root of the repository:

```bash
docker compose --project-directory deploy/compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env stop
```

For an installation made with `--demo`, put `--profile demo` before `stop`.

Copy the home and `.env` as root. The archive records the owners and the modes of the files; `umask 077` makes a new
archive readable by root only, so give it a name that no file has yet:

```bash
umask 077
tar -C /home/<user> -cpf /root/prisma-memory-backup.tar prisma-memory-home prisma-memory/deploy/compose/.env
```

Start the installation again. As `<user>`, from the root of the repository, run `setup` with the options of the
installation, for example `--instance` and `--home` for a second installation on the server:

```bash
deploy/compose/setup
```

It keeps the data, the secrets and `.env` that exist, builds the images again or, with `--offline KIT`, loads them
from the kit again, starts the stack and checks the storage isolation again. Then move the archive to another machine
and encrypt it there. On a test server with a home of about 100 MB, the stop took 31 seconds, the copy less than a
second and the start 31 seconds.

## Bring a copy back

The copy comes back to the same paths, with the same user and the same copy of the repository at the installed version.
On a new server, prepare it as in [installation](./installation.md) and use the account with the original installing
UID and GID. For an installation made as root, run `setup` as root. `MEMORY_UID` and `MEMORY_GID` record the runtime
IDs, which are both 10001 for a root installation. The restored `.env` must belong to the account running `setup`.
Then restore the repository to the same path.
For a Git clone, use the revision recorded in `MEMORY_COMMIT`. If it ends in `-dirty`, check out the commit before the
suffix and restore the original tracked changes. Keep the installed source tree and its Git metadata with the copy.
If `.env` records the commit `unknown`, `setup` did not read the tree as a Git clone, for example because it was
unpacked from an archive or `git` was not installed. For an archive, unpack the original archive to the same path and
keep it with the copy.

Remove the containers of the installation if it exists. For an installation made with `--demo`, add
`--profile demo` before `down`. As `<user>`, from the root of the repository:

```bash
docker compose --project-directory deploy/compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env down
```

This removes the containers and the networks of the installation. Its data stays in the home directory. Then, as
root, move the present home and `.env` aside. Keep them until the restored installation works:

```bash
mv /home/<user>/prisma-memory-home /home/<user>/prisma-memory-home.old
mv /home/<user>/prisma-memory/deploy/compose/.env /home/<user>/env.old
```

Unpack the copy as root. As root and with `-p`, `tar` restores the recorded owners and modes:

```bash
tar -C /home/<user> -xpf /root/prisma-memory-backup.tar
```

Start the installation. From the root of the repository, run `setup` as the original installing account with the
options of the installation:

```bash
deploy/compose/setup
```

**How to check.** `setup` ends with exit code 0 and prints its summary. `deploy/bin/memory-admin health` reports
`ok`, and a search finds a record that was stored before the copy was made.

## If something goes wrong

| Symptom | What to do |
| --- | --- |
| `setup` refuses with `this tree is …, the install is …` | Restore the installed source tree and its version, including any tracked changes, and run `setup` again |
| `setup` refuses with `MEMORY_HOME (…) is the home of the install in …` | The message names the original `deploy/compose` directory. Restore the repository root two levels above that directory |

---

[README](../README.md) · [Quick start](./quickstart.md) · [Installation](./installation.md) ·
[Backup and restore](./backup.md) · [Configuration](./configuration.md) · [Models](./models.md) ·
[Troubleshooting](./troubleshooting.md) · [Glossary](./glossary.md)
