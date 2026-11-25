#!/usr/bin/env bash
# Prepare a Linux server for Prisma Memory: run once as root, before `deploy/compose/setup`. Safe to run again: it
# changes only what differs and says so. See deploy/host/README.md for every file it writes and how to undo each block.
#
#   sudo bash deploy/host/prepare-host.sh [--user NAME --pubkey-file FILE]   # a server of your own: all blocks
#   sudo bash deploy/host/prepare-host.sh --managed                          # a server run by your IT team: Docker only
#   bash deploy/host/prepare-host.sh --check                                 # read-only report (root sees more)
#
# Options:
#   --check               report what is done and what is not; changes nothing (no lock, no temporary file)
#                         (as root with Docker running, also every published port the Docker guard drops)
#   --managed             block `docker` only: patching, swap, firewall, login and accounts belong to the server's owner
#   --only B[,B...]       run only these blocks (always in the fixed order below):
#                         updates, docker, user, firewall, swap, time, journald, oom, fail2ban, ssh
#   --user NAME           block `user`: create the account that runs `setup` (no password, no sudo) and add it to the
#                         group `docker`
#   --pubkey-file FILE    public SSH key(s) to add to that account's authorized_keys
#   --login-wait SEC      how long to wait for the key login in a second connection (default 240, at most 280)
#   --docker-suite NAME   Docker repository suite when it differs from VERSION_CODENAME of /etc/os-release
#   --admit ADDR:PORT[,ADDR:PORT...]
#                         block `firewall`: the Docker guard admits new connections from outside to exactly these
#                         published ports (an IPv4 address of this server and a TCP port, e.g. 192.0.2.10:8081); without
#                         it the guard admits none. A run replaces the list of the run before: name every pair each time
#   --admit-from NET[,NET...]
#                         with --admit: admit only from these IPv4 networks (198.51.100.0/24; one address means /32)
#   --print-docker-guard  print the DOCKER-USER guard rules (iptables-restore format) and exit
#   --help                this text
#
# Exit codes: 0 done · 1 a block failed · 64 wrong usage or input · 69 refused before any change (unsupported system,
# firewalld active, another run holds the lock, a default route on a Docker bridge) · 75 the key login was not proven:
# the firewall switch and the SSH password change were rolled back or never applied, the other blocks stay · 77 not root.
#
# Output: one line per fact, "LEVEL<TAB>block<TAB>text"; LEVEL is OK, CHANGED, SKIP, WARN or FAIL (with --check: OK,
# TODO, SKIP, UNKNOWN or FAIL). The last lines are "SUMMARY<TAB>reboot-required<TAB>yes|no" and
# "SUMMARY<TAB>login-proof<TAB>confirmed|not-needed|missing".
# shellcheck disable=SC2329,SC2016 # blocks are called by name and from traps; quoted sh -c bodies take "$1"
set -euo pipefail
umask 022

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  echo "prepare-host: bash 4.4 or newer is required" >&2
  exit 69
fi

BLOCKS=(updates docker user firewall swap time journald oom fail2ban ssh)
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
NAME_RE='^[a-z_][a-z0-9_-]{0,31}$'
# accounts that may prove the key login: also directory names such as john.doe or ann@example.com (no spaces, no leading -)
PROOF_NAME_RE='^[[:alnum:]_][[:alnum:]_.@-]{0,63}[$]?$'
KEY_TYPES_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)[[:space:]]'
LOCK_FILE=/run/prisma-prepare-host.lock
STATE_DIR=/var/lib/prisma-memory-host
ROLLBACK_UNIT=prisma-host-rollback
ROLLBACK_AFTER=300   # the rollback timer fires this many seconds after it is armed
ROLLBACK_MARGIN=15   # the wait for the key login ends at least this long before it
GUARD_HELPER=/usr/local/sbin/prisma-docker-guard
GUARD_UNIT=prisma-docker-guard.service
SSH_DROPIN=/etc/ssh/sshd_config.d/10-prisma-memory.conf
COMMENT=prisma-memory

# The DOCKER-USER guard. Docker's published ports bypass ufw; this chain drops every NEW connection that enters from
# anything but loopback or a Docker bridge, except one whose original destination (before Docker's address translation)
# is a pair of --admit, from a network of --admit-from when given. The pairs are IPv4: they are loaded into iptables
# only, and ip6tables gets the head and the tail alone. RETURN, not ACCEPT: Docker's own isolation rules still apply.
GUARD_HEAD='*filter
:PRISMA-DOCKER-GUARD - [0:0]
-A PRISMA-DOCKER-GUARD -i lo -j RETURN
-A PRISMA-DOCKER-GUARD -i docker0 -j RETURN
-A PRISMA-DOCKER-GUARD -i br-+ -j RETURN
-A PRISMA-DOCKER-GUARD -i docker_gwbridge -j RETURN'
GUARD_TAIL='-A PRISMA-DOCKER-GUARD -m conntrack --ctstate NEW -j DROP
COMMIT'

usage() { sed -n '2,/^set -euo/{/^set -euo/d;/^# shellcheck/d;s/^# \{0,1\}//;p}' "$0"; }
die() { local code=$1; shift; echo "prepare-host: $*" >&2; exit "$code"; }

# ------------------------------------------------------------------------------------------------ arguments
CHECK=0; MANAGED=0; ONLY=""; USER_NAME=""; PUBKEY_FILE=""; LOGIN_WAIT=240; DOCKER_SUITE=""; PRINT_GUARD=0
ADMIT_PAIRS=(); ADMIT_NETS=()
need_val() { [ $# -ge 2 ] && [ -n "$2" ] || die 64 "$1 needs a value (see --help)"; }
is_ipv4() {
  local octet='(0|[1-9][0-9]{0,2})'
  [[ $1 =~ ^$octet\.$octet\.$octet\.$octet$ ]] &&
    (( BASH_REMATCH[1] <= 255 && BASH_REMATCH[2] <= 255 && BASH_REMATCH[3] <= 255 && BASH_REMATCH[4] <= 255 ))
}
parse_admit() {
  local LC_ALL=C list=$1 item addr port first
  while :; do
    item=${list%%,*}; addr=${item%:*}; port=${item#*:}
    [[ $item =~ ^[0-9.]+:[0-9]+$ && $port =~ ^[1-9][0-9]{0,4}$ ]] && is_ipv4 "$addr" && (( port <= 65535 )) ||
      die 64 "--admit: '$item' is not ADDR:PORT (an IPv4 address of this server and a TCP port, e.g. 192.0.2.10:8081)"
    first=${addr%%.*}
    if [[ $addr = 0.0.0.0 ]] || (( first == 127 || first >= 224 )); then
      die 64 "--admit: '$item' cannot be admitted; name the address the port is published on (not 0.0.0.0, not loopback, not multicast or reserved)"
    fi
    [[ " ${ADMIT_PAIRS[*]} " != *" $item "* ]] || die 64 "--admit: '$item' is named twice"
    [ "${#ADMIT_PAIRS[@]}" -lt 16 ] || die 64 "--admit: at most 16 pairs"
    ADMIT_PAIRS+=("$item")
    [[ $list == *,* ]] || break
    list=${list#*,}
  done
}
parse_admit_from() {
  local LC_ALL=C list=$1 item addr len ip net cidr
  while :; do
    item=${list%%,*}; addr=${item%/*}; len=32
    if [[ $item == */* ]]; then len=${item#*/}; fi
    [[ $item =~ ^[0-9.]+(/[0-9]+)?$ && $len =~ ^[1-9][0-9]?$ ]] && (( len <= 32 )) && is_ipv4 "$addr" ||
      die 64 "--admit-from: '$item' is not an IPv4 network (e.g. 198.51.100.0/24, or one address)"
    ip=$((BASH_REMATCH[1] << 24 | BASH_REMATCH[2] << 16 | BASH_REMATCH[3] << 8 | BASH_REMATCH[4]))
    net=$((ip & (0xffffffff << (32 - len))))
    printf -v cidr '%d.%d.%d.%d/%d' "$((net >> 24))" "$((net >> 16 & 255))" "$((net >> 8 & 255))" "$((net & 255))" "$len"
    [ "$ip" = "$net" ] || die 64 "--admit-from: '$item' has host bits set; write the network address, e.g. $cidr"
    [[ " ${ADMIT_NETS[*]} " != *" $cidr "* ]] || die 64 "--admit-from: '$item' is named twice"
    [ "${#ADMIT_NETS[@]}" -lt 8 ] || die 64 "--admit-from: at most 8 networks"
    ADMIT_NETS+=("$cidr")
    [[ $list == *,* ]] || break
    list=${list#*,}
  done
}
build_guard_rules() {
  local pair net match
  GUARD_RULES6=$GUARD_HEAD$'\n'$GUARD_TAIL
  GUARD_RULES4=$GUARD_HEAD
  for pair in "${ADMIT_PAIRS[@]}"; do
    match="-p tcp -m conntrack --ctstate NEW --ctorigdst ${pair%:*} --ctorigdstport ${pair#*:} -j RETURN"
    if [ "${#ADMIT_NETS[@]}" -eq 0 ]; then
      GUARD_RULES4+=$'\n'"-A PRISMA-DOCKER-GUARD $match"
    else
      for net in "${ADMIT_NETS[@]}"; do
        GUARD_RULES4+=$'\n'"-A PRISMA-DOCKER-GUARD -s $net $match"
      done
    fi
  done
  GUARD_RULES4+=$'\n'$GUARD_TAIL
}
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --managed) MANAGED=1 ;;
    --only) need_val "$@"; ONLY=$2; shift ;;
    --user) need_val "$@"; USER_NAME=$2; shift ;;
    --pubkey-file) need_val "$@"; PUBKEY_FILE=$2; shift ;;
    --login-wait) need_val "$@"; LOGIN_WAIT=$2; shift ;;
    --docker-suite) need_val "$@"; DOCKER_SUITE=$2; shift ;;
    --admit) need_val "$@"; parse_admit "$2"; shift ;;
    --admit-from) need_val "$@"; parse_admit_from "$2"; shift ;;
    --print-docker-guard) PRINT_GUARD=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die 64 "unknown option: $1 (see --help)" ;;
  esac
  shift
