# Runtime architecture

PHP-WASM int64 maintains a build overlay on Sean Morris's PHP-WASM runtime.
The source of the runtime stays upstream. This repository owns explicit source
pins, reviewed patches, compilation, validation, and separately identified
release archives. Supported PHP minor versions are 8.3, 8.4, and 8.5.

## Integer model

The target is wasm32 memory addressing with signed 64-bit PHP integers:

| Property | Contract |
| --- | --- |
| PHP integer size | 8 bytes |
| PHP minimum integer | -9223372036854775808 |
| PHP maximum integer | 9223372036854775807 |
| C pointers and size_t | 4 bytes |
| C int and long | 4 bytes |
| Zend integer types | 8 bytes |
| Memory64 browser feature | Not required |

The patchset must not pretend that the target CPU is x86-64 or claim that
size_t and pointers are 64-bit. A dedicated build mode selects the required
Zend and date-library scalar types. Boundaries that accept PHP integers as
memory sizes or string offsets must check their range before narrowing.

PHP integer overflow retains PHP's normal semantics. The runtime does not
provide arbitrary-precision native integers or unsigned 64-bit PHP integers.
It also does not increase the wasm32 address space or promise that a browser
can allocate its theoretical maximum memory.

## JavaScript interoperability

JavaScript Number can exactly represent integer values only through
9007199254740991 in magnitude. Vrzno must preserve the distinction between a
PHP integer and a floating-point value and handle signed 64-bit integers
without silently truncating them through C long, JavaScript bitwise operators,
or floating-point conversion.

Large integer values require an exact representation at the host boundary.
JSON applications must choose an explicit string or tagged representation for
such values; JSON.stringify does not serialize JavaScript BigInt by default.
Memory pointers remain ordinary wasm32 addresses and are distinct from PHP
integer values even when both are represented by numbers in existing code.

Constructor `ENV` values initialize the runtime's C environment before
application `preRun` callbacks execute. A callback can inspect or override those
values. The runtime copies its environment and callback list so separate
instances can reuse the same options without sharing initialization state.

## Embedded execution

The public `run()` and `exec()` APIs serialize operations on each interpreter.
`run()` returns 0 for successful evaluation, the requested code for `exit(n)`,
2 for an uncaught exception or parse error, and PHP's exit status (normally 255)
for a Zend bailout. A top-level `return` ends the evaluated script without
becoming a process exit code.
`exec()` returns the expression's PHP string conversion; failed evaluation
returns an empty string with the PHP diagnostic delivered through the normal
output channel. Callers needing an execution status should use `run()`.

Emscripten 6.0.6 can lose an exported function's return value after a PHP Fiber
switch. The patched native entry points retain their completed results, and
the JavaScript wrapper reads them before releasing the operation queue. This
preserves both execution statuses and expression strings across Fiber rewinds.
CLI, CGI, and debugger main functions use the same completed-status pattern.
In particular, a CGI script's nonzero exit must still trigger its normal
interpreter refresh even when that script used a Fiber.

An explicit PHP `exit()` ends the current evaluation and clears its termination
exception so the same embedded interpreter can execute another operation.
Exceptions and explicit exits during script evaluation preserve the request's
PHP state. A true Zend bailout, including termination from an output handler,
instead shuts down and reinitializes the PHP request before the next operation;
PHP variables, declarations, and output handlers from that
failed request are discarded. The JavaScript runtime and virtual filesystem
remain available. Continuing a partially unwound Zend request is unsafe even
when it appears able to print output.

Explicit embedded `refresh()` uses that request boundary as well, preserving
loaded native modules instead of attempting to load the same side libraries
again. Refresh is serialized with other public runtime operations.

## Native extensions

Every Zend-facing extension must be built against the same patched headers,
PHP minor version, toolchain, and integer ABI as the main module. The runtime
and phpdbg builds must agree. An unmodified 32-bit-integer extension is not
compatible merely because its PHP module API number matches.

The custom Zend build identifier distinguishes the integer ABI so PHP can
reject incompatible modules. Release provenance also records the source and
patch inputs. External consumers must compile their extensions with the
distributed configuration and headers; mixing upstream binaries into an int64
runtime is unsupported.

## Upstream updates

Upstream source revisions are immutable inputs. Updating them is an explicit
change that must pass patch application, compilation, and runtime validation
for all supported PHP versions. Patches apply with checked context; a changed
source is a review event, not permission to omit a patch.

The initial PHP sources are the 8.3.36, 8.4.27, and 8.5.12 security releases,
verified against PHP's release feed on 2026-10-31. The runtime compatibility
patches in `patches/runtime/` adapt Sean's pinned patch set to these newer
sources; the integer changes in `patches/php/` apply afterward. Rebases must
preserve upstream security fixes, including allocation-failure handling.
The build rejects a source version that differs from its manifest and does
not fall back to the older PHP sources selected by upstream's Make defaults.
Future PHP and native-library updates still require explicit review and the
complete validation matrix; these pins do not advance automatically.

## Integration boundary

This project publishes the PHP runtime and its matching artifacts. JoomEngine
Playground integration is a separate change after the runtime passes its build
and validation matrix. The MariaDB engine does not need a wider pointer ABI
to store SQL BIGINT values. The PHP PDO adapter must still be rebuilt and
tested against this runtime before Playground integration.

No WordPress runtime, application, or service is required.
