# PHP wasm32 with native int64 integers

Apply the patch matching the PHP minor version to its pinned source tree **after**
the corresponding patch in `patches/runtime/`. The patches target PHP 8.3.36,
8.4.27, and 8.5.12;
new source releases require review and a fresh full build/test matrix.

Compile the runtime and every PHP extension with `-DZEND_WASM_INT64=1` and retain
that setting in the installed PHP configuration header. This mode requires the
Emscripten wasm32 target. It does not define a foreign CPU architecture or change
the actual widths of pointers, `size_t`, or C `long`.

The patches:

- Select PHP's existing `int64_t`/`uint64_t` Zend value representation and matching
  timelib integer types.
- Add `,wasm32-int64` to both PHP-module and Zend-extension build identifiers.
  Stock int32 modules sharing the PHP API number must not be loaded into this ABI.
- Use Clang's typed overflow multiplication intrinsic for the mixed-width build.
- Preserve wide values during Zend size comparisons and string offset checks.
- Reject unaddressable string write/repeat/padding sizes before narrowing to
  `size_t`; clamp comparison lengths to the available inputs.
- Bound explicit stream read buffers and random byte allocations before a
  64-bit length can truncate into a smaller allocation; compare write limits
  before narrowing them to the actual input length.
- Preserve int64 SQLite callback arguments and results, and use PHP's integer
  bounds when converting Intl date parser timestamps.
- Check multibyte offsets, widths and padding before converting to the wasm32
  address size; bound fixed-width character counts before multiplying to bytes.
- Reject ZIP read lengths and OpenSSL derived-key buffer lengths that cannot
  fit a wasm32 PHP string before allocating their buffers.

`tests/php/core.php` covers arithmetic and overflow, hash keys with equal low
32 bits, PHP value copying, fiber suspension/resumption, serialization, JSON, binary packing, dates outside
the 32-bit timestamp range, and out-of-range memory offsets. These checks are
part of the release gate, not a claim that arbitrary third-party native PHP
extensions are compatible without a matching build and validation.

Upstream source notices and licenses remain in place. Zend and timelib patches
are modifications of those sources and retain their respective license terms.
