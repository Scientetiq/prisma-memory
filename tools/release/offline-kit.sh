#!/bin/sh
# offline-kit.sh — make the kit for a closed network: on a machine with access to the image and package
# registries, from a clean clone at one commit.
#
#   tools/release/offline-kit.sh [--demo] [--out DIR]
#
# It builds the images with deploy/compose/compose.yaml and the build arguments deploy/compose/setup uses (the same
# recipes, no second set), pulls the storage image that compose.yaml names by digest, saves every image with
# `docker save`, and writes KIT (format, version, commit, one line per image: reference, file, image id) and, last,
# SHA256SUMS. Copy the kit and this clone at the same commit to the server, then run
#   deploy/compose/setup --offline KIT [the options of the install]
# which checks every sum before it loads anything and never builds or pulls. The kit holds no secret and no file of
# the clone. Exit code: 0 done; 1 failed (no SHA256SUMS was written); 2 wrong call; 3 refused, nothing was written.
set -eu
umask 022
export LC_ALL=C
unset CDPATH

say() { printf 'offline-kit: %s\n' "$*"; }
refuse() { printf 'offline-kit: refused: %s\n' "$*" >&2; exit 3; }
fail() { printf 'offline-kit: failed: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'offline-kit: %s\n' "$1" >&2
  cat >&2 <<'EOF'
usage: tools/release/offline-kit.sh [--demo] [--out DIR]
  --demo       also put the model simulator into the kit (for setup --offline --demo)
  --out DIR    the new kit directory (default ~/prisma-memory-<version>-offline; it must lie outside this clone)
EOF
  exit 2
}
matches() {
  case "$1" in *'
'*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eqx "$2"
}

DEMO=
OUT=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --demo) DEMO=1; shift ;;
    --out)
      [ "$#" -ge 2 ] && [ -n "$2" ] || usage '--out needs a directory'
      OUT="$2"; shift 2 ;;
    *) usage "unknown argument: $1" ;;
  esac
done

