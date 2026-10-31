#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { fixtureDefinitions, supportedVersions, runtimeIdentityEnvironment } from './browser-common.mjs';

const version = process.argv[2] || process.env.PHP_VERSION;
assert.ok(supportedVersions.includes(version), 'Usage: node tests/browser-test.mjs <8.3|8.4|8.5> [distribution-directory]');
const directory = resolve(process.argv[3] || `dist/php-${version}`);
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
assert.equal(manifest.php?.minor, version, 'Runtime manifest PHP minor mismatch');
const expectedVersion = manifest.php?.version;
runtimeIdentityEnvironment(version, expectedVersion);
const testsDirectory = fileURLToPath(new URL('./', import.meta.url));
const fixtures = await Promise.all(fixtureDefinitions.map(async definition => ({
  ...definition, source: await readFile(new URL(definition.path, import.meta.url), 'utf8'),
})));
const errors = [];
const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.so': 'application/wasm', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><head><title>PHP int64 validation</title><link rel="icon" href="data:,"></head><body>PHP int64 validation</body></html>');
    return;
  }
  const route = pathname.startsWith('/packages/')
    ? { base: resolve(directory, 'packages'), relative: pathname.slice('/packages/'.length) }
    : pathname.startsWith('/tests/')
      ? { base: testsDirectory, relative: pathname.slice('/tests/'.length) }
      : null;
  if (!route) { response.writeHead(404); response.end(); return; }
  const filename = resolve(route.base, route.relative);
  if (!filename.startsWith(`${resolve(route.base)}${sep}`)) { response.writeHead(403); response.end(); return; }
  try {
    const information = await stat(filename);
    if (!information.isFile()) throw new Error('Not a file');
    response.setHeader('Content-Type', types[extname(filename)] || 'application/octet-stream');
    response.setHeader('Content-Length', information.size);
    createReadStream(filename).on('error', error => response.destroy(error)).pipe(response);
  } catch (error) {
    errors.push(`${pathname}: ${error.message}`);
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
const origin = `http://127.0.0.1:${server.address().port}`;

async function deadline(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 180000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  for (const [name, factory] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await factory.launch({ headless: true });
    try {
      for (const kind of ['web', 'worker', 'cgi-worker']) {
        // An independent browser context prevents one PHP heap, IndexedDB store,
        // or Web Lock from hiding a failure in another runtime entrypoint.
        const context = await browser.newContext();
        const diagnostics = [];
        try {
          const page = await context.newPage();
          page.on('pageerror', error => diagnostics.push(error.stack || error.message));
          page.on('console', event => {
            if (event.type() === 'error') diagnostics.push(event.text());
          });
          page.on('requestfailed', request => diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`));
          await page.goto(origin);
          const result = await deadline(page.evaluate(async ({ kind, version, expectedVersion, fixtures }) => {
            if (kind === 'web') {
              const { runBrowserRuntime } = await import('/tests/browser-harness.mjs');
              return runBrowserRuntime(kind, version, expectedVersion, fixtures);
            }
            return new Promise((resolvePromise, reject) => {
              const worker = new Worker('/tests/browser-worker.mjs', { type: 'module' });
              worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
              worker.onmessage = event => {
                worker.terminate();
                if (event.data.error) reject(new Error(event.data.error.stack || event.data.error.message));
                else resolvePromise(event.data.result);
              };
              worker.postMessage({ kind, version, expectedVersion, fixtures });
            });
          }, { kind, version, expectedVersion, fixtures }), `${name}/${kind}/PHP${version} timed out: ${diagnostics.join('\n')}`);
          assert.equal(result.passed, true);
          assert.deepEqual(diagnostics, [], `Browser errors in ${name}/${kind}`);
          assert.deepEqual(errors, [], 'Missing browser artifacts');
          console.log(JSON.stringify({ browser: name, ...result }));
        } catch (error) {
          throw new Error(`${name}/${kind}/PHP${version}: ${error.stack || error}\nBrowser diagnostics:\n${diagnostics.join('\n')}\nHTTP diagnostics:\n${errors.join('\n')}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolvePromise => server.close(resolvePromise));
}
