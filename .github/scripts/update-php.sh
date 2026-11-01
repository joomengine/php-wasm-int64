#!/usr/bin/env bash
# Resolve stable PHP patch updates without changing distribution release versions.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../../scripts/common.sh"
for command in curl git jq sort awk sed; do need "$command"; done
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/php-int64-update.XXXXXX")
trap 'rm -r -- "$work"' EXIT
pins="$INT64_ROOT/versions.json"
jq -e '[.php[].minor] | sort == ["8.3", "8.4", "8.5"]' "$pins" >/dev/null \
  || die 'The updater supports exactly PHP 8.3, 8.4 and 8.5.'
cp -- "$pins" "$work/versions.json"
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  --output "$work/releases.json" https://www.php.net/releases/active.php
jq -e 'type == "object"' "$work/releases.json" >/dev/null
changed=false
while IFS= read -r minor; do
  current=$(jq -er --arg minor "$minor" '.php[] | select(.minor == $minor) | .version' "$pins")
  previous=$(jq -er --arg minor "$minor" '.php[] | select(.minor == $minor) | .commit' "$pins")
  latest=$(jq -er --arg minor "$minor" '.["8"][$minor].version | select(type == "string")' "$work/releases.json") \
    || die "The official feed has no stable release for PHP $minor."
  pattern="^${minor//./\\.}\\.[0-9]+$"
  [[ $current =~ $pattern && $latest =~ $pattern && $previous =~ ^[a-f0-9]{40}$ ]] \
    || die "Invalid stable PHP $minor version or source pin."
  printf '%s\n' "$current" "$latest" | sort --version-sort --check=quiet \
    || die "The official feed would downgrade PHP $current to $latest."

  tag="refs/tags/php-$latest"
  git ls-remote https://github.com/php/php-src.git "$tag" "$tag^{}" > "$work/refs"
  commit=$(awk -v tag="$tag" '$2 == tag {plain=$1} $2 == tag "^{}" {peeled=$1} END {print peeled ? peeled : plain}' "$work/refs")
  [[ $commit =~ ^[a-f0-9]{40}$ ]] || die "The official PHP $latest source tag is missing."
  if [[ $latest == "$current" ]]; then
    [[ $commit == "$previous" ]] || die "The PHP $latest tag no longer matches its recorded source commit."
    log "PHP $current is current."
    continue
  fi

  directory="$work/php-$minor"
  fetch_git https://github.com/php/php-src.git "$commit" "$directory"
  source_version=$(sed -n 's/^#define PHP_VERSION "\([^"]*\)"$/\1/p' "$directory/main/php_version.h")
  [[ $source_version == "$latest" ]] || die "PHP $latest source identifies itself as $source_version."
  # A PHP update is proposed only if both native patch layers still apply exactly.
  apply_patch_file "$directory" "$INT64_ROOT/patches/runtime/$minor.patch"
  apply_patch_file "$directory" "$INT64_ROOT/patches/php/$minor.patch"
  jq --arg minor "$minor" --arg version "$latest" --arg commit "$commit" \
    '(.php[] | select(.minor == $minor)) |= (.version = $version | .commit = $commit)' \
    "$work/versions.json" > "$work/next.json"
  mv -- "$work/next.json" "$work/versions.json"
  log "PHP $current -> $latest ($commit)."
  changed=true
done < <(jq -r '.php[].minor' "$pins")

# Publish the complete pin set only after every configured PHP line was checked.
if [[ $changed == true ]]; then
  cp -- "$work/versions.json" "$pins"
fi
[[ -z ${GITHUB_OUTPUT:-} ]] || printf 'changed=%s\n' "$changed" >> "$GITHUB_OUTPUT"
log "PHP source pin updates: $changed. Distribution VERSION and tags are unchanged."