done
if [ "${#ADMIT_PAIRS[@]}" -eq 0 ]; then
  [ "${#ADMIT_NETS[@]}" -eq 0 ] || die 64 "--admit-from needs --admit"
else
  [ "$MANAGED" = 0 ] || die 64 "--managed does not run block firewall: drop --admit"
fi

declare -A SEL=()
if [ -n "$ONLY" ]; then
  [[ $ONLY =~ ^[a-z0-9]+(,[a-z0-9]+)*$ ]] || die 64 "--only: a comma-separated list of blocks (${BLOCKS[*]})"
  IFS=, read -r -a only_list <<<"$ONLY"
  [ "${#only_list[@]}" -gt 0 ] || die 64 "--only needs at least one block"
  for b in "${only_list[@]}"; do
    case " ${BLOCKS[*]} " in *" $b "*) SEL[$b]=1 ;; *) die 64 "unknown block in --only: '$b' (blocks: ${BLOCKS[*]})" ;; esac
  done
else
  for b in "${BLOCKS[@]}"; do SEL[$b]=1; done
fi
if [ "$MANAGED" = 1 ]; then
  [ -z "$USER_NAME" ] || die 64 "--managed does not create accounts: drop --user"
  for b in "${!SEL[@]}"; do [ "$b" = docker ] || [ -z "$ONLY" ] || die 64 "--managed runs block docker only, not '$b'"; done
  SEL=([docker]=1)
fi
[ -z "$PUBKEY_FILE" ] || [ -n "$USER_NAME" ] || die 64 "--pubkey-file needs --user"
if [ -n "$USER_NAME" ]; then
  [[ $USER_NAME =~ $NAME_RE ]] || die 64 "--user: '$USER_NAME' is not a valid account name (lower case letters, digits, _ and -)"
  [ "$USER_NAME" != root ] || die 64 "--user: root is not an installation account; name a new or an existing regular account"
fi
[[ $LOGIN_WAIT =~ ^[0-9]{1,3}$ ]] && [ "$LOGIN_WAIT" -ge 1 ] && [ "$LOGIN_WAIT" -le 280 ] \
  || die 64 "--login-wait: seconds from 1 to 280 (the rollback timer fires at 300)"
[ -z "$DOCKER_SUITE" ] || [[ $DOCKER_SUITE =~ ^[a-z0-9][a-z0-9.-]{0,31}$ ]] || die 64 "--docker-suite: '$DOCKER_SUITE' is not a suite name"
sel() { [ -n "${SEL[$1]:-}" ]; }
[ "${#ADMIT_PAIRS[@]}" -eq 0 ] || sel firewall || die 64 "--admit needs block firewall (add it to --only)"
build_guard_rules
if [ "$PRINT_GUARD" = 1 ]; then printf '%s\n' "$GUARD_RULES4"; exit 0; fi

# ------------------------------------------------------------------------------------------------ environment
# PREPARE_HOST_TEST_ROOT — only for the script's own tests: every system path gets this prefix and the caller's PATH
# (with stub commands) is kept. Empty in real use.
R=${PREPARE_HOST_TEST_ROOT:-}
if [ -n "$R" ]; then
  [ -d "$R" ] && [ "${R#/}" != "$R" ] || die 64 "PREPARE_HOST_TEST_ROOT must be an existing absolute directory"
  echo "test mode: prefix=$R" >&2
else
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
fi
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 LC_ALL=C

IS_ROOT=0; [ "$(id -u)" = 0 ] && IS_ROOT=1
[ "$CHECK" = 1 ] || [ "$IS_ROOT" = 1 ] || die 77 "run as root (sudo); to look without changing anything use --check"

# ------------------------------------------------------------------------------------------------ output
FAILED=0; CHECK_BAD=0; LOGIN_PROOF=not-needed
emit() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3"
  case "$1" in FAIL) FAILED=1; CHECK_BAD=1 ;; TODO|UNKNOWN) CHECK_BAD=1 ;; esac
}
ok() { emit OK "$1" "$2"; }
changed() { emit CHANGED "$1" "$2"; }
fail() { emit FAIL "$1" "$2"; return 1; }
todo() { emit TODO "$1" "$2"; }
unknown() { emit UNKNOWN "$1" "$2 (run as root)"; }

# ------------------------------------------------------------------------------------------------ helpers
apt_get() {
  apt-get -qq --no-remove -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@" >/dev/null
}
pkg_status() { dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null || true; }
pkg_installed() { [ "$(pkg_status "$1")" = installed ]; }
unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
unit_enabled_state() { systemctl is-enabled "$1" 2>/dev/null || true; }
# same_file MODE PATH CONTENT — PATH is a regular file with exactly CONTENT (plus a final newline) and MODE
same_file() {
  [ -f "$2" ] && [ ! -L "$2" ] && printf '%s\n' "$3" | cmp -s - "$2" && [ "$(stat -c %a "$2")" = "${1#0}" ]
}
# put_file MODE PATH CONTENT — write only when different; the new text goes to PATH.prisma-new next to the target and
# is installed from there (never `install /dev/stdin`: uutils coreutils fail on an existing target). Sets PUT.
put_file() {
  local mode=$1 path=$2 content=$3 dir
  PUT=same
  same_file "$mode" "$path" "$content" && return 0
  dir=$(dirname "$path")
  [ -d "$dir" ] || install -d -m 0755 "$dir" || return 1
  [ ! -L "$path" ] || rm -f "$path" || return 1
  rm -f "$path.prisma-new" || return 1
  if ! printf '%s\n' "$content" | tee "$path.prisma-new" >/dev/null || ! install -m "$mode" "$path.prisma-new" "$path"; then
    rm -f "$path.prisma-new"; return 1
  fi
  rm -f "$path.prisma-new"
  PUT=changed
}
# shell-quote for the generated rollback helper (POSIX sh)
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# ------------------------------------------------------------------------------------------------ operating system
OS_ID=""; OS_VER=""; OS_CODENAME=""
[ -r "$R/etc/os-release" ] || die 69 "no /etc/os-release: unsupported system (Ubuntu 22.04, 24.04, 26.04, Debian 12, 13)"
# shellcheck source=/dev/null
OS_ID=$(. "$R/etc/os-release" && printf '%s' "${ID:-}") || die 69 "cannot read /etc/os-release"
# shellcheck source=/dev/null
OS_VER=$(. "$R/etc/os-release" && printf '%s' "${VERSION_ID:-}") || die 69 "cannot read /etc/os-release"
# shellcheck source=/dev/null
OS_CODENAME=$(. "$R/etc/os-release" && printf '%s' "${VERSION_CODENAME:-}") || die 69 "cannot read /etc/os-release"
case "$OS_ID:$OS_VER" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;;
  *) die 69 "unsupported system '${OS_ID:-?} ${OS_VER:-?}' (supported: Ubuntu 22.04, 24.04, 26.04, Debian 12, 13)" ;;
esac

