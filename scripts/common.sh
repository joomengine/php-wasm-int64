#!/usr/bin/env bash
# Shared build functions. Source this file from an entrypoint with set -Eeuo pipefail.
# These globals form the interface consumed by the sourcing build entrypoints.
# shellcheck disable=SC2034
INT64_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
export LC_ALL=C

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"; }

select_php() {
  PHP_MINOR=${1:-}
  case "$PHP_MINOR" in 8.3|8.4|8.5) ;; *) die 'Select PHP 8.3, 8.4, or 8.5.' ;; esac
  need jq
  PHP_VERSION=$(jq -er --arg minor "$PHP_MINOR" '.php[] | select(.minor == $minor) | .version' "$INT64_ROOT/versions.json")
  PHP_COMMIT=$(jq -er --arg minor "$PHP_MINOR" '.php[] | select(.minor == $minor) | .commit' "$INT64_ROOT/versions.json")
  UPSTREAM_COMMIT=$(jq -er '.upstream.commit' "$INT64_ROOT/versions.json")
  VRZNO_COMMIT=$(jq -er '.vrzno.commit' "$INT64_ROOT/versions.json")
  EMSCRIPTEN_VERSION=$(jq -er '.emscripten.version' "$INT64_ROOT/versions.json")
  RELEASE_VERSION=$(tr -d '\n' < "$INT64_ROOT/VERSION")
  [[ $RELEASE_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die 'VERSION is not a release version.'
  # Input changes select a separate build tree. No untracked user directories are deleted.
  BUILD_FINGERPRINT=$({
    printf '%s\n' "$PHP_MINOR"
    cd "$INT64_ROOT" || return
    find versions.json VERSION config patches scripts -type f ! -name check.sh ! -name 'verify-*' -print0 \
      | sort -z | xargs -0 sha256sum
  } | sha256sum | cut -d ' ' -f 1)
  BUILD_DIRECTORY="$INT64_ROOT/.build/php$PHP_MINOR/${BUILD_FINGERPRINT:0:16}"
  UPSTREAM_DIRECTORY="$BUILD_DIRECTORY/upstream"
  PHP_DIRECTORY="$UPSTREAM_DIRECTORY/third_party/php$PHP_MINOR-src"
  VRZNO_DIRECTORY="$BUILD_DIRECTORY/vrzno"
  ARTIFACT_DIRECTORY="$INT64_ROOT/dist/php-$PHP_MINOR"
}

fetch_git() {
  local repository=$1 commit=$2 destination=$3
  [[ $commit =~ ^[a-f0-9]{40}$ ]] || die "Invalid source commit: $commit"
  if [[ ! -d "$destination/.git" ]]; then
    [[ ! -e "$destination" ]] || die "Refusing non-checkout source directory: $destination"
    mkdir -p -- "$(dirname -- "$destination")"
    git init --quiet "$destination"
    git -C "$destination" remote add origin "$repository"
    git -C "$destination" fetch --quiet --depth 1 origin "$commit"
    git -C "$destination" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
  fi
  [[ $(git -C "$destination" rev-parse HEAD) == "$commit" ]] || die "Source revision mismatch: $destination"
}

apply_patch_file() {
  local directory=$1 patch=$2
  [[ -s $patch ]] || die "Patch is missing or empty: $patch"
  git -C "$directory" apply --check --whitespace=error-all "$patch"
  git -C "$directory" apply --whitespace=error-all "$patch"
}

apply_patch_series() {
  local directory=$1 patch_directory=$2 entry
  [[ -s "$patch_directory/series" ]] || die "Patch series is missing: $patch_directory/series"
  while IFS= read -r entry || [[ -n $entry ]]; do
    [[ -z $entry || $entry == \#* ]] && continue
    [[ $entry =~ ^[A-Za-z0-9_.-]+\.patch$ ]] || die "Invalid patch series entry: $entry"
    apply_patch_file "$directory" "$patch_directory/$entry"
  done < "$patch_directory/series"
}

download_verified() {
  local url=$1 hash=$2 destination=$3
  [[ $hash =~ ^[a-f0-9]{64}$ ]] || die "Missing archive SHA-256 for $url"
  mkdir -p -- "$(dirname -- "$destination")"
  if [[ ! -f $destination ]]; then
    curl --fail --location --retry 5 --retry-all-errors --connect-timeout 30 --max-time 900 \
      --output "$destination.partial" "$url"
    printf '%s  %s\n' "$hash" "$destination.partial" | sha256sum --check --status \
      || die "Archive checksum mismatch: $url"
    mv -- "$destination.partial" "$destination"
  fi
  printf '%s  %s\n' "$hash" "$destination" | sha256sum --check --status \
    || die "Cached archive checksum mismatch: $destination"
}
