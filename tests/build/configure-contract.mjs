import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('configure probes find external side libraries without changing runtime loaders', t => {
  assert.ok(process.env.UPSTREAM_SOURCE_ROOT, 'Set UPSTREAM_SOURCE_ROOT to the patched upstream source');
  const source = resolve(process.env.UPSTREAM_SOURCE_ROOT);
  const build = mkdtempSync(join(tmpdir(), 'php-configure-contract-'));
  t.after(() => rmSync(build, { recursive: true, force: true }));
  const compiler = process.env.BRIDGE_EMCC || 'emcc';
  const run = (command, args, environment = {}) => spawnSync(command, args, {
    cwd: build, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, EMCC_CFLAGS: '', ...environment },
  });
  const successful = (command, args, environment) => {
    const result = run(command, args, environment);
    assert.equal(result.error, undefined, `${command} must finish successfully`);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  assert.match(successful(compiler, ['--version']).stdout, /\b6\.0\.6\b/);
  const variables = readFileSync(join(source, 'Makefile'), 'utf8').match(/^PHP_CONFIGURE_VARS=(.*)$/m)?.[1];
  assert.match(variables || '', /EMCC_CFLAGS='-fPIC -flto -O\$\{SUB_OPTIMIZE\} --pre-js \/src\/source\/configure-libraries\.js'/);
  assert.doesNotMatch(variables.match(/LDFLAGS='([^']*)'/)?.[1] || '', /pre-js/);

  const libraryDirectory = join(build, 'libraries');
  mkdirSync(libraryDirectory);
  writeFileSync(join(build, 'side.c'), 'int configure_test_dependency(void) { return 42; }\n');
  successful(compiler, ['side.c', '-shared', '-fPIC', '-flto', '-O3', '-sSIDE_MODULE=1',
    '-sWASM_BIGINT=1', '-sASYNCIFY=1', '-sASYNCIFY_IMPORTS=*',
    '-o', join(libraryDirectory, 'libconfigure-probe.so')]);

  // PHP 8.3's fileinfo configure probe exercises this libc behavior. If startup
  // fails first, configure incorrectly adds its own conflicting strcasestr.
  writeFileSync(join(build, 'probe.c'), `
#include <string.h>
#include <strings.h>
#include <stdlib.h>
int main(void) {
  char *s0 = malloc(42), *s1 = malloc(8);
  memset(s0, 'X', 42); s0[24] = 'Y'; s0[26] = 'Z'; s0[41] = '\\0';
  memset(s1, 'x', 8); s1[0] = 'y'; s1[2] = 'Z'; s1[7] = '\\0';
  int found = strcasestr(s0, s1) != NULL;
  free(s0); free(s1);
  return !found;
}
`);
  const probeArguments = ['-o', 'conftest', '-g', '-O2', '-D_GNU_SOURCE', '-sASYNCIFY=1',
    `-L${libraryDirectory}`, 'probe.c', '-lconfigure-probe'];
  successful(compiler, probeArguments, { EMMAKEN_JUST_CONFIGURE: '1', EMCC_CFLAGS: '-fPIC -flto -O3' });
  const missingLibrary = run(process.execPath, ['conftest']);
  assert.equal(missingLibrary.error, undefined);
  assert.notEqual(missingLibrary.status, 0, 'Unresolved side libraries must fail the negative control');
  assert.match(missingLibrary.stderr, /ENOENT.*libconfigure-probe\.so/);

  successful(compiler, probeArguments, {
    EMMAKEN_JUST_CONFIGURE: '1',
    EMCC_CFLAGS: `-fPIC -flto -O3 --pre-js ${JSON.stringify(join(source, 'source/configure-libraries.js'))}`,
  });
  successful(process.execPath, ['conftest'], { PHP_WASM_CONFIGURE_LIBRARY_DIR: libraryDirectory });

  // The ordinary MAIN_MODULE link must use libc's implementation and its
  // normal loader, without inheriting configure's host filesystem resolver.
  successful(compiler, ['probe.c', '-D_GNU_SOURCE', '-O3', '-flto', '-fPIC',
    '-sMAIN_MODULE=1', '-sWASM_BIGINT=1', '-sASYNCIFY=1', '-sASSERTIONS=1',
    '-sENVIRONMENT=node', '-o', 'runtime.js']);
  assert.doesNotMatch(readFileSync(join(build, 'runtime.js'), 'utf8'), /PHP_WASM_CONFIGURE_LIBRARY_DIR/);
  successful(process.execPath, ['runtime.js']);
});