mem_mb() { awk '$1 == "MemTotal:" {printf "%d", $2 / 1024}' "$R/proc/meminfo"; }
swap_mb() { awk 'NR > 1 {s += $3} END {printf "%d", s / 1024}' "$R/proc/swaps" 2>/dev/null || echo 0; }
swapfile_active() { awk 'NR > 1 && $1 == "/swapfile" {f = 1} END {exit !f}' "$R/proc/swaps" 2>/dev/null; }
default_ifaces() { { ip -o route show default 2>/dev/null; ip -6 -o route show default 2>/dev/null; } | awk '{for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1)}' | sort -u; }
home_of() { getent passwd "$1" | cut -d: -f6; }
uid_of() { getent passwd "$1" | cut -d: -f3; }
ufw_present() { pkg_installed ufw; }
ufw_active() { ufw status 2>/dev/null | awk 'NR == 1 && $0 == "Status: active" {f = 1} END {exit !f}'; }
# incoming default as ufw stores it (also while ufw is off): deny, allow or reject
ufw_default_in() {
  local v
  v=$(sed -n 's/^DEFAULT_INPUT_POLICY="\{0,1\}\([A-Z]*\)"\{0,1\}$/\1/p' "$R/etc/default/ufw" 2>/dev/null | tail -n 1)
  case "$v" in DROP) echo deny ;; ACCEPT) echo allow ;; REJECT) echo reject ;; *) echo unknown ;; esac
}
# ufw_port_rule PORT — how the rules of `ufw show added` treat new incoming connections to PORT/tcp. Prints one line
# "STATE<TAB>rule": allow (an allow from anywhere), limit (a rate limit from anywhere), block (a deny or reject from
# anywhere), narrow (an allow or limit on that port with a source address or port, an interface, a destination) or none
# (no rule opens or closes the port for everyone). Outgoing and routed rules, other protocols and rules without a port do
# not count; application profiles (`ufw allow OpenSSH`) are not resolved and count as none. A deny or reject with such a
# narrowing (`ufw deny from 203.0.113.7 to any port 22`) opens nothing: it counts as none, so the allow for everyone is
# added after it — its match differs, ufw keeps the rule and, coming first, it still turns that one source away. Real ufw
# REPLACES a rule with the same match and another action, so `ufw allow` is called only for none: a rule of the
# administrator is never rewritten.
ufw_port_rule() {
  ufw show added 2>/dev/null | awk -v P="$1" '
    function covers(spec,   proto, ports, n, i, parts, r) {
      proto = ""; ports = spec
      if (index(spec, "/")) { proto = substr(spec, index(spec, "/") + 1); ports = substr(spec, 1, index(spec, "/") - 1) }
      if (proto != "" && proto != "tcp") return 0
      n = split(ports, parts, ",")
      for (i = 1; i <= n; i++) {
        if (parts[i] ~ /^[0-9]+$/ && parts[i] + 0 == P + 0) return 1
        if (parts[i] ~ /^[0-9]+:[0-9]+$/) { split(parts[i], r, ":"); if (P + 0 >= r[1] + 0 && P + 0 <= r[2] + 0) return 1 }
      }
      return 0
    }
    $1 == "ufw" {
      rule = $0; line = $0; sub(/ comment .*$/, "", line)
      n = split(line, t, " "); i = 2
      act = t[i++]
      if (act !~ /^(allow|deny|reject|limit)$/) next
      if (t[i] == "in") i++; else if (t[i] == "out") next
      narrow = 0
      if (t[i] == "on") { narrow = 1; i += 2 }
      if (t[i] == "log" || t[i] == "log-all") i++
      from = "any"; to = "any"; dport = ""; proto = ""; ctx = "to"
      if (i <= n && t[i] != "from" && t[i] != "to" && t[i] != "proto") dport = t[i++]
      for (; i <= n; i++) {
        if (t[i] == "from") { from = t[++i]; ctx = "from" }
        else if (t[i] == "to") { to = t[++i]; ctx = "to" }
        else if (t[i] == "port") { if (ctx == "from") narrow = 1; else dport = t[i + 1]; i++ }
        else if (t[i] == "proto") proto = t[++i]
        else if (t[i] == "app") { dport = ""; break }
      }
      if (dport == "") next
      if (proto != "" && index(dport, "/") == 0) dport = dport "/" proto
      if (!covers(dport)) next
      if (from != "any" || to != "any") narrow = 1
      if (narrow && act != "allow" && act != "limit") next   # a narrow deny or reject opens nothing (see above)
      if (narrow) { if (nar == "") nar = rule }
      else if (act == "allow") { if (al == "") al = rule }
      else if (act == "limit") { if (lim == "") lim = rule }
      else if (blk == "") blk = rule
    }
    END {
      if (blk != "") print "block\t" blk; else if (al != "") print "allow\t" al
      else if (lim != "") print "limit\t" lim; else if (nar != "") print "narrow\t" nar; else print "none\t"
    }'
}
sshd_t() { sshd -T 2>/dev/null; }
sshd_val() { printf '%s\n' "$1" | awk -v k="$2" '$1 == k {print $2; exit}'; }

# ------------------------------------------------------------------------------------------------ preflight
# Everything that refuses (64, 69) runs before the first write.
KEY_LINES=()
if [ -n "$PUBKEY_FILE" ] && [ "$CHECK" = 0 ]; then
  [ -f "$PUBKEY_FILE" ] && [ -r "$PUBKEY_FILE" ] || die 64 "--pubkey-file: cannot read the file"
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in ''|'#'*) continue ;; esac
    [[ $line =~ $KEY_TYPES_RE ]] || die 64 "--pubkey-file: line $n is not a public key line ('type base64 [comment]', no options); the file is not shown"
    KEY_LINES+=("$line")
  done <"$PUBKEY_FILE"
  [ "${#KEY_LINES[@]}" -gt 0 ] || die 64 "--pubkey-file: no public key in the file"
  fp=$(ssh-keygen -l -f "$PUBKEY_FILE" 2>/dev/null) || die 64 "--pubkey-file: ssh-keygen does not accept the file as public keys"
  while read -r bits _ rest; do
    case "$rest" in *'(RSA)') [ "${bits:-0}" -ge 3072 ] || die 64 "--pubkey-file: an RSA key shorter than 3072 bits; use ed25519 or RSA 3072+" ;; esac
  done <<<"$fp"
fi
if [ -n "$USER_NAME" ] && getent passwd "$USER_NAME" >/dev/null 2>&1; then
  u=$(uid_of "$USER_NAME")
  { [ "${u:-0}" -ge 1000 ] && [ "$u" -lt 65534 ]; } || die 64 "--user: '$USER_NAME' is a system account (uid $u); name a regular account"
fi
if sel firewall && [ "$CHECK" = 0 ]; then
  ! unit_active firewalld || die 69 "firewalld is active: this script manages ufw only; stop firewalld or run without block firewall"
  while read -r ifc; do
    case "$ifc" in docker0|br-*|docker_gwbridge)
      die 69 "the default route uses '$ifc', a name the Docker guard treats as a Docker bridge; rename the interface or run without block firewall" ;;
    esac
  done < <(default_ifaces)
fi

# lock and an unfinished run
if [ "$CHECK" = 0 ]; then
  # in /run itself (root only), not in the world-writable /run/lock where any local user could plant the name
  { exec 9>"$R$LOCK_FILE"; } 2>/dev/null || die 69 "cannot open the lock file $LOCK_FILE (a file of another user in the way?)"
  flock -n 9 || die 69 "another prepare-host run holds $LOCK_FILE"
  if [ -f "$R$STATE_DIR/rollback.sh" ]; then
    systemctl stop "$ROLLBACK_UNIT.timer" >/dev/null 2>&1 || true
    if [ "$(stat -c %a "$R$STATE_DIR")" = 700 ] && /bin/sh "$R$STATE_DIR/rollback.sh"; then
      emit WARN access "an earlier run was interrupted while waiting for the key login: its SSH and firewall changes were rolled back"
    else
      die 69 "an earlier run left $STATE_DIR/rollback.sh and it did not finish; run it by hand, then this script again"
    fi
  fi
fi

QUEUE_UFW=0; QUEUE_SSH=0; UFW_WAS_ACTIVE=0; UFW_PREV_IN=unknown

# ------------------------------------------------------------------------------------------------ block: updates
AUTO_UPGRADES='// Written by Prisma Memory prepare-host.sh: daily package lists and unattended security upgrades.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";'
blk_updates() {
  local f="$R/etc/apt/apt.conf.d/52prisma-memory-auto-upgrades" n
  if [ "$CHECK" = 1 ]; then
    if pkg_installed unattended-upgrades; then ok updates "unattended-upgrades is installed"; else todo updates "unattended-upgrades is not installed"; fi
    if same_file 0644 "$f" "$AUTO_UPGRADES"; then ok updates "automatic security upgrades are on"; else todo updates "automatic security upgrades are not set up"; fi
    return 0
  fi
  apt_get update || { fail updates "apt-get update failed"; return 1; }
  n=$(apt-get -s -o DPkg::Lock::Timeout=300 --with-new-pkgs upgrade 2>/dev/null | grep -c '^Inst ' || true)
  if [ "${n:-0}" -gt 0 ]; then
    apt_get -y --with-new-pkgs upgrade || { fail updates "apt-get upgrade failed"; return 1; }
    changed updates "$n package(s) upgraded"
  else
    ok updates "all packages are up to date"
  fi
  if ! pkg_installed unattended-upgrades; then
    apt_get -y install unattended-upgrades || { fail updates "installing unattended-upgrades failed"; return 1; }
    changed updates "unattended-upgrades installed"
  fi
  put_file 0644 "$f" "$AUTO_UPGRADES" || { fail updates "cannot write ${f#"$R"}"; return 1; }
  if [ "$PUT" = changed ]; then changed updates "automatic security upgrades switched on (${f#"$R"})"; else ok updates "automatic security upgrades are on"; fi
}

