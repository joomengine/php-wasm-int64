#!/usr/bin/env bash
# Build all supported ESM runtimes and dynamic PHP extensions for one minor.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
for command in git jq docker make node sha256sum; do need "$command"; done
select_php "${1:-}"
BUILD_JOBS=${BUILD_JOBS:-2}
[[ $BUILD_JOBS =~ ^[1-9][0-9]*$ ]] || die 'BUILD_JOBS must be a positive integer.'
docker compose version >/dev/null
bash "$INT64_ROOT/scripts/prepare.sh" "$PHP_MINOR" >/dev/null
mkdir -p "$INT64_ROOT/dist/logs"
exec > >(tee "$INT64_ROOT/dist/logs/php-$PHP_MINOR-build.log") 2>&1

image="joomengine/php-wasm-int64-builder:${BUILD_FINGERPRINT:0:16}"
base_image=$(jq -er '.emscripten.image' "$INT64_ROOT/versions.json")
[[ $base_image == "emscripten/emsdk:$EMSCRIPTEN_VERSION@sha256:"* ]] || die 'The builder image must pin the selected Emscripten version and digest.'
export BUILD_IMAGE="$image" HOST_PROJECT_ROOT="$UPSTREAM_DIRECTORY"
export COMPOSE_PROJECT_NAME="php-int64-${PHP_MINOR//./}-${BUILD_FINGERPRINT:0:12}"
export EMCC_CORES="$BUILD_JOBS"
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git -C "$UPSTREAM_DIRECTORY" show -s --format=%ct HEAD)

# The upstream image supplies its tested Emscripten fiber/Asyncify patches.
# Pin the image digest while retaining its actual compiler version separately.
docker build --tag "$image" \
  --build-arg "EMSDK_VERSION=${base_image#emscripten/emsdk:}" \
  --file "$UPSTREAM_DIRECTORY/emscripten-builder.dockerfile" "$UPSTREAM_DIRECTORY"
cat > "$UPSTREAM_DIRECTORY/docker-compose.int64.yml" <<EOF
services:
  emscripten-builder:
    environment:
      EMCC_CORES: "$BUILD_JOBS"
      SOURCE_DATE_EPOCH: "$SOURCE_DATE_EPOCH"
EOF

printf -v compose 'docker compose -f %q -f %q' \
  "$UPSTREAM_DIRECTORY/docker-compose.yml" "$UPSTREAM_DIRECTORY/docker-compose.int64.yml"
make_arguments=(--no-print-directory -C "$UPSTREAM_DIRECTORY" ENV_FILE=.env.int64 \
  "PHP_VERSION_FULL=$PHP_VERSION" "CPU_COUNT=$BUILD_JOBS" "MAX_LOAD=$BUILD_JOBS" \
  MAKE_SHUFFLE= "DOCKER_COMPOSE=$compose")
targets=(web-mjs worker-mjs webview-mjs node-mjs \
  web-cgi-mjs worker-cgi-mjs webview-cgi-mjs node-cgi-mjs \
  web-cli-mjs node-cli-mjs web-dbg-mjs node-dbg-mjs)
for target in "${targets[@]}"; do
  log "Building PHP $PHP_VERSION: $target"
  make "${make_arguments[@]}" "$target"
done

# Export the actual configured headers for future ABI-compatible side modules.
# PHP's install-headers does not require a native host PHP interpreter.
docker compose -f "$UPSTREAM_DIRECTORY/docker-compose.yml" -f "$UPSTREAM_DIRECTORY/docker-compose.int64.yml" \
  run -T --rm -w "/src/third_party/php$PHP_MINOR-src" emscripten-builder emmake make install-headers
compiler_version=$(docker compose -f "$UPSTREAM_DIRECTORY/docker-compose.yml" -f "$UPSTREAM_DIRECTORY/docker-compose.int64.yml" \
  run -T --rm emscripten-builder emcc -dumpversion | tail -n 1)
[[ $compiler_version == "$EMSCRIPTEN_VERSION" ]] || die "Unexpected compiler version: $compiler_version"
image_id=$(docker image inspect --format '{{.Id}}' "$image")
docker compose -f "$UPSTREAM_DIRECTORY/docker-compose.yml" -f "$UPSTREAM_DIRECTORY/docker-compose.int64.yml" \
  run -T --rm emscripten-builder cat /emsdk/upstream/emscripten/LICENSE \
  > "$BUILD_DIRECTORY/emscripten-LICENSE"
docker compose -f "$UPSTREAM_DIRECTORY/docker-compose.yml" -f "$UPSTREAM_DIRECTORY/docker-compose.int64.yml" \
  run -T --rm emscripten-builder dpkg-query -W '-f=${Package}\t${Version}\n' \
  > "$BUILD_DIRECTORY/builder-packages.tsv"
jq -n --arg fingerprint "$BUILD_FINGERPRINT" --arg compiler "$compiler_version" --arg image "$image_id" \
  --argjson epoch "$SOURCE_DATE_EPOCH" '{schemaVersion:1,fingerprint:$fingerprint,compiler:$compiler,image:$image,sourceDateEpoch:$epoch}' \
  > "$BUILD_DIRECTORY/built.json"
bash "$INT64_ROOT/scripts/stage.sh" "$PHP_MINOR"
