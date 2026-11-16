import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('virtual Sendmail compiles and captures through real Emscripten Asyncify', t => {
  assert.ok(process.env.UPSTREAM_SOURCE_ROOT, 'Set UPSTREAM_SOURCE_ROOT to the patched upstream source');
  const source = resolve(process.env.UPSTREAM_SOURCE_ROOT);
  const build = mkdtempSync(join(tmpdir(), 'php-mail-contract-'));
  t.after(() => rmSync(build, { recursive: true, force: true }));
  const compiler = process.env.BRIDGE_EMCC || 'emcc';
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: build, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, EMCC_CFLAGS: '' },
    });
    assert.equal(result.error, undefined, `${command} must finish successfully`);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  assert.match(run(compiler, ['--version']).stdout, /\b6\.0\.6\b/);
  writeFileSync(join(build, 'mail-test.c'), `
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <emscripten.h>
#include "mail.h"
static FILE *pipes[2];
static const unsigned char message[] = {83, 117, 98, 106, 101, 99, 116, 58, 32, 120, 13, 10, 13, 10, 0, 255, 128, 46, 13, 10};
EMSCRIPTEN_KEEPALIVE int mail_test_open(int slot, const char *command) {
  if (slot < 0 || slot > 1 || pipes[slot]) return -2;
  FILE *pipe = popen(command, "w");
  if (!pipe) return -1;
  pipes[slot] = pipe;
  if (fwrite(message, 1, 4, pipe) != 4 || fwrite(message + 4, 1, sizeof(message) - 4, pipe) != sizeof(message) - 4) return -3;
  return 0;
}
EMSCRIPTEN_KEEPALIVE int mail_test_close(int slot) {
  if (slot < 0 || slot > 1 || !pipes[slot]) return -2;
  FILE *pipe = pipes[slot]; pipes[slot] = NULL;
  return pclose(pipe);
}
EMSCRIPTEN_KEEPALIVE int mail_test_failed_stream(void) {
  FILE *pipe = popen("/usr/sbin/sendmail -t -i", "w");
  if (!pipe) return -2;
  (void) fgetc(pipe); /* A write-only stream must retain its failed read. */
  if (!ferror(pipe)) { pclose(pipe); return -3; }
  return pclose(pipe);
}
EMSCRIPTEN_KEEPALIVE int mail_test_abandon(void) {
  pib_mail_abandon();
  return mail_test_close(0);
}
EMSCRIPTEN_KEEPALIVE void mail_test_discard(void) {
  pib_mail_discard();
  pipes[0] = pipes[1] = NULL;
}
`);
  run(compiler, ['mail-test.c', join(source, 'source/pib/mail.c'), '-I', join(source, 'source/pib'),
    '--no-entry', '-O2', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=node',
    '-sMAIN_MODULE=1', '-sASYNCIFY=1', '-sWASM_BIGINT=1', '-sALLOW_MEMORY_GROWTH=1',
    '-sASSERTIONS=1', '-sEXPORTED_RUNTIME_METHODS=ccall,HEAPU8', '-o', 'mail.mjs']);
  writeFileSync(join(build, 'verify.mjs'), `
import assert from 'node:assert/strict';
import create from './mail.mjs';
const module = await create();
const expected = Uint8Array.from([83,117,98,106,101,99,116,58,32,120,13,10,13,10,0,255,128,46,13,10]);
const open = (slot, command = '/usr/sbin/sendmail -t -i') => module.ccall('mail_test_open', 'number', ['number','string'], [slot,command]);
const close = slot => module.ccall('mail_test_close', 'number', ['number'], [slot], {async:true});
assert.equal(module.ccall('pib_mail_capture_version', 'number', [], []), 1);
assert.equal(open(0), 0);
assert.equal(await close(0), 256, 'Missing host must not report successful capture');
const captures = [];
let accepted = false;
module.joomengineMailCapture = async message => {
  assert.ok(message.raw instanceof Uint8Array);
  assert.notEqual(message.raw.buffer, module.HEAPU8.buffer);
  assert.deepEqual(message.raw, expected);
  await new Promise(resolve => setTimeout(resolve, 2));
  accepted = true;
  captures.push(message);
  return true;
};
assert.equal(open(0, "'/usr/sbin/sendmail' -oi -f'one+tag@example.invalid' -t"), 0);
assert.equal(open(1, '/usr/sbin/sendmail -i -f two@example.invalid recipient@example.invalid'), 0);
assert.equal(await close(1), 0);
assert.equal(accepted, true, 'pclose must await asynchronous host acceptance');
assert.equal(await close(0), 0);
assert.equal(captures.length, 2);
assert.deepEqual(captures[0].args, ['-i','-f','two@example.invalid','recipient@example.invalid']);
assert.equal(captures[0].envelopeSender, 'two@example.invalid');
assert.deepEqual(captures[0].envelopeRecipients, ['recipient@example.invalid']);
assert.equal(captures[0].readRecipientsFromHeaders, false);
assert.equal(captures[1].envelopeSender, 'one+tag@example.invalid');
assert.deepEqual(captures[1].envelopeRecipients, []);
assert.equal(captures[1].readRecipientsFromHeaders, true);
assert.equal(captures[1].command, "'/usr/sbin/sendmail' -oi -f'one+tag@example.invalid' -t");
for (const handler of [() => false, () => undefined, () => ({}), () => {throw Error('host');},
  async () => false, async () => {throw Error('host async');}]) {
  module.joomengineMailCapture = handler;
  assert.equal(open(0), 0);
  assert.equal(await close(0), 256, 'Failed host acceptance must retain waitpid failure status');
}
let unwantedCalls = 0;
module.joomengineMailCapture = () => { unwantedCalls++; return true; };
assert.equal(open(0), 0);
assert.equal(await module.ccall('mail_test_abandon', 'number', [], [], {async:true}), 256);
assert.equal(await module.ccall('mail_test_failed_stream', 'number', [], [], {async:true}), 256);
assert.equal(open(0), 0);
module.ccall('mail_test_discard', null, [], []);
assert.equal(unwantedCalls, 0, 'Abandoned/failed pipes must not call the host');
for (const command of ['/bin/sh -c true', '/usr/sbin/sendmail -t | cat', '/usr/sbin/sendmail -f$(true)', '/usr/sbin/sendmail -X /tmp/log']) {
  assert.equal(open(0, command), -1, 'Unsupported process command must be rejected');
}
module.joomengineMailCapture = message => { assert.deepEqual(message.raw, expected); return true; };
for (let index = 0; index < 20; index++) { assert.equal(open(0),0); assert.equal(await close(0),0); }
for (const capture of captures) assert.deepEqual(capture.raw,expected,'Later allocations must not alter retained message bytes');
`);
  run(process.execPath, ['verify.mjs']);
});