# ------------------------------------------------------------------------------------------------ block: docker
DAEMON_JSON='{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }'
# installed = the client and its compose plugin answer; neither needs the daemon (`docker version` fails without access
# to the daemon's socket, so it says nothing about what is installed)
docker_cli() { docker --version >/dev/null 2>&1; }
docker_installed() { docker_cli && docker compose version >/dev/null 2>&1; }
# Docker's list of conflicting packages, used to name them in the refusal before changing the host.
DOCKER_CONFLICTS="docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc"
docker_conflicts() {
  local p out=""
  for p in $DOCKER_CONFLICTS; do
    case "$(pkg_status "$p")" in
      half-installed|unpacked|half-configured|triggers-awaited|triggers-pending|installed) out+="${out:+ }$p" ;;
    esac
  done
  printf '%s\n' "$out"
}
docker_install_refusal() {
  local conflicts
  if docker_cli; then
    printf '%s\n' "a Docker that is not Docker's own docker-ce is installed and has no compose plugin: nothing was installed or removed; install that Docker's compose plugin (Ubuntu: docker-compose-v2) or remove that Docker yourself, then run again"
  else
    conflicts=$(docker_conflicts)
    if [ -n "$conflicts" ]; then
      printf '%s\n' "installing docker-ce would remove these installed packages: $conflicts — nothing was installed or removed; remove them yourself if nothing else needs them (or give that Docker its compose plugin), then run again"
    fi
  fi
}
# key_primaries HOME FILE: the fingerprints of the primary keys in the key file FILE, one per line (the fpr record that
# follows each pub record; the fpr of a subkey is not one), read through the throw-away gpg home HOME
key_primaries() {
  gpg --homedir "$1" --show-keys --with-colons "$2" 2>/dev/null | awk -F: '$1 == "pub" {p = 1; next} $1 == "sub" {p = 0; next} $1 == "fpr" && p {print $10; p = 0}' || true
}
blk_docker() {
  local suite=${DOCKER_SUITE:-$OS_CODENAME} kr="$R/etc/apt/keyrings" src="$R/etc/apt/sources.list.d/docker.sources" fpr arch hp gh
  local fresh=0 had_ce=0 docker_ready=0 running refusal=""
  if docker_installed; then
    docker_ready=1
    ok docker "Docker and docker compose are installed"
  elif pkg_installed docker-ce; then
    had_ce=1
  else
    refusal=$(docker_install_refusal)
    if [ -n "$refusal" ]; then
      emit FAIL docker "$refusal"
      [ "$CHECK" = 1 ] || return 1
    fi
  fi
  if [ "$CHECK" = 1 ]; then
    if [ "$docker_ready" = 0 ] && [ -z "$refusal" ]; then
      if docker_cli; then todo docker "Docker is installed but its compose plugin is not"
      else todo docker "Docker is not installed"; fi
    fi
    if docker_cli; then
      if unit_active docker; then ok docker "docker.service is running"; else todo docker "docker.service is not running"; fi
    fi
    if [ -f "$R/etc/docker/daemon.json" ]; then ok docker "/etc/docker/daemon.json exists (log limits)"; else todo docker "no /etc/docker/daemon.json (log limits)"; fi
    if [ "$MANAGED" = 0 ]; then
      hp=$(unit_enabled_state cloud-init-hotplugd.socket)
      case "$hp" in masked) ok docker "cloud-init network hotplug is masked" ;; ''|not-found) ;; *) todo docker "cloud-init network hotplug is on (it fails on every Docker interface)" ;; esac
    fi
    return 0
  fi
  if [ "$docker_ready" = 0 ]; then
    [ -n "$suite" ] || { fail docker "no VERSION_CODENAME in /etc/os-release: pass --docker-suite"; return 1; }
    apt_get update || { fail docker "apt-get update failed"; return 1; }
    apt_get -y install ca-certificates curl gnupg || { fail docker "installing ca-certificates, curl, gnupg failed"; return 1; }
    [ -d "$kr" ] || install -d -m 0755 "$kr" || { fail docker "cannot create /etc/apt/keyrings"; return 1; }
    # the suite must exist in Docker's repository; the answer goes to a file, never into a pipe under pipefail
    rm -f "$kr/docker-release.prisma-new"
    if ! curl -fsS --max-time 60 -o "$kr/docker-release.prisma-new" "https://download.docker.com/linux/$OS_ID/dists/$suite/Release"; then
      rm -f "$kr/docker-release.prisma-new"
      fail docker "Docker's repository has no suite '$suite' for $OS_ID; pass the right one with --docker-suite NAME"; return 1
    fi
    rm -f "$kr/docker-release.prisma-new" "$kr/docker.asc.prisma-new" "$kr/docker.asc.prisma-key"
    if ! curl -fsS --max-time 60 -o "$kr/docker.asc.prisma-new" "https://download.docker.com/linux/$OS_ID/gpg"; then
      rm -f "$kr/docker.asc.prisma-new"; fail docker "cannot download Docker's repository key"; return 1
    fi
    # a throw-away gpg home: reading the key must not create root's ~/.gnupg. The downloaded file must hold exactly one
    # primary key, the expected one; APT then trusts a keyring that holds only that key, exported by its
    # fingerprint after an import into the throw-away home, never the downloaded file. --no-autostart: no gpg-agent.
    gh=$(mktemp -d) || { rm -f "$kr/docker.asc.prisma-new"; fail docker "mktemp -d failed"; return 1; }
    fpr=$(key_primaries "$gh" "$kr/docker.asc.prisma-new")
    case $fpr in
      *$'\n'*)
        rm -r -f -- "$gh"; rm -f "$kr/docker.asc.prisma-new"
        fail docker "Docker's repository key file holds more than one key (${fpr//$'\n'/ }); only $DOCKER_KEY_FPR is trusted; nothing was installed"; return 1 ;;
    esac
    if [ "$fpr" != "$DOCKER_KEY_FPR" ]; then
      rm -r -f -- "$gh"; rm -f "$kr/docker.asc.prisma-new"
      fail docker "Docker's repository key has an unexpected fingerprint (${fpr:-none}); nothing was installed"; return 1
    fi
    if ! gpg --homedir "$gh" --batch --quiet --no-autostart --import "$kr/docker.asc.prisma-new" 2>/dev/null ||
       ! gpg --homedir "$gh" --batch --yes --no-autostart --armor --output "$kr/docker.asc.prisma-key" --export "$DOCKER_KEY_FPR" 2>/dev/null ||
       [ "$(key_primaries "$gh" "$kr/docker.asc.prisma-key")" != "$DOCKER_KEY_FPR" ]; then
      rm -r -f -- "$gh"; rm -f "$kr/docker.asc.prisma-new" "$kr/docker.asc.prisma-key"
      fail docker "cannot export the checked key $DOCKER_KEY_FPR into a keyring of its own; nothing was installed"; return 1
    fi
    rm -r -f -- "$gh"
    if ! install -m 0644 "$kr/docker.asc.prisma-key" "$kr/docker.asc"; then rm -f "$kr/docker.asc.prisma-new" "$kr/docker.asc.prisma-key"; fail docker "cannot install the key"; return 1; fi
    rm -f "$kr/docker.asc.prisma-new" "$kr/docker.asc.prisma-key"
    arch=$(dpkg --print-architecture) || { fail docker "dpkg --print-architecture failed"; return 1; }
    put_file 0644 "$src" "Types: deb
URIs: https://download.docker.com/linux/$OS_ID
Suites: $suite
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc" || { fail docker "cannot write /etc/apt/sources.list.d/docker.sources"; return 1; }
    apt_get update || { fail docker "apt-get update with Docker's repository failed"; return 1; }
    if [ "$had_ce" = 1 ]; then
      # docker-ce is there and only its compose plugin is missing: the plugin alone, so the engine of a running server
      # is not upgraded, and this does not count as a fresh Docker (no restart under running containers below)
      apt_get -y install docker-compose-plugin || { fail docker "installing Docker's compose plugin failed"; return 1; }
      changed docker "Docker's compose plugin installed from download.docker.com ($OS_ID $suite, key $DOCKER_KEY_FPR)"
    else
      apt_get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        || { fail docker "installing Docker failed"; return 1; }
      changed docker "Docker installed from download.docker.com ($OS_ID $suite, key $DOCKER_KEY_FPR)"
      fresh=1
    fi
  fi
  if ! unit_active docker; then
    systemctl enable --now docker >/dev/null 2>&1 || { fail docker "cannot start docker.service"; return 1; }
    changed docker "docker.service enabled and started"
    fresh=1
  fi
  if [ -f "$R/etc/docker/daemon.json" ]; then
    ok docker "/etc/docker/daemon.json exists, left as it is"
  else
    put_file 0644 "$R/etc/docker/daemon.json" "$DAEMON_JSON" || { fail docker "cannot write /etc/docker/daemon.json"; return 1; }
    # the limits need a daemon restart, which stops every running container: only when Docker was just installed or
    # started by this run, or when nothing runs
    if [ "$fresh" = 1 ] || { running=$(docker ps -q 2>/dev/null) && [ -z "$running" ]; }; then
      systemctl restart docker >/dev/null 2>&1 || { fail docker "docker.service did not restart with the log limits"; return 1; }
      changed docker "container log limits 50m x 5 (/etc/docker/daemon.json)"
    else
      emit WARN docker "container log limits 50m x 5 written to /etc/docker/daemon.json, but Docker was not restarted: containers are running (or their list is not readable); the limits apply to containers created after Docker's next restart"
    fi
  fi
  if [ "$MANAGED" = 0 ]; then
    hp=$(unit_enabled_state cloud-init-hotplugd.socket)
    case "$hp" in
      masked) ok docker "cloud-init network hotplug is masked" ;;
      ''|not-found) ;;
      *) systemctl mask cloud-init-hotplugd.socket >/dev/null 2>&1 || { fail docker "cannot mask cloud-init-hotplugd.socket"; return 1; }
         changed docker "cloud-init network hotplug masked (it fails on every Docker interface)" ;;
    esac
  fi
}

