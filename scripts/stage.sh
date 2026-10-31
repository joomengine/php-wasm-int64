#!/usr/bin/env bash
# Assemble one self-contained ESM distribution; never publish upstream npm names.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
select_php "${1:-}"
[[ -f "$BUILD_DIRECTORY/built.json" ]] || die 'Build this PHP version before staging it.'
[[ $(jq -er '.fingerprint' "$BUILD_DIRECTORY/built.json") == "$BUILD_FINGERPRINT" ]] || die 'Stale build fingerprint.'
mkdir -p "$INT64_ROOT/dist"
staging=$(mktemp -d "$INT64_ROOT/dist/.php-$PHP_MINOR.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
mkdir -p "$staging/packages" "$staging/include" "$staging/licenses" "$staging/build-inputs"
packages=(php-wasm php-cgi-wasm php-cli-wasm php-dbg-wasm \
  zlib libxml xml dom simplexml xmlreader xmlwriter iconv mbstring intl libzip gd openssl phar sqlite)
for package in "${packages[@]}"; do
  source="$UPSTREAM_DIRECTORY/packages/$package"
  destination="$staging/packages/$package"
  [[ -d $source ]] || die "Missing built package: $package"
  mkdir -p "$destination"
  while IFS= read -r -d '' file; do
    name=${file##*/}
    # Upstream webpack adapters embed its npm package names and are not part of
    # this standalone ESM distribution.
    [[ $name != webpack.mjs ]] || continue
    # Helpers for other minors would advertise binary files absent from this tar.
    if [[ $name =~ ^8\.[0-5]\.mjs$ && $name != "$PHP_MINOR.mjs" ]]; then continue; fi
    cp -L -- "$file" "$destination/$name"
  done < <(find "$source" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.wasm' -o -name '*.so' \
    -o -name '*.dat' -o -name '*.data' -o -name '*.d.ts' -o -name '*.d.mts' \
    -o -name 'LICENSE*' -o -name 'NOTICE*' -o -name 'README*' \) -print0)
  if [[ -f "$destination/$PHP_MINOR.mjs" ]]; then
    # The published upstream index eagerly imports helpers for six PHP minors.
    # Export the single supported helper directly in this per-minor distribution.
    printf "export { default } from './%s.mjs';\nexport * from './%s.mjs';\n" "$PHP_MINOR" "$PHP_MINOR" > "$destination/index.mjs"
  fi
  while IFS= read -r -d '' file; do
    sed -E "s/'8\.[0-5]'/'$PHP_MINOR'/g" "$file" > "$file.int64"
    mv -- "$file.int64" "$file"
  done < <(find "$destination" -maxdepth 1 -type f \( -name '*.d.ts' -o -name '*.d.mts' \) -print0)
  exports=$(find "$destination" -maxdepth 1 -type f -name '*.mjs' -printf '%f\n' | sort \
    | jq -Rn '[inputs | {key:("./" + .),value:("./" + .)}, {key:("./" + sub("\\.mjs$";"")),value:("./" + .)}] | from_entries')
  jq --arg package "$package" --arg minor "$PHP_MINOR" --arg version "$RELEASE_VERSION" --argjson exports "$exports" '
    . as $original |
    .name = ("@joomengine/php-wasm-int64-" + $package + "-php" + ($minor | gsub("\\.";""))) |
    .version = $version | .private = true | .type = "module" |
    .upstream = {name:$original.name,repository:"https://github.com/seanmorris/php-wasm",version:$original.version} |
    .repository = "https://github.com/joomengine/php-wasm-int64" |
    .exports = ($exports + {"./package.json":"./package.json"} + (if ($exports | has("./index")) then {".":"./index.mjs"} else {} end)) |
    del(.scripts,.bin,.dependencies,.devDependencies,.workspaces,.main,.module,.types)
  ' "$source/package.json" > "$destination/package.json"
done

required=(
  'php-wasm:PhpNode:node' 'php-wasm:PhpWeb:web'
  'php-wasm:PhpWorker:worker' 'php-wasm:PhpWebview:webview'
  'php-cgi-wasm:PhpCgiNode:cgi-node' 'php-cgi-wasm:PhpCgiWeb:cgi-web'
  'php-cgi-wasm:PhpCgiWorker:cgi-worker' 'php-cgi-wasm:PhpCgiWebview:cgi-webview'
  'php-cli-wasm:PhpCliNode:cli-node' 'php-cli-wasm:PhpCliWeb:cli-web'
  'php-dbg-wasm:PhpDbgNode:dbg-node' 'php-dbg-wasm:PhpDbgWeb:dbg-web'
)
for runtime in "${required[@]}"; do
  IFS=: read -r package wrapper suffix <<< "$runtime"
  for name in "$wrapper.mjs" "php$PHP_MINOR-$suffix.mjs" "php$PHP_MINOR-$suffix.mjs.wasm"; do
    [[ -s "$staging/packages/$package/$name" ]] || die "Missing required artifact: $package/$name"
  done
done
headers="$UPSTREAM_DIRECTORY/lib/php$PHP_MINOR/include/php"
[[ -f "$headers/main/php_config.h" ]] || die 'Configured PHP extension SDK headers were not installed.'
grep -q '^#define ZEND_WASM_INT64 1$' "$headers/main/php_config.h" || die 'SDK headers lack the integer ABI marker.'
cp -a "$headers/." "$staging/include/"
cp "$INT64_ROOT/LICENSE" "$staging/LICENSE"
[[ ! -f "$INT64_ROOT/NOTICE" ]] || cp "$INT64_ROOT/NOTICE" "$staging/NOTICE"
cp "$INT64_ROOT/versions.json" "$INT64_ROOT/VERSION" "$staging/build-inputs/"
cp "$BUILD_DIRECTORY/builder-packages.tsv" "$staging/build-inputs/"
cp -a "$INT64_ROOT/patches" "$INT64_ROOT/config" "$INT64_ROOT/scripts" "$staging/build-inputs/"
for file in LICENSE LICENSE-GPL NOTICE; do
  [[ ! -f "$UPSTREAM_DIRECTORY/$file" ]] || cp "$UPSTREAM_DIRECTORY/$file" "$staging/licenses/upstream-$file"
done
while IFS= read -r -d '' file; do
  relative=${file#"$UPSTREAM_DIRECTORY/third_party/"}
  mkdir -p -- "$staging/licenses/$(dirname -- "$relative")"
  cp -L -- "$file" "$staging/licenses/$relative"
done < <(find "$UPSTREAM_DIRECTORY/third_party" -type d \( -name .git -o -name node_modules \) -prune -o \
  -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'COPYRIGHT*' -o -iname 'NOTICE*' \) -print0)
cp -a "$VRZNO_DIRECTORY/LICENSE" "$staging/licenses/vrzno-LICENSE"

patches=$(
  cd "$INT64_ROOT"
  while IFS= read -r -d '' file; do
    jq -nc --arg path "$file" --arg hash "$(sha256sum "$file" | cut -d ' ' -f 1)" '{path:$path,sha256:$hash}'
  done < <(find patches -type f -name '*.patch' -print0 | sort -z)
)
(
  cd "$staging"
  while IFS= read -r -d '' file; do
    file=${file#./}
    jq -nc --arg path "$file" --arg hash "$(sha256sum "$file" | cut -d ' ' -f 1)" \
      --argjson size "$(stat -c '%s' "$file")" '{key:$path,value:{sha256:$hash,size:$size}}'
  done < <(find . -type f -print0 | sort -z)
) > "$BUILD_DIRECTORY/artifact-files.jsonl"
jq -n --slurpfile versions "$INT64_ROOT/versions.json" --slurpfile build "$BUILD_DIRECTORY/built.json" \
  --arg version "$RELEASE_VERSION" --arg minor "$PHP_MINOR" --arg php "$PHP_VERSION" --arg phpCommit "$PHP_COMMIT" \
  --arg fingerprint "$BUILD_FINGERPRINT" --arg node "$(node --version)" --arg make "$(make --version | sed -n '1p')" \
  --argjson patches "$(jq -s . <<< "$patches")" --slurpfile files "$BUILD_DIRECTORY/artifact-files.jsonl" \
  '{schemaVersion:1,name:"php-wasm-int64",version:$version,php:{minor:$minor,version:$php,commit:$phpCommit},
    abi:$versions[0].abi,upstream:$versions[0].upstream,emscripten:$versions[0].emscripten,
    vrzno:$versions[0].vrzno,patches:$patches,build:($build[0]+{node:$node,make:$make}),
    fingerprint:$fingerprint,format:"esm",files:($files | from_entries)}' > "$staging/manifest.json"

if [[ -e "$ARTIFACT_DIRECTORY" ]]; then
  [[ -f "$ARTIFACT_DIRECTORY/manifest.json" ]] || die "Refusing to replace unrecognized directory: $ARTIFACT_DIRECTORY"
  rm -rf -- "$ARTIFACT_DIRECTORY"
fi
mv -- "$staging" "$ARTIFACT_DIRECTORY"
trap - EXIT
log "Staged PHP $PHP_VERSION: $ARTIFACT_DIRECTORY"
