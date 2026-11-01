import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('constructor ENV reaches libc before application preRun callbacks', t => {
  assert.ok(process.env.UPSTREAM_SOURCE_ROOT, 'Set UPSTREAM_SOURCE_ROOT to the patched upstream source');
  const source = resolve(process.env.UPSTREAM_SOURCE_ROOT);
  const build = mkdtempSync(join(tmpdir(), 'php-environment-contract-'));
  t.after(() => rmSync(build, { recursive: true, force: true }));
  const compiler = process.env.BRIDGE_EMCC || 'emcc';
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: build, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
      env: { ...process.env, EMCC_CFLAGS: '' },
    });
    assert.equal(result.error, undefined, `${command} must finish successfully`);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  assert.match(run(compiler, ['--version']).stdout, /\b6\.0\.6\b/);
  writeFileSync(join(build, 'environment.c'), `
#include <stdlib.h>
#include <emscripten.h>
EMSCRIPTEN_KEEPALIVE const char *read_environment(const char *name) { return getenv(name); }
EMSCRIPTEN_KEEPALIVE int has_environment(const char *name) { return getenv(name) != NULL; }
`);
  run(compiler, ['environment.c', '--no-entry', '-O2', '-sMODULARIZE=1', '-sEXPORT_ES6=1',
    '-sENVIRONMENT=node', '-sMAIN_MODULE=1', '-sASYNCIFY=1', '-sWASM_BIGINT=1',
    '-sASSERTIONS=1', '-sEXPORTED_RUNTIME_METHODS=ccall,ENV',
    '--pre-js', join(source, 'source/env.js'), '-o', 'environment.mjs']);
  writeFileSync(join(build, 'verify.mjs'), `
import assert from 'node:assert/strict';
import create from './environment.mjs';
const requested = {
  JOOMENGINE_EXPECTED_PHP_VERSION: '8.5.12', PHP_VERSION: '8.5',
  UNICODE_VALUE: 'é雪', EMPTY_VALUE: '', USER: undefined, OVERRIDE_VALUE: 'constructor',
};
const callbacks = [];
const first = await create({ ENV: requested, preRun(module) {
  callbacks.push('first');
  assert.equal(module.ENV.JOOMENGINE_EXPECTED_PHP_VERSION, '8.5.12');
  module.ENV.OVERRIDE_VALUE = 'application';
} });
const read = (module, name) => module.ccall('read_environment', 'string', ['string'], [name]);
const has = (module, name) => module.ccall('has_environment', 'number', ['string'], [name]);
assert.equal(read(first, 'JOOMENGINE_EXPECTED_PHP_VERSION'), '8.5.12');
assert.equal(read(first, 'PHP_VERSION'), '8.5');
assert.equal(read(first, 'UNICODE_VALUE'), 'é雪');
assert.equal(read(first, 'EMPTY_VALUE'), '');
assert.equal(has(first, 'EMPTY_VALUE'), 1);
assert.equal(has(first, 'USER'), 0);
assert.equal(read(first, 'OVERRIDE_VALUE'), 'application');
assert.equal(requested.OVERRIDE_VALUE, 'constructor', 'Runtime writes must not mutate constructor options');
const second = await create({ ENV: { PHP_VERSION: '8.3' }, preRun: [
  module => { callbacks.push('second'); assert.equal(module.ENV.PHP_VERSION, '8.3'); },
  () => callbacks.push('third'),
] });
assert.equal(read(second, 'PHP_VERSION'), '8.3');
assert.equal(has(second, 'JOOMENGINE_EXPECTED_PHP_VERSION'), 0, 'Module instances must not share ENV');
assert.equal(read(first, 'PHP_VERSION'), '8.5');
assert.deepEqual(callbacks, ['first', 'second', 'third']);
const sharedCallback = module => { module.ENV.OVERRIDE_VALUE += '-application'; };
const sharedCallbacks = [sharedCallback];
const third = await create({ ENV: { INSTANCE: 'third', OVERRIDE_VALUE: 'third' }, preRun: sharedCallbacks });
assert.equal(read(third, 'OVERRIDE_VALUE'), 'third-application');
const fourth = await create({ ENV: { INSTANCE: 'fourth', OVERRIDE_VALUE: 'fourth' }, preRun: sharedCallbacks });
assert.deepEqual(sharedCallbacks, [sharedCallback], 'Runtime initializers must not enter a reusable caller callback array');
assert.equal(third.ENV.OVERRIDE_VALUE, 'third-application', 'Reusing callbacks must not reset an earlier module environment');
assert.equal(fourth.ENV.OVERRIDE_VALUE, 'fourth-application');
assert.equal(read(third, 'INSTANCE'), 'third');
assert.equal(read(fourth, 'INSTANCE'), 'fourth');
assert.equal(read(fourth, 'OVERRIDE_VALUE'), 'fourth-application');
`);
  run(process.execPath, ['verify.mjs']);
});