# ------------------------------------------------------------------------------------------------ block: user
key_blob() { printf '%s\n' "$1" | awk '{print $2}'; }
blk_user() {
  local home ssh_dir ak have missing="" line blob members
  if [ -z "$USER_NAME" ]; then emit SKIP user "no --user given"; return 0; fi
  if [ "$CHECK" = 1 ]; then
    if getent passwd "$USER_NAME" >/dev/null 2>&1; then ok user "account $USER_NAME exists"; else todo user "account $USER_NAME does not exist"; return 0; fi
    members=$(getent group docker 2>/dev/null | cut -d: -f4)
    case ",$members," in *",$USER_NAME,"*) ok user "$USER_NAME is in the group docker" ;; *) todo user "$USER_NAME is not in the group docker" ;; esac
    return 0
  fi
  if getent passwd "$USER_NAME" >/dev/null 2>&1; then
    ok user "account $USER_NAME exists"
  else
    useradd --create-home --shell /bin/bash "$USER_NAME" >/dev/null || { fail user "useradd $USER_NAME failed"; return 1; }
    changed user "account $USER_NAME created (no password, no sudo)"
  fi
  home="$R$(home_of "$USER_NAME")"
  [ "$home" != "$R" ] && [ -d "$home" ] || { fail user "account $USER_NAME has no home directory"; return 1; }
  ssh_dir="$home/.ssh"; ak="$ssh_dir/authorized_keys"
  if [ "${#KEY_LINES[@]}" -gt 0 ]; then
    # read and write as the account itself: a symlinked .ssh can never make root write elsewhere
    have=$(runuser -u "$USER_NAME" -- /bin/sh -c '[ ! -f "$1" ] || cat "$1"' sh "$ak") || { fail user "cannot read $USER_NAME's authorized_keys"; return 1; }
    for line in "${KEY_LINES[@]}"; do
      blob=$(key_blob "$line")
      printf '%s\n' "$have" | awk -v b="$blob" '{for (i = 1; i <= NF; i++) if ($i == b) f = 1} END {exit !f}' || missing+="$line"$'\n'
    done
    if [ -n "$missing" ]; then
      printf '%s' "$missing" | runuser -u "$USER_NAME" -- /bin/sh -c \
        'umask 077; mkdir -p "$1" && { [ ! -s "$2" ] || [ -z "$(tail -c 1 "$2")" ] || printf "\n" >>"$2"; } && cat >>"$2"' sh "$ssh_dir" "$ak" \
        || { fail user "cannot add the key(s) to $USER_NAME's authorized_keys"; return 1; }
      changed user "$(printf '%s' "$missing" | grep -c .) key(s) added to $USER_NAME's authorized_keys"
    else
      ok user "$USER_NAME's authorized_keys has the key(s)"
    fi
  fi
  if getent group docker >/dev/null 2>&1; then
    members=$(getent group docker | cut -d: -f4)
    case ",$members," in
      *",$USER_NAME,"*) ok user "$USER_NAME is in the group docker" ;;
      *) usermod -aG docker "$USER_NAME" || { fail user "usermod -aG docker $USER_NAME failed"; return 1; }
         changed user "$USER_NAME added to the group docker (members of this group can act as root through Docker)" ;;
    esac
  else
    emit WARN user "the group docker does not exist yet: run block docker, then block user again"
  fi
}

# ------------------------------------------------------------------------------------------------ block: firewall
guard_helper_text() {
  cat <<EOF
#!/bin/sh
# Prisma Memory Docker guard, installed by deploy/host/prepare-host.sh (a rerun rewrites this file).
# Docker's published ports bypass ufw. The chain PRISMA-DOCKER-GUARD, jumped to first from DOCKER-USER, drops every
# NEW connection that enters from anything but loopback or a Docker bridge, except the pairs the last run of the script
# admitted (IPv4 only). DOCKER-USER itself is never flushed; any failing command makes the unit fail.
set -eu
RULES4='$GUARD_RULES4'
RULES6='$GUARD_RULES6'
for fam in iptables ip6tables; do
  if [ "\$fam" = ip6tables ] && [ ! -e /proc/net/if_inet6 ]; then
    echo "prisma-docker-guard: IPv6 is not available, ip6tables skipped"
    continue
  fi
  "\$fam" -w 5 -n -L DOCKER-USER >/dev/null 2>&1 || "\$fam" -w 5 -N DOCKER-USER
  if [ "\$fam" = iptables ]; then RULES=\$RULES4; else RULES=\$RULES6; fi
  printf '%s\n' "\$RULES" | "\$fam-restore" -w 5 --noflush
  rules=\$("\$fam" -w 5 -S DOCKER-USER)
  first=\$(printf '%s\n' "\$rules" | sed -n '2p')
  if [ "\$first" != "-A DOCKER-USER -j PRISMA-DOCKER-GUARD" ]; then
    while "\$fam" -w 5 -D DOCKER-USER -j PRISMA-DOCKER-GUARD 2>/dev/null; do :; done
    "\$fam" -w 5 -I DOCKER-USER 1 -j PRISMA-DOCKER-GUARD
  fi
done
EOF
}
GUARD_UNIT_TEXT="[Unit]
Description=Prisma Memory: keep new inbound connections away from Docker containers
Before=docker.service
After=ufw.service nftables.service netfilter-persistent.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$GUARD_HELPER

