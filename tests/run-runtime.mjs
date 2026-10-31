#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installBridgeFixtures } from './bridge/fixtures.mjs';
import {
  supportedVersions, fixtureDefinitions, runtimeIni, loadExtensions,
  captureOutput, checkFixtureResult, mountFixtures, runtimeIdentityEnvironment,
} from './browser-common.mjs';

const version = process.argv[2] || process.env.PHP_VERSION;
assert.ok(supportedVersions.includes(version), 'Usage: node tests/run-runtime.mjs <8.3|8.4|8.5> [distribution-directory]');
const directory = resolve(process.argv[3] || `dist/php-${version}`);
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
assert.equal(manifest.php?.minor, version, 'Runtime manifest PHP minor mismatch');
const identityEnvironment = runtimeIdentityEnvironment(version, manifest.php?.version);
const kind = process.argv[4];
const packagesURL = pathToFileURL(`${directory}/packages/`);
const fixtures = await Promise.all(fixtureDefinitions.map(async definition => ({
  ...definition, source: await readFile(new URL(definition.path, import.meta.url), 'utf8'),
})));

async function waitFor(check, label, output, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(output.read())}`);
}

async function validate(runtimeKind) {
  installBridgeFixtures(globalThis);
  const sharedLibs = await loadExtensions(packagesURL, version);
  const options = { version, sharedLibs, ini: runtimeIni, autoTransaction: false, ...identityEnvironment };
  if (runtimeKind === 'embedded') {
    const { PhpNode } = await import(new URL('php-wasm/PhpNode.mjs', packagesURL));
    const php = new PhpNode(options);
    const output = captureOutput(php);
    await php.binary;
    for (const fixture of fixtures) {
      output.clear();
      const status = await php.run(fixture.source);
      await php.flush();
      assert.equal(status, 0, JSON.stringify(output.read()));
      const { stdout, stderr } = output.read();
      checkFixtureResult(fixture, stdout, stderr);
    }
  } else if (runtimeKind === 'cli') {
    const { PhpCliNode } = await import(new URL('php-cli-wasm/PhpCliNode.mjs', packagesURL));
    // Each CLI request owns a fresh interpreter lifecycle.
    for (const fixture of fixtures) {
      const php = new PhpCliNode({ ...options, script: '/int64-tests/0.php' });
      const output = captureOutput(php);
      mountFixtures(await php.binary, [fixture]);
      const status = await php.run();
      await php.flush();
      assert.equal(status, 0, JSON.stringify(output.read()));
      const { stdout, stderr } = output.read();
      checkFixtureResult(fixture, stdout, stderr);
    }
  } else if (runtimeKind === 'cgi') {
    const { PhpCgiNode } = await import(new URL('php-cgi-wasm/PhpCgiNode.mjs', packagesURL));
    const php = new PhpCgiNode({ ...options, prefix: '/', docroot: '/int64-tests', persist: [] });
    mountFixtures(await php.binary, fixtures);
    // Repeat each request to catch lifecycle/reuse and extension-shutdown failures.
    for (let pass = 0; pass < 2; pass++) {
      for (const [index, fixture] of fixtures.entries()) {
        const response = await php.request({ url: `http://localhost/${index}.php`, method: 'GET', headers: { host: 'localhost' } });
        assert.ok(response instanceof Response, `${fixture.path}: missing CGI response`);
        const text = await response.text();
        assert.equal(response.status, 200, text);
        checkFixtureResult(fixture, text, new TextDecoder().decode(Uint8Array.from(php.error)));
      }
    }
  } else if (runtimeKind === 'debugger') {
    const { PhpDbgNode } = await import(new URL('php-dbg-wasm/PhpDbgNode.mjs', packagesURL));
    const php = new PhpDbgNode(options);
    const output = captureOutput(php);
    const binary = await php.binary;
    mountFixtures(binary, fixtures);
    const source = [
      '<?php', '$maximum = PHP_INT_MAX;', '$minimum = PHP_INT_MIN;', '$large = 4294967296;',
      'echo "int64-debug-break\\n";',
      ...fixtures.map((_, index) => `require '/int64-tests/${index}.php';`),
      'echo "int64-debugger-ok\\n";',
    ].join('\n');
    binary.FS.writeFile('/int64-tests/debug.php', source, { encoding: 'utf8' });
    const processPromise = php.run();
    await waitFor(async () => /prompt>/i.test(await php.getPrompt()), 'debugger boot', output);
    await php.provideInput('set pagination off');
    await php.provideInput('exec /int64-tests/debug.php');
    await waitFor(() => output.read().stdout.includes('[Successful compilation of /int64-tests/debug.php]'), 'debugger compilation', output);
    await php.provideInput('break /int64-tests/debug.php:5');
    await php.provideInput('run');
    await waitFor(async () => (await php.isExecuting()) && (await php.currentLine()) === 5 && (await php.bpCount()) === 1, 'int64 breakpoint', output);
    const symbols = await php.dumpVars();
    assert.equal(symbols.maximum, 9223372036854775807n, 'Debugger must preserve PHP_INT_MAX exactly');
    assert.equal(symbols.minimum, -9223372036854775808n, 'Debugger must preserve PHP_INT_MIN exactly');
    assert.equal(symbols.large, 4294967296, 'Debugger must preserve safe JS integers as Number');
    await php.provideInput('continue');
    await waitFor(() => output.read().stdout.includes('int64-debugger-ok'), 'debugger completion', output);
    for (const fixture of fixtures) assert.ok(output.read().stdout.includes(fixture.marker), `Debugger did not finish ${fixture.path}`);
    assert.equal(output.read().stderr, '');
    await php.provideInput('quit');
    const exitCode = await processPromise.catch(error => {
      if (typeof error?.status === 'number') return error.status;
      throw error;
    });
    assert.equal(exitCode, 0);
  } else {
    throw new Error(`Unknown runtime kind: ${runtimeKind}`);
  }
  console.log(JSON.stringify({ php: manifest.php.version, runtime: runtimeKind, passed: true }));
}

if (kind) {
  try {
    await validate(kind);
    // Each SAPI lives in a dedicated test process; Emscripten has no universal dispose API.
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else {
  for (const runtimeKind of ['embedded', 'cli', 'cgi', 'debugger']) {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), version, directory, runtimeKind], {
        stdio: 'inherit', env: { ...process.env, PHP_VERSION: version },
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`PHP ${version} ${runtimeKind} exceeded the 180 second runtime deadline`));
      }, 180000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else reject(new Error(`PHP ${version} ${runtimeKind} failed (code=${code}, signal=${signal})`));
      });
    });
  }
}
