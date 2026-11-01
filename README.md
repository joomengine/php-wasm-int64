# PHP-WASM int64

Pinned PHP 8.3–8.5 WebAssembly builds with native 64-bit PHP integers, based on Sean Morris’s PHP-WASM runtime.

## What this project builds

This repository retrieves pinned revisions of
[Sean Morris's PHP-WASM runtime](https://github.com/seanmorris/php-wasm), PHP, and
Vrzno, applies reviewed patches, and compiles a separate distribution. It has no
WordPress runtime dependency.

| PHP minor | Pinned PHP source | Integer model |
| --- | --- | --- |
| 8.3 | 8.3.36 | Signed 64-bit PHP integers; wasm32 pointers |
| 8.4 | 8.4.27 | Signed 64-bit PHP integers; wasm32 pointers |
| 8.5 | 8.5.12 | Signed 64-bit PHP integers; wasm32 pointers |

These are PHP's current security releases as checked on 2026-10-31 against
[the official release feed](https://www.php.net/releases/active.php). Sean's
runtime patches are rebased onto these releases, preserving their newer fixes.
Release updates remain explicit reviewed changes. The exact source commits,
Emscripten version, and builder image digest are in [versions.json](versions.json).
Native-library revisions and archive checksums are in
[config/dependencies.json](config/dependencies.json).

Each per-version archive contains ESM embedded, CGI, CLI, and phpdbg runtimes,
matching dynamic extensions and their support libraries, configured PHP
extension headers, build inputs, notices, and a file checksum manifest. The
target is `PHP_INT_SIZE === 8` and `PHP_INT_MAX === 9223372036854775807`.
Memory addresses remain 32-bit; Memory64 browser support is not required.

The supported profile includes DOM/XML/reader/writer, SimpleXML, mbstring,
iconv, Intl, ZIP/zlib, GD, OpenSSL, Phar, SQLite/PDO SQLite, and the built-in
extensions selected in [config/profile.mak](config/profile.mak). It also enables
fileinfo. Cloudflare/SDL variants and the optional Waitline, PGlite, CFD1, YAML,
and Tidy packages are outside this initial distribution. A later Playground
integration must rebuild its MariaDB PDO, cURL, Sodium, and custom debugger
adapters against this runtime.

## Build and validate

Use Linux with Bash, Git, GNU Make, Node.js 24.5 or newer, npm, Docker with its
Compose plugin, jq, curl, tar, unzip, gzip, awk, and GNU coreutils. Docker must
be able to start the upstream builder. The default native build concurrency
is two jobs; `BUILD_JOBS` can select another positive value.

```bash
git clone https://github.com/joomengine/php-wasm-int64.git
cd php-wasm-int64
npm ci --ignore-scripts
npx playwright install --with-deps chromium firefox webkit

bash scripts/build.sh 8.4
node scripts/verify-artifact.mjs dist/php-8.4 8.4
node tests/run-runtime.mjs 8.4 dist/php-8.4
node tests/browser-test.mjs 8.4 dist/php-8.4
bash scripts/package.sh 8.4
```

Repeat the build and validation commands for `8.3` and `8.5` to exercise the
full matrix. The workflows perform that matrix automatically. Install
ShellCheck and a host PHP CLI to run the complete source checks locally:

```bash
bash scripts/check.sh
```

Host PHP is used only to lint fixtures. Runtime tests execute the compiled
WebAssembly PHP binaries. Browser tests run in Chromium, Firefox, and WebKit.
The integer and bridge suites cover values beyond both signed int32 and
JavaScript's safe Number range, and the PHP tests exercise narrowing from
64-bit PHP values to wasm32 memory sizes.

Downloads are checked before extraction. Source pins, configuration, patches,
and build scripts select a distinct build directory under `.build/`. Downloads
are reused from `.cache/`; output is staged under `dist/php-8.4/` for that minor.
`scripts/workspace.sh 8.4` prints its prepared upstream source directory.

CI can reuse a compiled distribution only for the exact build fingerprint and
runner platform. It verifies the restored inventory and still packages,
extracts, and runs every runtime/browser test. A cached build never substitutes
for passing tests. Failed runtime runs retain separately named `unverified-php-*`
archives for three days to support debugging; these are not release assets.

## Use the artifacts

Release archives are named `php-wasm-int64-VERSION-php8.4.tar.gz` with a separate
SHA-256 file. After extraction, the root directory is `php-8.4/` and its
`manifest.json` inventories the payload. Package metadata uses private
JoomEngine identities; this build does not publish under Sean's npm names.
Only the selected PHP minor is advertised by a per-version archive.

Always use the runtime and native PHP extensions from the same compatible
build. The custom `wasm32-int64` Zend ABI identifier rejects ordinary upstream
modules even when their PHP API number matches. Extensions compiled elsewhere
need the configured headers and matching Emscripten/Asyncify configuration.

JavaScript receives small PHP integers as exact Numbers and larger values as
BigInts. JavaScript BigInts within PHP's signed 64-bit range can be passed back
to PHP. Application JSON transport must handle BigInt explicitly; ordinary
`JSON.stringify()` does not serialize it automatically.

## Releases and maintenance

`VERSION` is the single release-version setting. Set the desired patch, minor,
or major version and merge it into `main`. After its checks pass, tag that commit:

```bash
git tag "v$(cat VERSION)"
git push origin "v$(cat VERSION)"
```

The tag must match `VERSION`. Its workflow builds and tests all three PHP
versions, then publishes their archives and checksums. Versions never increment
automatically, and published releases are never overwritten. No npm token is
required.

Updating an upstream revision requires reviewing patch applicability and
passing the complete matrix again. Source and toolchain pins make builds
auditable; deterministic archive metadata alone is not a claim that native
compilation is bit-for-bit reproducible across different build hosts.

See [architecture](docs/architecture.md), [validation and readiness](docs/validation.md),
the [PHP patch notes](patches/php/README.md), the [runtime patch notes](patches/runtime/README.md),
and the [Vrzno patch notes](patches/vrzno/README.md).
This repository's own code is Apache-2.0. Included upstream sources and binaries
retain their licenses and notices; see [NOTICE](NOTICE).
