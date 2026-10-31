#!/usr/bin/env bash
# Fetch fixed source revisions and apply the complete patch set before any build.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
for command in git jq sha256sum curl tar unzip node awk; do need "$command"; done
select_php "${1:-}"

if [[ -f "$BUILD_DIRECTORY/prepared.json" ]]; then
  [[ $(jq -er '.fingerprint' "$BUILD_DIRECTORY/prepared.json") == "$BUILD_FINGERPRINT" ]] \
    || die 'Build workspace fingerprint changed.'
  log "Prepared PHP $PHP_MINOR sources already exist: $UPSTREAM_DIRECTORY"
  printf '%s\n' "$UPSTREAM_DIRECTORY"
  exit 0
fi
[[ ! -d "$UPSTREAM_DIRECTORY" ]] || die "Incomplete source preparation exists at $BUILD_DIRECTORY; remove this build-owned directory and retry."
mkdir -p -- "$BUILD_DIRECTORY" "$INT64_ROOT/.cache/downloads"
log "Preparing PHP $PHP_VERSION with 64-bit integers and 32-bit pointers."
fetch_git "$(jq -er '.upstream.repository' "$INT64_ROOT/versions.json")" "$UPSTREAM_COMMIT" "$UPSTREAM_DIRECTORY"
apply_patch_series "$UPSTREAM_DIRECTORY" "$INT64_ROOT/patches/upstream"

fetch_git 'https://github.com/php/php-src.git' "$PHP_COMMIT" "$PHP_DIRECTORY"
# Verify that provenance describes the selected source, not only its minor ABI.
source_version=$(sed -n 's/^#define PHP_VERSION "\([^"]*\)"$/\1/p' "$PHP_DIRECTORY/main/php_version.h")
[[ $source_version == "$PHP_VERSION" ]] || die "PHP source version mismatch: expected $PHP_VERSION, got $source_version"
# Ported Sean fiber/runtime patches precede our scalar ABI changes. The original
# upstream patch targets older releases and must not be applied to these sources.
apply_patch_file "$PHP_DIRECTORY" "$INT64_ROOT/patches/runtime/$PHP_MINOR.patch"
apply_patch_file "$PHP_DIRECTORY" "$INT64_ROOT/patches/php/$PHP_MINOR.patch"
mkdir -p "$PHP_DIRECTORY/preload/Zend"
touch "$PHP_DIRECTORY/patched"

fetch_git "$(jq -er '.vrzno.repository' "$INT64_ROOT/versions.json")" "$VRZNO_COMMIT" "$VRZNO_DIRECTORY"
apply_patch_series "$VRZNO_DIRECTORY" "$INT64_ROOT/patches/vrzno"

while IFS= read -r entry; do
  directory=$(jq -er '.directory' <<< "$entry")
  [[ $directory =~ ^[A-Za-z0-9_.-]+$ ]] || die "Invalid dependency directory: $directory"
  fetch_git "$(jq -er '.repository' <<< "$entry")" "$(jq -er '.commit' <<< "$entry")" \
    "$UPSTREAM_DIRECTORY/third_party/$directory"
done < <(jq -c '.git[]' "$INT64_ROOT/config/dependencies.json")

while IFS= read -r entry; do
  directory=$(jq -er '.directory' <<< "$entry")
  [[ $directory =~ ^[A-Za-z0-9_./-]+$ && $directory != /* && $directory != *..* ]] \
    || die "Invalid dependency directory: $directory"
  url=$(jq -er '.url' <<< "$entry")
  hash=$(jq -er '.sha256' <<< "$entry")
  format=$(jq -er '.format' <<< "$entry")
  strip=$(jq -er '.stripComponents' <<< "$entry")
  archive="$INT64_ROOT/.cache/downloads/$hash"
  download_verified "$url" "$hash" "$archive"
  destination="$UPSTREAM_DIRECTORY/third_party/$directory"
  mkdir -p -- "$destination"
  if [[ $(jq -r '.kind // ""' <<< "$entry") == icu-data ]]; then
    # ICU keeps separate host tools; duplicate only after installing exact data.
    rm -rf -- "$destination/data"
  fi
  case "$format" in
    tar) tar -xf "$archive" --directory "$destination" --strip-components "$strip" --no-same-owner --no-same-permissions ;;
    zip) [[ $strip == 0 ]] || die 'ZIP inputs do not support stripComponents.'; unzip -q "$archive" -d "$destination" ;;
    *) die "Unsupported archive format: $format" ;;
  esac
done < <(jq -c '.archives[]' "$INT64_ROOT/config/dependencies.json")
mkdir -p "$UPSTREAM_DIRECTORY/third_party/icu-72-1/icu_alt"
cp -a "$UPSTREAM_DIRECTORY/third_party/icu-72-1/icu" "$UPSTREAM_DIRECTORY/third_party/icu-72-1/icu_alt/icu"

bash "$INT64_ROOT/scripts/scope-wrappers.sh" "$PHP_MINOR" "$UPSTREAM_DIRECTORY/source"
cp "$INT64_ROOT/config/profile.mak" "$UPSTREAM_DIRECTORY/.env.int64"
# Use the supported importer to inventory patched Vrzno and preserve it on every
# Make invocation; importing the unmodified upstream commit would overwrite it.
printf '\nPHP_VERSION=%s\nVRZNO_DEV_PATH=%s\n' "$PHP_MINOR" "$VRZNO_DIRECTORY" >> "$UPSTREAM_DIRECTORY/.env.int64"
cp "$INT64_ROOT/versions.json" "$BUILD_DIRECTORY/versions.json"
cp "$INT64_ROOT/config/dependencies.json" "$BUILD_DIRECTORY/dependencies.json"
jq -n --arg fingerprint "$BUILD_FINGERPRINT" --arg php "$PHP_VERSION" \
  '{schemaVersion:1,fingerprint:$fingerprint,phpVersion:$php}' > "$BUILD_DIRECTORY/prepared.json"
log "Source preparation completed: $UPSTREAM_DIRECTORY"
printf '%s\n' "$UPSTREAM_DIRECTORY"