[Install]
WantedBy=multi-user.target docker.service"
# the guard chain as `iptables -S` prints it
guard_expected() {
  local text=$GUARD_RULES4
  if [ "$1" = ip6tables ]; then text=$GUARD_RULES6; fi
  printf '%s\n' "$text" | sed -n 's/^:\([A-Z-]*\) - \[0:0\]$/-N \1/p; /^-A /p'
}
guard_normalise() {
  sed -E 's/ +/ /g; :address; s/(^| )([0-9]{1,3}(\.[0-9]{1,3}){3})\/32( |$)/\1\2\4/g; t address'
}
guard_families() { if [ -e "$R/proc/net/if_inet6" ]; then echo iptables ip6tables; else echo iptables; fi; }
# guard_state FAMILY → ok | rules | jump ; prints nothing else
guard_state() {
  local fam=$1 got du
  got=$("$fam" -w 5 -S PRISMA-DOCKER-GUARD 2>/dev/null | guard_normalise) || { echo rules; return 0; }
  [ "$got" = "$(guard_expected "$fam" | guard_normalise)" ] || { echo rules; return 0; }
  du=$("$fam" -w 5 -S DOCKER-USER 2>/dev/null) || { echo jump; return 0; }
  [ "$(printf '%s\n' "$du" | sed -n '2p')" = "-A DOCKER-USER -j PRISMA-DOCKER-GUARD" ] || { echo jump; return 0; }
  echo ok
}
guard_foreign() { "$1" -w 5 -S DOCKER-USER 2>/dev/null | awk 'NR > 2 && $0 != "-A DOCKER-USER -j PRISMA-DOCKER-GUARD" {print}' | sed '${/^-A DOCKER-USER -j RETURN$/d}'; }
# ufw_port_report PORT ssh|web — report the rule of PORT/tcp (--check) or, when no rule names the port, add an allow.
# Never rewrites a rule of the administrator. Returns 1 when a rule closes an SSH port while ufw is off (the switch to
# deny incoming would cut the login), 2 when `ufw allow` failed.
ufw_port_report() {
  local p=$1 kind=$2 r st rule
  r=$(ufw_port_rule "$p" || true); st=${r%%$'\t'*}; rule=${r#*$'\t'}
  case "$st" in
    allow) ok firewall "ufw allows $p/tcp" ;;
    limit) ok firewall "ufw allows $p/tcp with a rate limit (your rule \"$rule\", kept)" ;;
    narrow)
      if [ "$kind" = ssh ]; then
        ok firewall "ufw allows SSH port $p/tcp only as your rule \"$rule\" says (kept; the key login check shows whether you can still log in)"
      elif [ "$CHECK" = 1 ]; then
        todo firewall "ufw: your rule \"$rule\" narrows $p/tcp; the reverse proxy needs it open from anywhere"
      else
        emit WARN firewall "ufw: your rule \"$rule\" narrows $p/tcp: kept as it is, no broader rule added; the reverse proxy needs $p/tcp open from anywhere"
      fi ;;
    block)
      if [ "$CHECK" = 1 ]; then todo firewall "ufw: your rule \"$rule\" closes $p/tcp"
      elif [ "$kind" = web ]; then
        emit WARN firewall "ufw: your rule \"$rule\" closes $p/tcp: kept as it is; the reverse proxy needs $p/tcp open, change that rule yourself"
      elif ufw_active; then
        emit WARN firewall "ufw: your rule \"$rule\" closes SSH port $p/tcp: kept as it is"
      else
        emit FAIL firewall "ufw: your rule \"$rule\" closes SSH port $p/tcp: kept as it is, and ufw is not switched to deny incoming (that would cut the login); change the rule yourself, then run again"
        return 1
      fi ;;
    *)
      if [ "$CHECK" = 1 ]; then todo firewall "ufw does not allow $p/tcp"; return 0; fi
      ufw allow "$p/tcp" comment "$COMMENT" >/dev/null || { emit FAIL firewall "ufw allow $p/tcp failed"; return 2; }
      changed firewall "ufw allows $p/tcp" ;;
  esac
}
ssh_ports() {
  local p
  # every port sshd listens on, plus the server port of this very connection; 22 when neither is known
  p=$({ sshd_t | awk '$1 == "port" {print $2}'; [ -z "${SSH_CONNECTION:-}" ] || printf '%s\n' "$SSH_CONNECTION" | awk '{print $4}'; } | grep -E '^[0-9]{1,5}$' | sort -un || true)
  [ -n "$p" ] || p=22
  printf '%s\n' "$p"
}
blk_firewall() {
  local p fam st dflt foreign helper info rc ssh_blocked rule pair sources
  helper=$(guard_helper_text)
  if [ "$CHECK" = 1 ]; then
    if ! ufw_present; then todo firewall "ufw is not installed"
    elif [ "$IS_ROOT" = 0 ]; then unknown firewall "ufw state"
    else
      if ufw_active; then ok firewall "ufw is active"; else todo firewall "ufw is not active"; fi
      dflt=$(ufw_default_in)
      if [ "$dflt" = deny ]; then ok firewall "ufw denies incoming by default"; else todo firewall "ufw incoming default is $dflt, not deny"; fi
      for p in $(ssh_ports); do ufw_port_report "$p" ssh; done
    fi
    if same_file 0755 "$R$GUARD_HELPER" "$helper" && same_file 0644 "$R/etc/systemd/system/$GUARD_UNIT" "$GUARD_UNIT_TEXT"; then
      ok firewall "Docker guard helper and unit are installed"
    else todo firewall "Docker guard helper or unit is missing or differs"; fi
    if [ "$(unit_enabled_state "$GUARD_UNIT")" = enabled ]; then ok firewall "$GUARD_UNIT is enabled"; else todo firewall "$GUARD_UNIT is not enabled"; fi
    if [ "$IS_ROOT" = 0 ]; then unknown firewall "Docker guard rules in iptables and ip6tables"
    else
      for fam in $(guard_families); do
        case "$(guard_state "$fam")" in
          ok) ok firewall "$fam: guard rules loaded, jump first in DOCKER-USER" ;;
          rules) todo firewall "$fam: guard rules are not loaded as written" ;;
          jump) todo firewall "$fam: the jump to the guard is not the first rule of DOCKER-USER" ;;
        esac
      done
      if unit_active docker; then
        if [ "$(iptables -w 5 -S FORWARD 2>/dev/null | awk '/^-A FORWARD/ {print; exit}')" = "-A FORWARD -j DOCKER-USER" ]; then
          ok firewall "FORWARD jumps to DOCKER-USER first"
        else emit FAIL firewall "the first FORWARD rule is not the jump to DOCKER-USER: the guard is bypassed"; fi
        # published ports of running containers: each one the guard drops is a TODO (the pairs of --admit are admitted)
        local published entry host proto addr port
        if published=$(docker ps --format '{{.Ports}}' 2>/dev/null); then
          while IFS= read -r entry; do
            host=${entry%%->*}; proto=${entry##*/}
            if [[ $host == 127.* || $host =~ ^\[::1\]:[0-9]+$ ]]; then continue; fi
            addr=${host%:*}; port=${host##*:}
            if [[ $proto == tcp && $port =~ ^[0-9]+$ ]] && is_ipv4 "$addr"; then
              if [[ $addr == 0.0.0.0 ]]; then
                todo firewall "Docker publishes port $port/tcp on every address (0.0.0.0) and the guard drops new connections to it from outside; publish it on one address and admit that pair"
              elif [[ " ${ADMIT_PAIRS[*]} " == *" $host "* ]]; then
                ok firewall "the Docker guard admits $host/tcp that Docker publishes"
              else
                todo firewall "Docker publishes $host/tcp and the guard drops new connections to it from outside; to let them in, run block firewall with --admit $host"
              fi
            else
              todo firewall "Docker publishes $entry and the guard drops new connections to it from outside"
            fi
          done < <(printf '%s\n' "${published//, /$'\n'}" | awk 'index($0, "->") && !seen[$0]++')
        else
          todo firewall "cannot list the ports Docker publishes (docker ps failed)"
        fi
      fi
    fi
    return 0
  fi
  # (1) ufw: allows now, the switch to deny-by-default later (access phase, proven by a key login)
  if ! ufw_present; then
    apt_get -y install ufw || { fail firewall "installing ufw failed"; return 1; }
    changed firewall "ufw installed"
  fi
  ssh_blocked=0
  for p in $(ssh_ports); do
    rc=0; ufw_port_report "$p" ssh || rc=$?
    case "$rc" in 0) ;; 1) ssh_blocked=1 ;; *) return 1 ;; esac
  done
  dflt=$(ufw_default_in)
  if ufw_active && [ "$dflt" = deny ]; then
    ok firewall "ufw is active and denies incoming by default"
  elif [ "$ssh_blocked" = 1 ]; then
    : # reported above: ufw stays as it is, the guard below is still installed
  else
    ufw_active && UFW_WAS_ACTIVE=1
    UFW_PREV_IN=$dflt; QUEUE_UFW=1
    emit OK firewall "ufw: deny incoming by default and enable — waits for the key login check at the end"
  fi
  # (2) the Docker guard: own chain, own unit, before docker.service
  if [ -f "$R$GUARD_HELPER" ]; then
    while IFS= read -r rule || [ -n "$rule" ]; do
      if [[ $rule == '-A PRISMA-DOCKER-GUARD '* && $rule == *' --ctorigdstport '* &&
            $'\n'"$GUARD_RULES4"$'\n' != *$'\n'"$rule"$'\n'* ]]; then
        emit WARN firewall "the Docker guard no longer admits what this earlier rule let in: $rule (name it again with --admit to keep it)"
      fi
    done <"$R$GUARD_HELPER"
  fi
  put_file 0755 "$R$GUARD_HELPER" "$helper" || { fail firewall "cannot write $GUARD_HELPER"; return 1; }
  local helper_put=$PUT
  put_file 0644 "$R/etc/systemd/system/$GUARD_UNIT" "$GUARD_UNIT_TEXT" || { fail firewall "cannot write the guard unit"; return 1; }
  local unit_put=$PUT
  if [ "$unit_put" = changed ]; then systemctl daemon-reload || { fail firewall "systemctl daemon-reload failed"; return 1; }; fi
  if [ "$(unit_enabled_state "$GUARD_UNIT")" != enabled ]; then
    systemctl enable "$GUARD_UNIT" >/dev/null 2>&1 || { fail firewall "cannot enable $GUARD_UNIT"; return 1; }
    changed firewall "$GUARD_UNIT enabled (runs before docker.service, again with every Docker restart)"
  fi
  st=ok
  for fam in $(guard_families); do [ "$(guard_state "$fam")" = ok ] || st=reload; done
  if [ "$helper_put" = changed ] || [ "$unit_put" = changed ] || [ "$st" != ok ] || ! unit_active "$GUARD_UNIT"; then
    systemctl restart "$GUARD_UNIT" >/dev/null 2>&1 || { fail firewall "$GUARD_UNIT failed: the guard rules are not loaded (see journalctl -u $GUARD_UNIT)"; return 1; }
    changed firewall "Docker guard rules loaded (iptables and ip6tables)"
  fi
  # (3) verify
  for fam in $(guard_families); do
    case "$(guard_state "$fam")" in
      ok) ok firewall "$fam: guard rules loaded, jump first in DOCKER-USER" ;;
      *) fail firewall "$fam: the guard rules are not in place after loading them"; return 1 ;;
    esac
    foreign=$(guard_foreign "$fam")
    [ -z "$foreign" ] || emit WARN firewall "$fam: DOCKER-USER has other rules after the guard, kept: $(printf '%s' "$foreign" | paste -sd ';' -)"
  done
  if [ "$IS_ROOT" = 1 ] && unit_active docker; then
    if [ "$(iptables -w 5 -S FORWARD 2>/dev/null | awk '/^-A FORWARD/ {print; exit}')" = "-A FORWARD -j DOCKER-USER" ]; then
      ok firewall "FORWARD jumps to DOCKER-USER first"
    else
      fail firewall "the first FORWARD rule is not the jump to DOCKER-USER: the guard would be bypassed"; return 1
    fi
    info=$(docker info 2>/dev/null || true)
    if printf '%s\n' "$info" | awk 'tolower($0) ~ /^ *firewall backend: *nftables/ {f = 1} END {exit !f}'; then
      fail firewall "Docker uses the nftables firewall backend: DOCKER-USER is not consulted; use the iptables backend"; return 1
    fi
  fi
  if [ "${#ADMIT_PAIRS[@]}" -eq 0 ]; then
    ok firewall "the Docker guard admits no new connection from outside to any container (no --admit given)"
  else
    sources=anywhere
    if [ "${#ADMIT_NETS[@]}" -gt 0 ]; then
      printf -v sources '%s, ' "${ADMIT_NETS[@]}"
      sources=${sources%, }
    fi
    for pair in "${ADMIT_PAIRS[@]}"; do
      ok firewall "the Docker guard admits new connections from outside to $pair/tcp from $sources"
    done
  fi
}

