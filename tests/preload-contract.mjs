import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

if (!process.env.UPSTREAM_SOURCE_ROOT) {
  throw new Error('Set UPSTREAM_SOURCE_ROOT to the pinned, patched php-wasm directory.');
}
const sourceURL = pathToFileURL(`${resolve(process.env.UPSTREAM_SOURCE_ROOT, 'source')}/`);
const constructors = await Promise.all(['PhpBase', 'PhpCgiBase', 'PhpCgiWebBase'].map(async name => {
  const module = await import(new URL(`${name}.mjs`, sourceURL));
  return [name, module[name]];
}));

function runtime(Wrapper) {
  const requested = Promise.withResolvers();
  const calls = [];
  const directories = new Set(['/']);
  const files = new Map();
  const binary = {
    FS: {
      analyzePath: path => ({ exists: directories.has(path) || files.has(path) }),
      mkdir: path => directories.add(path),
      writeFile: (path, value) => files.set(path, value),
      syncfs: (_, done) => done(null),
      // Emscripten 6.0.6's legacy API returns void. Completion is callback-only,
      // and adding run dependencies here cannot delay an already-resolved factory.
      createPreloadedFile(parent, name, url, canRead, canWrite, onload, onerror) {
        requested.resolve({
          parent, name, url, onload, onerror,
          complete() {
            files.set(`${parent}${name}`, new Uint8Array([1, 2, 3]));
            onload();
          },
        });
      },
    },
    ccall: name => { calls.push(name); return 0; },
  };
  // The factory is resolved before the wrapper starts preloading, as in real builds.
  const php = new Wrapper(Promise.resolve({ default: () => Promise.resolve(binary) }), {
    version: '8.4', persist: [], autoTransaction: false,
    files: [{ parent: '/preload/', name: 'fixture.dat', url: 'https://example.invalid/fixture.dat' }],
  });
  let settled = false;
  php.binary.then(() => { settled = true; }, () => { settled = true; });
  return { php, binary, requested: requested.promise, calls, files, settled: () => settled };
}

for (const [name, Wrapper] of constructors) {
  test(`${name} waits for delayed preload completion before initializing PHP`, { timeout: 5000 }, async () => {
    const state = runtime(Wrapper);
    const request = await state.requested;
    // Drain the event-loop turn while withholding the completion callback.
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    assert.equal(state.settled(), false, 'Runtime became ready before its data file arrived');
    assert.deepEqual(state.calls, ['pib_storage_init'], 'PHP initialization raced the data download');
    assert.equal(typeof request.onload, 'function');
    request.complete();
    assert.equal(await state.php.binary, state.binary);
    assert.ok(state.files.has('/preload/fixture.dat'));
    assert.ok(state.calls.includes(name === 'PhpBase' ? 'pib_init' : 'wasm_sapi_cgi_init'));
  });

  test(`${name} rejects initialization when a preload fails`, { timeout: 5000 }, async () => {
    const state = runtime(Wrapper);
    const request = await state.requested;
    assert.equal(typeof request.onerror, 'function', 'Preload errors must settle the runtime promise');
    const failure = new Error('Preload download failed');
    request.onerror(failure);
    await assert.rejects(state.php.binary, error => error === failure);
    assert.deepEqual(state.calls, ['pib_storage_init']);
  });
}
