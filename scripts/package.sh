#!/usr/bin/env bash
# Create deterministic tar metadata and a checksum of an already validated build.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
select_php "${1:-}"
[[ -f "$ARTIFACT_DIRECTORY/manifest.json" ]] || die 'Build and validate the artifact before packaging.'
[[ $(jq -er '.fingerprint' "$ARTIFACT_DIRECTORY/manifest.json") == "$BUILD_FINGERPRINT" ]] \
  || die 'Artifact belongs to different build inputs.'
node "$INT64_ROOT/scripts/verify-artifact.mjs" "$ARTIFACT_DIRECTORY"
epoch=$(jq -er '.build.sourceDateEpoch' "$ARTIFACT_DIRECTORY/manifest.json")
mkdir -p "$INT64_ROOT/dist/releases"
filename="php-wasm-int64-$RELEASE_VERSION-php$PHP_MINOR.tar.gz"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  --format=posix --pax-option=delete=atime,delete=ctime \
  --directory "$INT64_ROOT/dist" -cf - "php-$PHP_MINOR" | gzip -n > "$INT64_ROOT/dist/releases/$filename"
(
  cd "$INT64_ROOT/dist/releases"
  sha256sum "$filename" > "$filename.sha256"
)
log "Packaged $INT64_ROOT/dist/releases/$filename"
