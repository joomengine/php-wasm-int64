# Integer bridge contract

The Node and browser runtime runners import `fixtures.mjs`, call
`installBridgeFixtures(globalThis)` in the runtime's own JavaScript realm, and
execute `int64.php`. Successful execution prints `int64-bridge-ok`.

The runtime fixture checks both directions across `2^31`, `2^32`, `2^53`, and
the signed int64 boundaries, plus typed callbacks, promise results, array keys,
property operations, object casts, overflow exceptions, legacy helper arguments,
and browser timer bounds. It must run against each compiled PHP version.

`embedded-contract.mjs` runs Vrzno's actual Makefile generator, compiles all five
generated headers, and links all 44 JS functions with the pinned Emscripten 6.0.6
compiler, Asyncify, and 4 GiB memory settings. It then executes JSON transport and
object snapshot checks in the generated Wasm module. This covers the metadata
extractor's legacy backslash unescaping and the JS optimizer, which the host C
compiler cannot reproduce. The build runs this small preflight before compiling
PHP. To run it inside the pinned SDK, set `VRZNO_SOURCE_ROOT` to the patched Vrzno
directory and run `node --test tests/bridge/embedded-contract.mjs`.

`source-contract.mjs` also compiles the patched JavaScript bodies through
C macro stringification, then tests the emitted JavaScript using Node's standard
test runner and a real small Wasm i64 function. A host C compiler (`cc`, or the
executable named by `BRIDGE_CC`) is required. This catches C token and escape
hazards in `EM_JS` as well as bridge behavior; it does not cover Emscripten's
metadata extraction or replace the compiled preflight and PHP runtime tests.
Point `VRZNO_SOURCE_ROOT` at the patched Vrzno directory and run
`node --test tests/bridge/source-contract.mjs`.

The intentional conversion contract is:

| Source | Destination |
| --- | --- |
| PHP int within JS safe integer range | JavaScript Number |
| PHP int outside JS safe integer range | JavaScript BigInt |
| JavaScript safe integer Number | PHP int |
| JavaScript unsafe Number or fractional Number | PHP float |
| JavaScript BigInt within signed int64 | PHP int |
| JavaScript BigInt outside signed int64 | PHP TypeError |

Applications using JSON explicitly must encode BigInts according to their own
protocol, commonly as decimal strings. The bridge never installs a global
BigInt JSON serializer or silently narrows such values to Number.
