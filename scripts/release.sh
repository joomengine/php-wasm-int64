#!/usr/bin/env bash
# Publish only the verified artifacts from the exact successful default-branch run.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
for command in git jq node gh tar sha256sum cmp; do need "$command"; done
[[ $# == 1 && -d $1 ]] || die 'Usage: release.sh <verified-artifact-directory>'
artifacts=$(cd -- "$1" && pwd -P)
[[ ${VALIDATED_SHA:-} =~ ^[a-f0-9]{40}$ ]] || die 'An exact validated commit is required.'
[[ ${VALIDATION_RUN_ID:-} =~ ^[1-9][0-9]*$ ]] || die 'The successful validation run ID is required.'
[[ ${GITHUB_REPOSITORY:-} =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'The source repository is required.'
[[ -n ${DEFAULT_BRANCH:-} ]] || die 'The default branch is required.'
[[ $(git -C "$INT64_ROOT" rev-parse HEAD) == "$VALIDATED_SHA" ]] || die 'Checkout differs from the validated commit.'
git -C "$INT64_ROOT" merge-base --is-ancestor "$VALIDATED_SHA" "refs/remotes/origin/$DEFAULT_BRANCH" \
  || die 'The validated commit is no longer on the default branch.'
select_php 8.3
version=$RELEASE_VERSION
tag="v$version"
[[ $(jq -er '.version' "$INT64_ROOT/package.json") == "$version" ]] || die 'package.json version differs from VERSION.'
[[ $(jq -er '.version' "$INT64_ROOT/package-lock.json") == "$version" ]] || die 'package-lock.json version differs from VERSION.'
[[ $(jq -er '.packages[""].version' "$INT64_ROOT/package-lock.json") == "$version" ]] || die 'The package lock root version differs from VERSION.'
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/php-int64-release.XXXXXX")
trap 'rm -r -- "$work"' EXIT
assets=()
for minor in 8.3 8.4 8.5; do
  select_php "$minor"
  filename="php-wasm-int64-$version-php$minor.tar.gz"
  for name in "$filename" "$filename.sha256"; do
    [[ -s "$artifacts/$name" && ! -L "$artifacts/$name" ]] || die "Missing release asset: $name"
    assets+=("$artifacts/$name")
  done
  actual_checksum=$(cd "$artifacts" && sha256sum "$filename")
  [[ $(cat "$artifacts/$filename.sha256") == "$actual_checksum" ]] || die "Checksum mismatch: $filename"
  tar --extract --gzip --file "$artifacts/$filename" --directory "$work" --no-same-owner --no-same-permissions
  distribution="$work/php-$minor"
  node "$INT64_ROOT/scripts/verify-artifact.mjs" "$distribution" "$minor"
  jq -e --arg version "$version" --arg fingerprint "$BUILD_FINGERPRINT" \
    --arg php "$PHP_VERSION" --arg commit "$PHP_COMMIT" --arg upstream "$UPSTREAM_COMMIT" \
    --arg vrzno "$VRZNO_COMMIT" --arg compiler "$EMSCRIPTEN_VERSION" '
    .version == $version and .fingerprint == $fingerprint and .build.fingerprint == $fingerprint and
    .php.version == $php and .php.commit == $commit and .upstream.commit == $upstream and
    .vrzno.commit == $vrzno and .emscripten.version == $compiler
  ' "$distribution/manifest.json" >/dev/null || die "Artifact provenance differs from the validated source: PHP $minor"
done
[[ $(find "$artifacts" -mindepth 1 -maxdepth 1 | wc -l) == 6 ]] || die 'Expected exactly six release assets.'
printf '%s\n' "${assets[@]##*/}" | sort > "$work/expected-assets"

# Listing avoids treating authentication/network errors as a missing release.
read_release() {
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
    | jq -c --arg tag "$tag" '[.[][] | select(.tag_name == $tag)] |
        if length == 0 then null elif length == 1 then .[0] else error("Duplicate release tags") end'
}
tag_commit() {
  local object kind depth=0
  object=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/$tag" \
    | jq -c --arg ref "refs/tags/$tag" '.[] | select(.ref == $ref) | .object') \
    || die 'Unable to query the release tag.'
  [[ -n $object ]] || return 0
  while :; do
    kind=$(jq -er '.type' <<< "$object") || die 'Invalid release tag object.'
    if [[ $kind == commit ]]; then jq -er '.sha' <<< "$object"; return; fi
    [[ $kind == tag && $depth -lt 8 ]] || die 'Unsupported release tag target.'
    object=$(gh api "repos/$GITHUB_REPOSITORY/git/tags/$(jq -er '.sha' <<< "$object")" | jq -ec '.object') \
      || die 'Unable to resolve the annotated release tag.'
    depth=$((depth + 1))
  done
}
release=$(read_release)
if [[ $release != null && $(jq -r '.draft' <<< "$release") == false ]]; then
  log "Release $tag is already published; its assets remain unchanged."
  exit 0
fi
existing_commit=$(tag_commit)
[[ -z $existing_commit || $existing_commit == "$VALIDATED_SHA" ]] || die "$tag already points to a different commit."
if [[ $release != null ]]; then
  [[ $(jq -er '.target_commitish' <<< "$release") == "$VALIDATED_SHA" ]] \
    || die 'The existing draft belongs to a different validated commit.'
else
  printf '%s\n' \
    'PHP 8.3, 8.4 and 8.5 with native 64-bit PHP integers and wasm32 memory addressing.' \
    '' \
    "Source commit: $VALIDATED_SHA" \
    "Validation: ${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/$VALIDATION_RUN_ID" \
    '' \
    'All three archives passed the Node and Chromium, Firefox and WebKit validation suites.' \
    'Use the runtime and matching extensions from the same archive.' > "$work/notes.txt"
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --target "$VALIDATED_SHA" --draft \
    --title "PHP-WASM int64 $tag" --notes-file "$work/notes.txt"
fi

# Retry only this commit's unpublished draft. Published versions are never replaced.
release=$(read_release)
[[ $(jq -r '.draft' <<< "$release") == true && $(jq -r '.target_commitish' <<< "$release") == "$VALIDATED_SHA" ]] \
  || die 'Release no longer matches the unpublished draft for this commit.'
gh release upload "$tag" "${assets[@]}" --repo "$GITHUB_REPOSITORY" --clobber
release=$(read_release)
[[ $(jq -r '.draft' <<< "$release") == true && $(jq -r '.target_commitish' <<< "$release") == "$VALIDATED_SHA" ]] \
  || die 'The draft changed before publication.'
jq -r '.assets[].name' <<< "$release" | sort > "$work/actual-assets"
cmp --silent "$work/expected-assets" "$work/actual-assets" || die 'The draft does not contain exactly the six expected assets.'
existing_commit=$(tag_commit)
[[ -z $existing_commit || $existing_commit == "$VALIDATED_SHA" ]] || die 'The release tag changed before publication.'
gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false --latest
release=$(read_release)
[[ $(jq -r '.draft' <<< "$release") == false ]] || die 'Release publication did not complete.'
[[ $(tag_commit) == "$VALIDATED_SHA" ]] || die 'Published tag does not identify the validated commit.'
log "Published $tag from validated commit $VALIDATED_SHA."
