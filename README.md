# PHP-WASM int64

Reproducible PHP 8.3–8.5 WebAssembly builds with native 64-bit PHP integers, based on Sean Morris’s PHP-WASM runtime.

## Implementation status

The initial runtime is under development. Published upstream binaries still use 32-bit PHP integers; this repository does not yet provide a validated replacement.

The implementation branch tracks:

- Pinned upstream sources and reproducible build tooling.
- PHP 8.3, 8.4, and 8.5 patches for 64-bit Zend integers with wasm32 memory addressing.
- Matching Vrzno conversions, PHP extensions, CGI, CLI, and debugger builds.
- Native integer, JavaScript boundary, browser, and extension validation.
- Versioned release archives, checksums, build provenance, and upstream notices.

Playground integration follows validation of this runtime and is outside this initial pull request.
