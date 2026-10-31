# PHP-WASM runtime patches

These patches derive from `patch/php8.3.patch`, `patch/php8.4.patch`, and
`patch/php8.5.patch` in [Sean Morris's PHP-WASM source](https://github.com/seanmorris/php-wasm/tree/1e1fb6703730759181e84c62bce35ee9129febb9/patch)
at commit `1e1fb6703730759181e84c62bce35ee9129febb9`.

They retain the upstream runtime integration and normalize paths to apply
inside the PHP source directory. They are rebased onto the official PHP
8.3.36, 8.4.27, and 8.5.12 releases, respectively. Apply the matching runtime
patch first, then `patches/php/<minor>.patch` for the integer ABI and bounds
checks.

The rebase preserves PHP's newer fallible allocation and out-of-memory paths,
tokenizer checks, ZIP short-read and CRC validation, and fiber stack sizing.
PHP 8.3's updated iconv configuration probe is also retained. Source notices
and licenses remain in place; these files are modifications of the original
PHP-WASM patches, not an independent replacement runtime.

`tests/php/core.php` checks fiber start, suspend, resume, return values, and
exception propagation. Full Node and browser runtime validation is required
for each pinned PHP release; clean patch application alone is insufficient.