# ------------------------------------------------------------------------------------------------ block: swap
blk_swap() {
  local mem sw fs avail
  mem=$(mem_mb); sw=$(swap_mb)
  if [ "${mem:-0}" -ge 7500 ] || [ "${sw:-0}" -ge 3900 ]; then
    ok swap "memory ${mem} MB, swap ${sw} MB: no swap file needed"; return 0
  fi
  if swapfile_active; then emit WARN swap "/swapfile is active but only ${sw} MB; make it 4096 MB by hand"; return 0; fi
  if [ "$CHECK" = 1 ]; then todo swap "memory ${mem} MB and swap ${sw} MB: a 4096 MB /swapfile is needed for builds"; return 0; fi
  if [ -e "$R/swapfile" ] || [ -L "$R/swapfile" ]; then fail swap "/swapfile exists and is not active swap: it is left alone; remove or activate it by hand"; return 1; fi
  fs=$(stat -f -c %T "$R/" 2>/dev/null || echo unknown)
  case "$fs" in btrfs|zfs) fail swap "the root file system is $fs: create swap by hand (a plain swap file does not work there)"; return 1 ;; esac
  avail=$(df -Pk "$R/" | awk 'NR == 2 {print $4}')
  [ "${avail:-0}" -ge $((6 * 1024 * 1024)) ] || { fail swap "less than 6 GB free on /: no swap file created"; return 1; }
  if ! { ( umask 077; : >"$R/swapfile" ) && chmod 0600 "$R/swapfile"; }; then fail swap "cannot create /swapfile"; return 1; fi
  if ! fallocate -l 4096M "$R/swapfile" 2>/dev/null; then
    dd if=/dev/zero of="$R/swapfile" bs=1M count=4096 status=none || { rm -f "$R/swapfile"; fail swap "cannot fill /swapfile"; return 1; }
  fi
  mkswap "$R/swapfile" >/dev/null || { rm -f "$R/swapfile"; fail swap "mkswap /swapfile failed"; return 1; }
  swapon "$R/swapfile" || { fail swap "swapon /swapfile failed"; return 1; }
  if ! awk '$1 == "/swapfile" {f = 1} END {exit !f}' "$R/etc/fstab" 2>/dev/null; then
    printf '/swapfile none swap sw,nofail 0 0\n' >>"$R/etc/fstab" || { fail swap "cannot add /swapfile to /etc/fstab"; return 1; }
  fi
  changed swap "4096 MB /swapfile created and switched on (also after a reboot)"
}

# ------------------------------------------------------------------------------------------------ block: time
blk_time() {
  if unit_active systemd-timesyncd || unit_active chrony || unit_active chronyd; then ok time "clock synchronisation is running"; return 0; fi
  if [ "$CHECK" = 1 ]; then todo time "no clock synchronisation service is running"; return 0; fi
  if ! pkg_installed systemd-timesyncd && ! pkg_installed chrony; then
    apt_get -y install systemd-timesyncd || { fail time "installing systemd-timesyncd failed"; return 1; }
  fi
  timedatectl set-ntp true || { fail time "timedatectl set-ntp true failed"; return 1; }
  changed time "clock synchronisation switched on (the time zone is not changed)"
}

# ------------------------------------------------------------------------------------------------ block: journald
JOURNALD_CONF='# Prisma Memory prepare-host.sh: keep the system journal within 1 GB.
[Journal]
SystemMaxUse=1G'
blk_journald() {
  local f="$R/etc/systemd/journald.conf.d/60-prisma-memory.conf"
  if [ "$CHECK" = 1 ]; then
    if same_file 0644 "$f" "$JOURNALD_CONF"; then ok journald "journal limited to 1 GB"; else todo journald "journal size is not limited"; fi
    return 0
  fi
  put_file 0644 "$f" "$JOURNALD_CONF" || { fail journald "cannot write ${f#"$R"}"; return 1; }
  if [ "$PUT" = changed ]; then
    systemctl restart systemd-journald || { fail journald "systemd-journald did not restart"; return 1; }
    changed journald "journal limited to 1 GB (${f#"$R"})"
  else ok journald "journal limited to 1 GB"; fi
}

# ------------------------------------------------------------------------------------------------ block: oom
OOM_CONF='# Prisma Memory prepare-host.sh: under memory pressure the kernel kills build steps before this service.
[Service]
OOMScoreAdjust=-500'
blk_oom() {
  local svc f any=0
  for svc in ssh fail2ban; do
    f="$R/etc/systemd/system/$svc.service.d/60-prisma-memory.conf"
    if [ "$CHECK" = 1 ]; then
      if same_file 0644 "$f" "$OOM_CONF"; then ok oom "$svc is protected from the OOM killer"; else todo oom "$svc is not protected from the OOM killer"; fi
      continue
    fi
    put_file 0644 "$f" "$OOM_CONF" || { fail oom "cannot write ${f#"$R"}"; return 1; }
    if [ "$PUT" = changed ]; then any=1; changed oom "$svc protected from the OOM killer (applies at its next restart)"; else ok oom "$svc is protected from the OOM killer"; fi
  done
  if [ "$any" = 1 ]; then systemctl daemon-reload || { fail oom "systemctl daemon-reload failed"; return 1; }; fi
}

# ------------------------------------------------------------------------------------------------ block: fail2ban
JAIL_CONF='# Prisma Memory prepare-host.sh: ban addresses that keep failing SSH logins (read from the systemd journal).
[sshd]
enabled = true
backend = systemd'
blk_fail2ban() {
  local f="$R/etc/fail2ban/jail.d/prisma-memory.local" p
  if [ "$CHECK" = 1 ]; then
    if pkg_installed fail2ban; then ok fail2ban "fail2ban is installed"; else todo fail2ban "fail2ban is not installed"; fi
    if same_file 0644 "$f" "$JAIL_CONF"; then ok fail2ban "SSH jail is configured"; else todo fail2ban "SSH jail is not configured"; fi
    if unit_active fail2ban; then ok fail2ban "fail2ban is running"; else todo fail2ban "fail2ban is not running"; fi
    return 0
  fi
  for p in fail2ban python3-systemd; do
    if ! pkg_installed "$p"; then
      apt_get -y install "$p" || { fail fail2ban "installing $p failed"; return 1; }
      changed fail2ban "$p installed"
    fi
  done
  put_file 0644 "$f" "$JAIL_CONF" || { fail fail2ban "cannot write ${f#"$R"}"; return 1; }
  [ "$PUT" = same ] || changed fail2ban "SSH jail configured (${f#"$R"})"
  if [ "$(unit_enabled_state fail2ban)" != enabled ] || ! unit_active fail2ban; then
    systemctl enable --now fail2ban >/dev/null 2>&1 || { fail fail2ban "cannot start fail2ban"; return 1; }
    changed fail2ban "fail2ban enabled and started"
  elif [ "$PUT" = changed ]; then
    systemctl restart fail2ban || { fail fail2ban "fail2ban did not restart"; return 1; }
  else ok fail2ban "fail2ban is running with the SSH jail"; fi
}

# ------------------------------------------------------------------------------------------------ block: ssh
SSH_CONF='# Prisma Memory prepare-host.sh: key login only. The number is below 50 so it wins over cloud-init'\''s file.
PasswordAuthentication no
KbdInteractiveAuthentication no'
ssh_target_met() { [ "$(sshd_val "$1" passwordauthentication)" = no ] && [ "$(sshd_val "$1" kbdinteractiveauthentication)" = no ]; }
blk_ssh() {
  local t
  if ! pkg_installed openssh-server; then emit SKIP ssh "OpenSSH server is not installed"; return 0; fi
  if [ "$IS_ROOT" = 0 ]; then unknown ssh "effective sshd settings"; return 0; fi
  t=$(sshd_t) || { fail ssh "sshd -T failed: the SSH configuration has an error"; return 1; }
  if ssh_target_met "$t"; then ok ssh "password and keyboard-interactive login are off"; return 0; fi
  if [ "$CHECK" = 1 ]; then todo ssh "password login is still possible"; return 0; fi
  if same_file 0644 "$R$SSH_DROPIN" "$SSH_CONF"; then
    fail ssh "$SSH_DROPIN is in place but another setting wins (an earlier file in sshd_config.d or sshd_config); fix that file"; return 1
  fi
  QUEUE_SSH=1
  ok ssh "password login: switched off at the end, after a key login in a second connection"
}

# ------------------------------------------------------------------------------------------------ access phase
# The only part that can cut a login. The ufw switch and the sshd change are applied with a rollback armed by a
# systemd timer (300 s); they stay only when a NEW key login of a known account is seen in the journal after them.
PROOF_USERS=()
has_keys() {
  local name=$1 home ak
  home="$R$(home_of "$name")"; ak="$home/.ssh/authorized_keys"
  [ "$home" != "$R" ] || return 1
  if [ "$name" = root ]; then
    [ -f "$ak" ] && grep -qvE '^[[:space:]]*(#|$)' "$ak"
  else
    runuser -u "$name" -- /bin/sh -c '[ -f "$1" ] && grep -qvE "^[[:space:]]*(#|\$)" "$1"' sh "$ak" 2>/dev/null
  fi
}
proof_candidates() {
  local inv=""
  [ -z "$USER_NAME" ] || echo "$USER_NAME"
  inv=${SUDO_USER:-}
  [ -n "$inv" ] || inv=$(logname 2>/dev/null || true)
  [ -n "$inv" ] || inv=root
  echo "$inv"
}
write_rollback() {
  local f="$R$STATE_DIR/rollback.sh" body
  body="#!/bin/sh
# Written by prepare-host.sh: undo this run's SSH and firewall switch. Runs from the timer $ROLLBACK_UNIT or from
# the script itself; removes itself at the end.
PATH=$(sq "$PATH")
export PATH
set -u"
  if [ "$QUEUE_SSH" = 1 ]; then
    if [ -f "$R$SSH_DROPIN" ]; then
      cp -p "$R$SSH_DROPIN" "$R$STATE_DIR/sshd-dropin.bak" || return 1
      body+="
cp -p $(sq "$R$STATE_DIR/sshd-dropin.bak") $(sq "$R$SSH_DROPIN")"
    else
      body+="
rm -f $(sq "$R$SSH_DROPIN")"
    fi
    body+="
systemctl reload ssh || systemctl try-restart ssh || true"
  fi
  if [ "$QUEUE_UFW" = 1 ]; then
    if [ "$UFW_WAS_ACTIVE" = 0 ]; then body+="
ufw --force disable || true"; fi
    case "$UFW_PREV_IN" in allow|reject) body+="