self="$0"
while [ -L "$self" ]; do
  link="$(readlink -- "$self")" || exit 1
  case "$link" in /*) self="$link" ;; *) self="$(dirname -- "$self")/$link" ;; esac
done
REPO="$(cd -P -- "$(dirname -- "$self")/../.." && pwd -P)" || exit 1
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
clone_error="this is not a git clone of Prisma Memory (no .git at $REPO): the kit is made from a clone at one commit"
[ -e "$REPO/.git" ] || refuse "$clone_error"
top="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)" &&
  [ -n "$top" ] &&
  top="$(cd -P -- "$top" 2>/dev/null && pwd -P)" &&
  [ "$top" = "$REPO" ] || refuse "$clone_error"

changed="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" status --porcelain --untracked-files=no)" || exit 1
[ -z "$changed" ] || refuse "the clone has local changes: commit or undo them first; the kit is made from one commit, as setup reads it"
untracked_error='the clone has files that git does not track (git status lists them): remove them, or make the kit from a fresh clone; no file from outside the commit may enter the build'
untracked="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" status --porcelain)" || exit 1
[ -z "$untracked" ] || refuse "$untracked_error"
untracked="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" status --porcelain --ignored --untracked-files=normal)" || exit 1
[ -z "$untracked" ] || refuse "$untracked_error"

V="$(git -C "$REPO" describe --tags --always)" || exit 1
C="$(git -C "$REPO" rev-parse HEAD)" || exit 1
matches "$V" '[A-Za-z0-9][A-Za-z0-9_.-]{0,127}' || refuse "the version of this tree ($V) cannot be an image tag"
matches "$C" '[0-9A-Fa-f]{40}' || refuse "the commit of this tree ($C) is not a commit"

if [ -z "$OUT" ]; then
  [ -n "${HOME:-}" ] || refuse 'HOME is not set: pass --out DIR'
  OUT="$HOME/prisma-memory-$V-offline"
fi
parent="$(cd -P -- "$(dirname -- "$OUT")" 2>/dev/null && pwd -P)" ||
  refuse "the parent directory of $OUT does not exist"
OUT="${parent%/}/$(basename -- "$OUT")"
if [ -d "$OUT" ]; then OUT="$(cd -P -- "$OUT" && pwd -P)" || exit 1; fi
case "$OUT/" in
  "$REPO/"*) refuse "the kit directory ($OUT) is this clone or lies inside it ($REPO): choose a directory outside the clone with --out DIR" ;;
esac
if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  out_error="$OUT exists and is not empty: choose a new directory with --out DIR"
  [ -d "$OUT" ] && [ -r "$OUT" ] && [ -x "$OUT" ] || refuse "$out_error"
  for entry in "$OUT"/* "$OUT"/.[!.]* "$OUT"/..?*; do
    [ ! -e "$entry" ] && [ ! -L "$entry" ] || refuse "$out_error"
  done
fi

command -v docker >/dev/null || refuse 'docker is not installed: the kit is built with Docker on a machine with access to the image and package registries'
command -v sha256sum >/dev/null || refuse 'sha256sum is not installed (package coreutils)'
command -v mktemp >/dev/null || refuse 'mktemp is not installed'
COMPOSE="$REPO/deploy/compose/compose.yaml"
storage_error="cannot read the storage image from $COMPOSE"
S3="$(sed -n 's/^    image: \(versity\/versitygw:[^ ]*\)$/\1/p' "$COMPOSE" 2>/dev/null)" || refuse "$storage_error"
matches "$S3" 'versity/versitygw:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}@sha256:[0-9a-f]{64}' || refuse "$storage_error"

unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES
unset MEMORY_INSTANCE_ID MEMORY_HOME MEMORY_UID MEMORY_GID MEMORY_VERSION MEMORY_COMMIT
TMPDIR="$(cd -P -- "${TMPDIR:-/tmp}" && pwd -P)" || exit 1
case "$TMPDIR/" in "$OUT/"*|"$REPO/"*) TMPDIR="$(dirname -- "$OUT")" ;; esac
ENV_TMP="$(mktemp "${TMPDIR:-/tmp}/offline-kit-env.XXXXXX")" || exit 1
trap 'rm -f "$ENV_TMP"' 0
trap 'exit 1' HUP INT TERM
printf '%s\n' MEMORY_INSTANCE_ID=kit MEMORY_HOME=/nonexistent/prisma-memory-kit MEMORY_UID=10001 MEMORY_GID=10001 \
  "MEMORY_VERSION=$V" "MEMORY_COMMIT=$C" >"$ENV_TMP"
set --
if [ -n "$DEMO" ]; then set -- --profile demo; fi
say "build: the images of $V with deploy/compose/compose.yaml, as setup builds them"
docker compose --project-directory "$REPO/deploy/compose" -f "$COMPOSE" --env-file "$ENV_TMP" "$@" \
  build --build-arg "MEMORY_VERSION=$V" --build-arg "MEMORY_COMMIT=$C" ||
  fail 'the image build failed (its output is above); no kit was written'

say "pull: $S3"
docker pull "$S3" || fail "docker pull $S3 failed (its output is above); no kit was written"
# A storage image pulled by tag and digest has no tag of its own, and an archive saved by that reference loads as
# an image without a name where Docker keeps its images in containerd. Saved by its plain tag it loads with the
# tag, and the reference with the digest, the one compose.yaml names and KIT lists, is found again.
S3_TAG="${S3%@*}"
docker tag "$S3" "$S3_TAG" || fail "docker tag $S3 $S3_TAG failed (its output is above); no kit was written"

image_ref() {
  case "$1" in
    images/versitygw.tar) printf '%s\n' "$S3" ;;
    *) image="${1##*/}"; printf 'prisma-memory-%s:%s\n' "${image%.tar}" "$V" ;;
  esac
}
set -- images/db.tar images/app.tar images/web.tar
if [ -n "$DEMO" ]; then set -- "$@" images/demo-models.tar; fi
set -- "$@" images/versitygw.tar
manifest="$(printf '%s\n' 'format prisma-offline-kit/1' "version $V" "commit $C")"
for file do
  ref="$(image_ref "$file")"
  inspect_error="cannot read the image id of $ref; no kit was written"
  id="$(docker image inspect --format '{{.Id}}' "$ref")" && matches "$id" 'sha256:[0-9A-Fa-f]{64}' || fail "$inspect_error"
  manifest="$manifest
image $ref $file $id"
done

[ -d "$OUT" ] || mkdir -- "$OUT"
mkdir -- "$OUT/images"
for file do
  ref="$(image_ref "$file")"
  say "save: $ref"
  src="$ref"; [ "$file" != images/versitygw.tar ] || src="$S3_TAG"
  docker save -o "$OUT/$file" "$src" ||
    fail "docker save of $ref failed (its output is above); the kit at $OUT is incomplete and has no SHA256SUMS"
done

printf '%s\n' "$manifest" >"$OUT/KIT"
(cd -P -- "$OUT" && sha256sum KIT "$@") >"$OUT/.SHA256SUMS.new"
sums_hash="$(sha256sum <"$OUT/.SHA256SUMS.new")"
mv -f "$OUT/.SHA256SUMS.new" "$OUT/SHA256SUMS"

printf '%s\n' "Kit: $OUT" "Version: $V ($C)" \
  "SHA256SUMS sha256: ${sums_hash%% *} — compare it on the closed network with the line setup --offline prints" \
  "Next: copy $OUT and this clone at commit $C to the server, then run deploy/compose/setup --offline <the copied kit> with the options of the install"
