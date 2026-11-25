# Preparing the server: `prepare-host.sh`

One command, run once as root on a fresh server before `deploy/compose/setup`. It installs Docker from Docker's own
repository, creates the account that runs the installation when `--user` names it, closes the firewall, switches SSH
to key-only login and sets a few safe system limits. Running it again is safe: it changes only what differs and prints
`OK` for the rest.

```sh
# a server of your own: every block
sudo bash deploy/host/prepare-host.sh --user memory --pubkey-file ~/memory.pub

# a server run by your IT team: Docker only, nothing else is touched
sudo bash deploy/host/prepare-host.sh --managed

# look without changing anything (as root it can see the firewall and SSH too)
bash deploy/host/prepare-host.sh --check
```

Supported systems: Ubuntu 22.04, 24.04 and 26.04; Debian 12 and 13 (amd64 and arm64). Anything else is refused before
the first change.

## The one step that needs you: the second connection

Closing password login and switching the firewall to "deny incoming" are the two changes that could lock you out.
The script applies them last, together, and keeps them only after it has seen a **new key login** in the system journal:

1. it arms a rollback timer (`prisma-host-rollback`, 300 s) that restores the previous SSH and firewall state;
2. it applies both changes and prints `ACTION: open a second connection now…` with the exact `ssh` command;
3. you open a second terminal and log in with your key (as the `--user` account or as the account you ran `sudo` from);
4. as soon as the journal shows `Accepted publickey for <that account>`, the timer is disarmed and the changes stay.

The wait is measured by the clock and always ends at least 15 s before the timer fires; a login seen after the timer
has fired counts as no login. No login within `--login-wait` seconds (default 240), Ctrl-C, or a lost session: both changes are rolled back, the other
blocks stay, and the script exits with 75. Run it again when you are ready. Only lines written by `sshd` itself as
root count as proof; a line any local user could write with `logger` does not. If no account has an authorized key,
nothing is switched and the script tells you to pass `--user NAME --pubkey-file FILE`.

## Blocks

Blocks always run in this order; `--only docker,ssh` runs a subset in the same order.