ufw default $UFW_PREV_IN incoming || true" ;; esac
  fi
  body+="
rm -f $(sq "$R$STATE_DIR/sshd-dropin.bak") $(sq "$R$STATE_DIR/rollback.sh")
echo 'prepare-host: SSH and firewall changes of the interrupted run were rolled back'"
  put_file 0700 "$f" "$body"
}
ROLLBACK_ARMED=0
do_rollback() {
  systemctl stop "$ROLLBACK_UNIT.timer" >/dev/null 2>&1 || true
  /bin/sh "$R$STATE_DIR/rollback.sh" >/dev/null 2>&1 || emit FAIL access "the rollback helper $STATE_DIR/rollback.sh failed: check sshd and ufw by hand"
  ROLLBACK_ARMED=0
}
on_signal() {
  trap - HUP INT TERM
  if [ "$ROLLBACK_ARMED" = 1 ]; then do_rollback; emit FAIL access "interrupted while waiting: SSH and firewall changes rolled back"; fi
  printf 'SUMMARY\treboot-required\t%s\n' "$(reboot_required)"
  printf 'SUMMARY\tlogin-proof\tmissing\n'
  exit 75
}
reboot_required() { if [ -e "$R/var/run/reboot-required" ]; then echo yes; else echo no; fi; }
login_seen() {
  # journal lines of sshd itself (root, by command name), never what a local user can write with logger
  journalctl -q -o cat --since "@$1" _UID=0 _COMM=sshd + _UID=0 _COMM=sshd-session 2>/dev/null \
    | awk -v names="${PROOF_USERS[*]}" 'BEGIN {n = split(names, a, " "); for (i = 1; i <= n; i++) ok[a[i]] = 1}
        $1 == "Accepted" && $2 == "publickey" && $3 == "for" && ($4 in ok) && $5 == "from" {f = 1} END {exit !f}'
}
access_phase() {
  local name t t0 armed deadline hard host
  [ "$QUEUE_UFW" = 1 ] || [ "$QUEUE_SSH" = 1 ] || return 0
  declare -A seen=()
  while read -r name; do
    [ -n "$name" ] && [ -z "${seen[$name]:-}" ] || continue
    seen[$name]=1
    [[ $name =~ $PROOF_NAME_RE ]] || continue
    getent passwd "$name" >/dev/null 2>&1 && has_keys "$name" && PROOF_USERS+=("$name")
  done < <(proof_candidates)
  if [ "${#PROOF_USERS[@]}" -eq 0 ]; then
    emit FAIL access "no account that could prove a key login has an authorized key: the ufw switch and the SSH password change were NOT applied (pass --user NAME --pubkey-file FILE)"
    LOGIN_PROOF=missing; return 0
  fi
  [ -d "$R$STATE_DIR" ] || install -d -m 0700 "$R$STATE_DIR" || { fail access "cannot create $STATE_DIR"; return 0; }
  write_rollback || { fail access "cannot write the rollback helper"; return 0; }
  trap on_signal HUP INT TERM
  systemd-run --quiet --unit "$ROLLBACK_UNIT" --on-active="$ROLLBACK_AFTER" /bin/sh "$R$STATE_DIR/rollback.sh" >/dev/null 2>&1 \
    || { rm -f "$R$STATE_DIR/rollback.sh" "$R$STATE_DIR/sshd-dropin.bak"; trap - HUP INT TERM; fail access "cannot arm the rollback timer: nothing applied"; return 0; }
  ROLLBACK_ARMED=1
  armed=$(date +%s)
  if [ "$QUEUE_UFW" = 1 ]; then
    if ! { ufw default deny incoming >/dev/null && ufw --force enable >/dev/null; }; then
      do_rollback; trap - HUP INT TERM; fail access "enabling ufw failed: rolled back"; return 0
    fi
    changed firewall "ufw enabled, incoming denied by default (pending the key login check)"
  fi
  if [ "$QUEUE_SSH" = 1 ]; then
    if ! put_file 0644 "$R$SSH_DROPIN" "$SSH_CONF"; then do_rollback; trap - HUP INT TERM; fail access "cannot write $SSH_DROPIN: rolled back"; return 0; fi
    if ! sshd -t >/dev/null 2>&1; then do_rollback; trap - HUP INT TERM; fail ssh "sshd -t rejects the configuration: rolled back"; return 0; fi
    systemctl reload ssh >/dev/null 2>&1 || systemctl try-restart ssh >/dev/null 2>&1 || true
    t=$(sshd_t || true)
    if ! ssh_target_met "$t" || [ "$(sshd_val "$t" pubkeyauthentication)" != yes ]; then
      do_rollback; trap - HUP INT TERM; fail ssh "after the change sshd -T does not show key-only login (another setting wins): rolled back"; return 0
    fi
    changed ssh "password and keyboard-interactive login off ($SSH_DROPIN; pending the key login check)"
  fi
  t0=$(date +%s)
  host=$(printf '%s\n' "${SSH_CONNECTION:-}" | awk 'NF >= 3 {print $3}')
  [ -n "$host" ] || host="<this server>"
  echo "ACTION: open a second connection now and log in with your key, within ${LOGIN_WAIT} s:" >&2
  for name in "${PROOF_USERS[@]}"; do echo "  ssh $name@$host" >&2; done
  echo "        without it the firewall and SSH changes are rolled back (Ctrl-C rolls back at once)" >&2
  # the wait is measured by the clock, not by counting sleeps (a slow journal query takes time too), and it always ends
  # ROLLBACK_MARGIN seconds before the timer fires
  deadline=$((t0 + LOGIN_WAIT)); hard=$((armed + ROLLBACK_AFTER - ROLLBACK_MARGIN))
  [ "$deadline" -le "$hard" ] || deadline=$hard
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if login_seen "$t0"; then
      # keep the changes only when the rollback has not started: its service is not running, the timer is stopped, and
      # the helper (which removes itself when it has run) is still there afterwards. An elapsed timer stays "active",
      # so the timer's own state proves nothing.
      if ! unit_active "$ROLLBACK_UNIT.service" && systemctl stop "$ROLLBACK_UNIT.timer" >/dev/null 2>&1 \
         && [ -f "$R$STATE_DIR/rollback.sh" ]; then
        rm -f "$R$STATE_DIR/sshd-dropin.bak" "$R$STATE_DIR/rollback.sh"
        ROLLBACK_ARMED=0; trap - HUP INT TERM
        ok access "key login seen in a new connection: changes kept, rollback disarmed"
        LOGIN_PROOF=confirmed; return 0
      fi
      # the timer's own run is under way or done; finish it here only when its helper is left and nothing runs it
      if [ -f "$R$STATE_DIR/rollback.sh" ] && ! unit_active "$ROLLBACK_UNIT.service"; then do_rollback; fi
      ROLLBACK_ARMED=0; trap - HUP INT TERM
      emit FAIL access "a key login was seen, but the rollback timer had already fired: the ufw switch and the SSH password change are rolled back; run the script again"
      LOGIN_PROOF=missing; return 0
    fi
    sleep 3
  done
  do_rollback; trap - HUP INT TERM
  emit FAIL access "no new key login within ${LOGIN_WAIT} s: the ufw switch and the SSH password change were rolled back; the other blocks stay"
  LOGIN_PROOF=missing
}

# ------------------------------------------------------------------------------------------------ run
[ "$CHECK" = 0 ] || [ "$IS_ROOT" = 1 ] || echo "prepare-host: not root — items that need root are reported as UNKNOWN" >&2
for b in "${BLOCKS[@]}"; do
  sel "$b" || continue
  "blk_$b" || true
done
if [ "$CHECK" = 1 ]; then
  if sel updates; then
    if [ "$(reboot_required)" = yes ]; then todo updates "a reboot is pending (/var/run/reboot-required)"; else ok updates "no reboot pending"; fi
  fi
  [ "$CHECK_BAD" = 0 ] && exit 0 || exit 1
fi
access_phase || true
printf 'SUMMARY\treboot-required\t%s\n' "$(reboot_required)"
printf 'SUMMARY\tlogin-proof\t%s\n' "$LOGIN_PROOF"
[ "$LOGIN_PROOF" != missing ] || exit 75
[ "$FAILED" = 0 ] || exit 1
exit 0
