#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const supportedVersions = ['8.3', '8.4', '8.5'];
const extensionPackages = [
  'libxml', 'dom', 'zlib', 'libzip', 'gd', 'iconv', 'intl', 'openssl',
  'mbstring', 'phar', 'sqlite', 'xml', 'simplexml', 'xmlreader', 'xmlwriter',
];

export async function verifyArtifact(directory, expectedMinor) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported manifest schema');
  assert.ok(supportedVersions.includes(manifest.php?.minor), 'Unsupported PHP version in manifest');
  if (expectedMinor) assert.equal(manifest.php.minor, expectedMinor, 'Unexpected PHP version in archive');
  assert.equal(manifest.abi?.integerBits, 64, 'Distribution must have 64-bit PHP integers');
  assert.equal(manifest.abi?.pointerBits, 32, 'Distribution must have wasm32 pointers');
  for (const [key, commit] of [['upstream', manifest.upstream?.commit], ['vrzno', manifest.vrzno?.commit]]) {
    assert.match(commit || '', /^[a-f0-9]{40}$/, `Missing exact ${key} source revision`);
  }
  assert.match(manifest.emscripten?.version || '', /^\d+\.\d+\.\d+$/, 'Missing Emscripten version');
  assert.ok(Array.isArray(manifest.patches) && manifest.patches.length >= 3, 'Manifest must record PHP, runtime, and bridge patches');
  for (const patch of manifest.patches) assert.match(patch.sha256 || '', /^[a-f0-9]{64}$/, `Invalid patch digest: ${patch.path}`);
  const expected = manifest.files;
  assert.ok(expected && typeof expected === 'object' && !Array.isArray(expected), 'Missing artifact inventory');
  const actual = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const filename = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Distribution must not contain symlinks: ${filename}`);
      if (entry.isDirectory()) await walk(filename);
      else {
        assert.ok(entry.isFile(), `Unsupported artifact entry: ${filename}`);
        const name = relative(root, filename).split('\\').join('/');
        if (name !== 'manifest.json') actual.push(name);
      }
    }
  }
  await walk(root);
  assert.deepEqual(actual.sort(), Object.keys(expected).sort(), 'Artifact files differ from the complete manifest inventory');
  for (const name of actual) {
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), `Unsafe artifact path: ${name}`);
    const filename = join(root, name);
    const information = await lstat(filename);
    assert.equal(information.size, expected[name].size, `Size mismatch: ${name}`);
    const bytes = await readFile(filename);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected[name].sha256, `Checksum mismatch: ${name}`);
    if (name.endsWith('.wasm') || name.endsWith('.so')) {
      assert.deepEqual([...bytes.subarray(0, 4)], [0, 97, 115, 109], `Native artifact is not WebAssembly: ${name}`);
      assert.ok(WebAssembly.validate(bytes), `Invalid WebAssembly binary: ${name}`);
    }
  }
  const minor = manifest.php.minor;
  const requireFile = name => assert.ok(Object.hasOwn(expected, name), `Missing required artifact: ${name}`);
  const runtimes = [
    ['php-wasm', '', ['web', 'worker', 'webview', 'node'], ['PhpWeb', 'PhpWorker', 'PhpWebview', 'PhpNode']],
    ['php-cgi-wasm', 'cgi-', ['web', 'worker', 'webview', 'node'], ['PhpCgiWeb', 'PhpCgiWorker', 'PhpCgiWebview', 'PhpCgiNode']],
    ['php-cli-wasm', 'cli-', ['web', 'node'], ['PhpCliWeb', 'PhpCliNode']],
    ['php-dbg-wasm', 'dbg-', ['web', 'node'], ['PhpDbgWeb', 'PhpDbgNode']],
  ];
  for (const [pkg, prefix, environments, wrappers] of runtimes) {
    for (const wrapper of wrappers) requireFile(`packages/${pkg}/${wrapper}.mjs`);
    for (const environment of environments) {
      requireFile(`packages/${pkg}/php${minor}-${prefix}${environment}.mjs`);
      requireFile(`packages/${pkg}/php${minor}-${prefix}${environment}.mjs.wasm`);
    }
  }
  for (const extension of extensionPackages) requireFile(`packages/${extension}/${extension === 'libxml' ? 'index' : minor}.mjs`);
  assert.ok(actual.some(name => name.startsWith('include/') && name.endsWith('/zend_long.h')), 'Matching PHP/Zend headers are absent');
  assert.ok(actual.some(name => /(^|\/)LICENSE(?:\.|$)/.test(name)), 'License texts are absent');
  assert.ok(actual.some(name => /(^|\/)NOTICE(?:\.|$)/.test(name)), 'Upstream notices are absent');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Usage: node scripts/verify-artifact.mjs <distribution-directory> [PHP-minor]');
  const manifest = await verifyArtifact(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ verified: true, php: manifest.php, files: Object.keys(manifest.files).length, abi: manifest.abi }));
}
