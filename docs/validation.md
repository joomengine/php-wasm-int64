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
- The matching dynamically loaded PHP extensions start and execute real
  operations, rather than merely existing on disk.
- Browser execution is tested with the built WebAssembly artifacts.
- Release archives contain the expected binaries, notices, source/build
  provenance, and checksums and can be validated after extraction.

Native-host PHP execution, mocked WebAssembly, source-text checks, or a test
that silently skips missing runtime files cannot replace these checks.

## Release boundary

Release workflows must run the runtime validation for the tagged source and
publish only the artifacts produced by that source. Pull-request runs upload
review artifacts and diagnostics; they do not publish an npm package or alter
the deployed Playground. A tag alone does not establish readiness.

Tests establish the behavior they exercise. They do not certify every PHP
extension or remove browser restrictions on networking, processes, storage,
or memory. Any unsupported runtime variant or extension must be named in the
release documentation rather than silently omitted.
