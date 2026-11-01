# Validation and readiness

A change is ready for review only after its current commit has passed the
complete PHP 8.3, 8.4, and 8.5 build and runtime matrix. Source checks alone do
not establish runtime compatibility. A draft pull request must not be marked
ready on the strength of checks from an earlier commit.

## Required behavior

- PHP exposes 8-byte integers and the exact signed 64-bit minimum and maximum.
- The executing PHP patch version matches the distribution manifest.
- Arithmetic, overflow, shifts, numeric array keys, serialization, JSON,
  pack/unpack, and date values retain their PHP semantics.
- PHP integers outside the wasm32 size range cannot wrap into a small
  allocation, string length, or string offset.
- Vrzno preserves exact integers across both directions of the PHP/JavaScript
  boundary, including values beyond JavaScript's safe Number range.
- Embedded, CGI, CLI, and debugger runtimes agree on integer width.
- PHP fibers retain integer values across suspension, resumption, and return.
- Embedded execution preserves statuses and expression results across Fiber
  switches, and subsequent operations run after explicit exits, parse errors,
  and caught or uncaught exceptions.
- Constructor environment values reach PHP, and reused callback options do not
  mix values between runtime instances.
- The matching dynamically loaded PHP extensions start and execute real
  operations, rather than merely existing on disk.
- Browser execution is tested with the built WebAssembly artifacts.
- Release archives contain the expected binaries, notices, source/build
  provenance, and checksums and can be validated after extraction.

Native-host PHP execution, mocked WebAssembly, source-text checks, or a test
that silently skips missing runtime files cannot replace these checks.

Before compiling PHP, the pinned Emscripten builder generates all Vrzno headers
using the upstream Make fragment, compiles their embedded functions, and links
them into an executable WebAssembly module. The resulting JavaScript must parse
and preserve escaped JSON and signed 64-bit values. This catches compiler
metadata transformations that host C stringification alone cannot detect.

The builder also runs PHP's `strcasestr` behavior probe against an external
WebAssembly side library. Configure probes must find installed side libraries
before deciding whether a C library function works. Their filesystem resolver
is confined to configure and is not linked into distributed runtimes.

A compiled environment regression checks constructor values, application
`preRun` overrides, and instance isolation using the actual Emscripten pipeline.
After the first web target has built Node and its extensions, the same integer,
bridge, extension, and embedded execution fixtures run as an early smoke check
against those real files. The expected PHP release comes from the pinned build inputs;
this early check does not create a distribution manifest or replace the final
tests against extracted release archives.

The execution contract is shared by Node, browser pages, and browser workers.
It checks actual output and a subsequent operation as well as return values,
so a silent no-op cannot satisfy a success assertion. Browser diagnostics retain
nested failures and their causes across worker messages.
Fatal-bailout recovery also checks garbage collection and request reset, rather
than treating a successful subsequent print as proof of a healthy interpreter.
Separate SAPI regressions check CLI and debugger batch exit statuses after
Fibers and CGI response/refresh behavior after nonzero exits. Explicit embedded
refresh must preserve the filesystem and working extensions while clearing PHP
request state and invalidating old PHP object proxies.

Node and browser runners collect independent fixture and runtime failures while
preserving interpreter reuse on successful paths. Browser validation still runs
when Node validation fails, provided the extracted archive passed verification.
Both suites must pass before CI uploads a verified archive. Compiled cache keys
include the copied license and notice files as well as source and build inputs;
all final runtime tests run again when compiled files are restored from cache.

When a build fails before staging, its diagnostics include
`logs/partial-runtime.tar.gz` if package files are available. This archive keeps
the partial runtime binaries, module helpers, package metadata, and declarations
under their relative `packages/` paths for debugging. These files are unverified;
the archive excludes build sources, caches, and environment files.

## Release boundary

Pushing a `vVERSION` tag triggers the release build and validation. The tag must
match `VERSION` and identify a commit on the default branch. Publication uses
only that run’s verified artifacts after every validation job passes. Neither
merges nor pull-request runs publish releases. Published versions are never
overwritten. Playground deployment is separate.

Tests establish the behavior they exercise. They do not certify every PHP
extension or remove browser restrictions on networking, processes, storage,
or memory. Any unsupported runtime variant or extension must be named in the
release documentation rather than silently omitted.
