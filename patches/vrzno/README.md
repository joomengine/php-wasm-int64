# Vrzno int64 bridge

Apply `series` in order at the root of Vrzno commit
`a35c6fec588817bb421aebda2ebe83d48af2e870`, using `git apply --check` before
applying. The build must use the matching PHP int64 headers. The patched bridge
rejects compilation when `sizeof(zend_long)` is not eight bytes; its existing
wasm32 pointer requirement remains in place.

`0001-int64-bridge.patch` changes these boundaries:

- Integer creation and numeric hash lookup use `zend_long`, with exact BigInt
  arguments at the Wasm i64 boundary. Pointers, counts and element positions
  retain their wasm32 types.
- PHP integers become JavaScript Numbers only within the safe integer range;
  larger integers become BigInts. JavaScript safe-integer Numbers and signed
  int64 BigInts become PHP integers. Unsafe Numbers remain PHP floats; BigInts
  outside the PHP signed range raise `TypeError`.
- Array keys are recognized without Number rounding. Leading zeros, `-0`,
  exponent notation and values outside the PHP integer range remain strings.
- PHP truthiness treats JavaScript `0n` as zero.
- Object inspection preserves exact signed int64 BigInts in its JSON snapshot,
  retaining detached nested values and the existing bounded behavior for cycles.
- The legacy `vrzno_run()` helper retains detached JSON-shaped arguments, using
  exact parsing for integer tokens. PHP emits a fractional suffix for integral
  floats so those remain JavaScript Numbers. This internal helper does not
  change the browser's global `JSON.parse` or application JSON behavior.
- JSON string scanners compare character codes, avoiding backslash literals that
  Emscripten's metadata extractor unescapes after `EM_JS` stringification. The
  compiled bridge preflight verifies the actual generated headers and final JS
  link before the full PHP build.
- Browser timer delays are validated within `0..2147483647` milliseconds before
  converting the i64 import to the Number expected by `setTimeout`.

These changes retain the upstream source licenses and notices. The patch is
maintained separately so it can be reviewed and proposed upstream.