| Block | What it does | Files it writes | How to undo |
|---|---|---|---|
| `updates` | `apt-get update` and `apt-get --with-new-pkgs upgrade`; unattended security upgrades; reports a pending reboot (never reboots) | `/etc/apt/apt.conf.d/52prisma-memory-auto-upgrades` | delete the file |
| `docker` | Docker Engine and the compose plugin from `download.docker.com` (key fingerprint `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88` checked with a throw-away gpg home, suite checked first); log limits 50 MB × 5 when there is no `daemon.json` yet; masks `cloud-init-hotplugd.socket` (it fails on every Docker interface; not under `--managed`). A Docker that is already there is kept: a distribution Docker (`docker.io`) without the compose plugin is reported as a failure and nothing is installed or removed; so is a server without Docker that has any package docker-ce conflicts with (`docker.io`, `docker-doc`, `docker-compose`, `docker-compose-v2`, `podman-docker`, `containerd`, `runc` — apt would remove them while installing docker-ce): the failure lists them and the script never removes a package; Docker counts as installed when `docker --version` and `docker compose version` answer (neither needs the daemon), and `--check` reports `docker.service` on its own line; when only the compose plugin of an installed docker-ce is missing, only `docker-compose-plugin` is installed (the engine is not upgraded); Docker is restarted for the log limits only when this run installed the engine or started it, or no container is running (otherwise a `WARN` says the limits apply after Docker's next restart) | `/etc/apt/keyrings/docker.asc`, `/etc/apt/sources.list.d/docker.sources`, `/etc/docker/daemon.json` (only if absent) | `apt-get purge docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`, delete the three files, `systemctl unmask cloud-init-hotplugd.socket` |
| `user` | with `--user NAME`: a regular account with a locked password and no sudo; adds the keys of `--pubkey-file` that are not there yet; adds it to the group `docker` | the account's `~/.ssh/authorized_keys` (written as that account) | `gpasswd -d NAME docker`, `userdel -r NAME` |
| `firewall` | ufw: allows every SSH port of `sshd -T` (and of the current connection) and no other port, then deny incoming by default and enable (access step above); never resets, deletes or rewrites a rule, never changes outgoing or routed policy (see "Rules of yours in ufw"). The Docker guard (below), with the pairs of --admit | `/usr/local/sbin/prisma-docker-guard`, `/etc/systemd/system/prisma-docker-guard.service` | `ufw disable`; `systemctl disable --now prisma-docker-guard`, delete both files, then `iptables -D DOCKER-USER -j PRISMA-DOCKER-GUARD; iptables -F PRISMA-DOCKER-GUARD; iptables -X PRISMA-DOCKER-GUARD` (and the same with `ip6tables`) |
| `swap` | when RAM is below 7.5 GB and swap below 3.9 GB: a 4096 MB `/swapfile` (refused on btrfs or zfs, with less than 6 GB free, or when `/swapfile` exists already) | `/swapfile`, one line in `/etc/fstab` | `swapoff /swapfile`, remove the fstab line, delete the file |
| `time` | switches on clock synchronisation (`systemd-timesyncd`, or keeps `chrony`); the time zone is not touched | — | `timedatectl set-ntp false` |
| `journald` | caps the system journal at 1 GB | `/etc/systemd/journald.conf.d/60-prisma-memory.conf` | delete the file, `systemctl restart systemd-journald` |
| `oom` | the OOM killer spares `ssh` and `fail2ban` (`OOMScoreAdjust=-500`) when a build runs out of memory | `/etc/systemd/system/{ssh,fail2ban}.service.d/60-prisma-memory.conf` | delete the files, `systemctl daemon-reload` |
| `fail2ban` | `fail2ban` with the SSH jail reading the systemd journal | `/etc/fail2ban/jail.d/prisma-memory.local` | delete the file, `apt-get purge fail2ban` |
| `ssh` | key-only login: password and keyboard-interactive login off; `PermitRootLogin` is never written; the main `sshd_config` and other drop-ins are never edited. The number 10 is below cloud-init's `50-cloud-init.conf`, so it wins; the result is checked with `sshd -T` | `/etc/ssh/sshd_config.d/10-prisma-memory.conf` | delete the file, `systemctl reload ssh` |

### Rules of yours in ufw

`ufw allow 22/tcp` would silently *replace* a rule with the same match and another action (`ufw limit 22/tcp`,
`ufw deny 22/tcp`), so the script adds an allow only for a port that no incoming TCP rule names. For a port that has
one, your rule is kept byte for byte, also after a rollback:

- an allow or a rate limit (`limit`) from anywhere counts as open (`OK`);
- an allow or a rate limit for some sources, interfaces or destinations only (`allow from 203.0.113.7 to any port 22 proto tcp`): kept,
  no broader rule is added; it is `OK`, and the key login check shows whether you can still log in;
- a `deny` or `reject` from anywhere: kept; while ufw is on a `WARN`; while ufw is off a `FAIL`, and ufw is not
  switched to deny incoming, because that would cut the login;
- a `deny` or `reject` for some sources, interfaces or destinations only (`deny from 203.0.113.7 to any port 22 proto tcp`):
  it opens nothing, so the script adds its allow for everyone after it; the match differs, ufw keeps your rule, and as
  the earlier rule it still turns that source away.

Application profiles (`ufw allow OpenSSH`) are not resolved: the script adds its own allow next to them.

Ports 80 and 443 are not opened: they belong to the TLS profile, which this release does not have yet. A rule for 80
or 443 that an earlier run of this script added (comment `prisma-memory`) is kept until you delete it. The ports of
the installation itself are published by Docker and never pass through ufw: the Docker guard below decides who reaches
them.

`--managed` runs block `docker` only: on a server run by an IT team, patching, swap, firewall, login and accounts are
theirs. Add the installing account to the group `docker` yourself (or ask them to).

**The group `docker` equals root.** Anyone in it can start a container that mounts the host's file system. Add only
the account that runs the installation.

## The Docker guard

Docker publishes container ports with its own firewall rules, which bypass ufw: a port published on `0.0.0.0` by
mistake is reachable from the internet even with ufw on. The core of Prisma Memory publishes on `127.0.0.1` only, so
the guard is a second line of defence. Its rules (`--print-docker-guard` prints them):

```
*filter
:PRISMA-DOCKER-GUARD - [0:0]
-A PRISMA-DOCKER-GUARD -i lo -j RETURN
-A PRISMA-DOCKER-GUARD -i docker0 -j RETURN
-A PRISMA-DOCKER-GUARD -i br-+ -j RETURN
-A PRISMA-DOCKER-GUARD -i docker_gwbridge -j RETURN
-A PRISMA-DOCKER-GUARD -m conntrack --ctstate NEW -j DROP
COMMIT
```

A new connection that enters from anything but loopback or a Docker bridge is dropped, whatever its destination,
unless you admit it. Replies, established connections and everything containers start themselves are untouched;
`RETURN` (not `ACCEPT`) keeps Docker's own isolation rules in force.

To let a closed network reach an installation set up with `--profile internal-http --publish 192.0.2.10`, admit the
two ports it publishes there, optionally only from your network:

    sudo bash deploy/host/prepare-host.sh --only firewall --admit 192.0.2.10:8080,192.0.2.10:8081 --admit-from 198.51.100.0/24

Each pair adds one line before the `DROP` (one per pair and network with `--admit-from`):

    -A PRISMA-DOCKER-GUARD -s 198.51.100.0/24 -p tcp -m conntrack --ctstate NEW --ctorigdst 192.0.2.10 --ctorigdstport 8080 -j RETURN

The address is the one Docker publishes the port on (`MEMORY_PUBLISH_ADDR` in the installation's `.env`), never
`0.0.0.0` or `127.0.0.1`; the guard compares it with the destination of the connection before Docker's address
translation. Pairs are IPv4 and are loaded into `iptables` only; `ip6tables` gets the rules without them. Every run
of block `firewall` writes the guard from its own options: a run without `--admit` admits nothing again, and says in a
`WARN` which earlier rule it no longer has. `--print-docker-guard` with the same options prints the IPv4 rules.
`--check` compares the loaded guard with the options it is given, so it takes the same `--admit` and `--admit-from`.

`--check`, as root while Docker runs, also lists the ports the running containers publish: a pair of `--admit` is
`OK`; a pair the guard drops is `TODO` and names the `--admit` that lets it in; a port on every address (`0.0.0.0`),
on IPv6, a range or a UDP port is `TODO` too; a port on `127.0.0.1` draws no line. `deploy/compose/setup
--profile internal-http` prints the line to run for its two ports.

The chain is jumped to as the first rule of
`DOCKER-USER`; `DOCKER-USER` itself is never emptied, other rules in it are kept (the script warns about them). The
unit `prisma-docker-guard.service` runs before `docker.service`, after `ufw`, `nftables` and `netfilter-persistent`,
and again with every Docker restart, so containers with a restart policy never start before the guard after a reboot.

Limits: the guard recognises Docker bridges by name (`docker0`, `br-*`, `docker_gwbridge`) — a network created with a
custom bridge name is treated as external, and a server whose default route uses one of those names is refused. It
works with Docker's `iptables` firewall backend; the `nftables` backend is reported as a failure. UDP 443 (HTTP/3) to
a container stays closed. A server that forwards traffic between other interfaces (a router, a VPN gateway) loses
new forwarded connections that pass through `DOCKER-USER`.

## Output and exit codes

One line per fact: `LEVEL<TAB>block<TAB>text`, LEVEL is `OK`, `CHANGED`, `SKIP`, `WARN` or `FAIL`; the last lines are
`SUMMARY<TAB>reboot-required<TAB>yes|no` and `SUMMARY<TAB>login-proof<TAB>confirmed|not-needed|missing`. With
`--check` the levels are `OK`, `TODO`, `SKIP`, `UNKNOWN` (needs root) and `FAIL`; it writes nothing, takes no lock and
runs no `apt-get`.

| Code | Meaning |
|---|---|
| 0 | done (`--check`: everything is in place) |
| 1 | a block failed (`--check`: something is not done yet) |
| 64 | wrong option, account name or key file (a private key, a key with options, RSA below 3072 bits); nothing changed |
| 69 | refused before any change: unsupported system, firewalld active, a default route on a Docker bridge name, another run holds the lock (`/run/prisma-prepare-host.lock`) or the lock file cannot be opened |
| 75 | key login proof is missing. The script skips the SSH and firewall changes if no eligible account has an authorized key. If the check expires or the run is interrupted while waiting, it attempts to roll those changes back. The other blocks stay |
| 77 | not root |

When a block needs a reboot (a new kernel after `updates`), `reboot-required` is `yes`: reboot before running `setup`,
then log in again by key.
