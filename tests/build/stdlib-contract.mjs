import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

if (!process.env.UPSTREAM_SOURCE_ROOT) {
  throw new Error('Set UPSTREAM_SOURCE_ROOT to the pinned, patched php-wasm directory.');
}
const generator = resolve(process.env.UPSTREAM_SOURCE_ROOT, 'demo-node/get-symbols.mjs');
const directory = mkdtempSync(resolve(tmpdir(), 'stdlib-contract-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const runtimeDirectory = resolve(directory, 'custom distribution');
mkdirSync(runtimeDirectory);
const runtime = resolve(runtimeDirectory, 'PhpNode.mjs');
const expected = 'export const value = 9223372036854775807n;\n';
writeFileSync(runtime, `
import assert from 'node:assert/strict';
export class PhpNode extends EventTarget {
  constructor(options) {
    super();
    assert.deepEqual(options, { version: '8.5', envName: 'Worker' });
    // The generator must terminate after flushing even if its runtime has handles.
    setInterval(() => {}, 1000);
  }
  async run(source) {
    assert.equal(typeof source, 'string');
    assert.ok(source.includes('get_defined_constants'));
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    this.dispatchEvent(new CustomEvent('output', { detail: [${JSON.stringify(expected)}] }));
    if (process.env.STDLIB_TEST_MODE === 'diagnostic') {
      this.dispatchEvent(new CustomEvent('error', { detail: ['Runtime initialization failed\\n'] }));
    }
    return process.env.STDLIB_TEST_MODE === 'status' ? 255 : 0;
  }
  flush() {}
}
`);

function generate(mode) {
  const result = spawnSync(process.execPath, [generator, '8.5', 'Worker', runtime], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, STDLIB_TEST_MODE: mode },
  });
  assert.equal(result.error, undefined, `Generator did not finish: ${result.error}`);
  return result;
}

test('stdlib generator imports the explicit local runtime and flushes delayed source', () => {
  const result = generate('success');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, '');
});

for (const mode of ['status', 'diagnostic']) {
  test(`stdlib generator rejects PHP ${mode} failures without publishing partial source`, () => {
    const result = generate(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /symbol generation failed/);
  });
}
