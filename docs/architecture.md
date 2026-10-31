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

The initial PHP patch releases match the selected PHP-WASM revision. The
minor-version support matrix is not a claim that these are the newest PHP
patch releases. Source maintenance and PHP security updates must be tracked
as part of runtime release maintenance.

## Integration boundary

This project publishes the PHP runtime and its matching artifacts. JoomEngine
Playground integration is a separate change after the runtime passes its build
and validation matrix. The MariaDB engine does not need a wider pointer ABI
to store SQL BIGINT values. The PHP PDO adapter must still be rebuilt and
tested against this runtime before Playground integration.

No WordPress runtime, application, or service is required.
