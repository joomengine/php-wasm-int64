#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installBridgeFixtures } from './bridge/fixtures.mjs';
import { validateEmbeddedStatus } from './runtime-status.mjs';
import { verifyCliStatus, verifyCgiStatus } from './sapi-status.mjs';
import { verifyPhpDbgBatchStatus } from './phpdbg-status.mjs';
import {
  supportedVersions, fixtureDefinitions, runtimeIni, loadExtensions,
  captureOutput, checkFixtureResult, mountFixtures, runtimeIdentityEnvironment,
} from './browser-common.mjs';

const version = process.argv[2] || process.env.PHP_VERSION;
assert.ok(supportedVersions.includes(version), 'Usage: node tests/run-runtime.mjs <8.3|8.4|8.5> [distribution-directory]');
const directory = resolve(process.argv[3] || `dist/php-${version}`);
const buildSmoke = process.argv[4] === '--build-smoke';
let expectedVersion;
if (buildSmoke) {
  // The build driver supplies its pinned version before a distribution exists.
  // Normal archive validation always requires the extracted manifest below.
  expectedVersion = process.argv[5];
} else {
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  assert.equal(manifest.php?.minor, version, 'Runtime manifest PHP minor mismatch');
  expectedVersion = manifest.php?.version;
}
const identityEnvironment = runtimeIdentityEnvironment(version, expectedVersion);
const kind = buildSmoke ? 'embedded' : process.argv[4];
const childMode = buildSmoke ? process.argv[6] === '--child' : Boolean(kind);
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
  const failures = [];
  const record = async (fixture, operation) => {
    try {
      await operation();
      console.log(JSON.stringify({ php: expectedVersion, runtime: runtimeKind, fixture: fixture.path, passed: true }));
      return true;
    } catch (cause) {
      failures.push(new Error(`${runtimeKind}: ${fixture.path}`, { cause }));
      return false;
    }
  };
  installBridgeFixtures(globalThis);
  const sharedLibs = await loadExtensions(packagesURL, version);
  const options = { version, sharedLibs, ini: runtimeIni, autoTransaction: false, ...identityEnvironment };
  if (runtimeKind === 'embedded') {
    const { PhpNode } = await import(new URL('php-wasm/PhpNode.mjs', packagesURL));
    let php, output;
    for (const fixture of fixtures) {
      const passed = await record(fixture, async () => {
        if (!php) {
          php = new PhpNode(options);
          output = captureOutput(php);
          await php.binary;
        }
        output.clear();
        const status = await php.run(fixture.source);
        await php.flush();
        assert.equal(status, 0, JSON.stringify(output.read()));
        const { stdout, stderr } = output.read();
        checkFixtureResult(fixture, stdout, stderr);
      });
      // Preserve successful lifecycle reuse, but isolate later fixtures from a
      // failed interpreter so one defect cannot conceal independent failures.
      if (!passed) php = output = undefined;
    }
    await record({ path: 'runtime-status.mjs' }, () => validateEmbeddedStatus(() => new PhpNode(options)));
  } else if (runtimeKind === 'cli') {
    const { PhpCliNode } = await import(new URL('php-cli-wasm/PhpCliNode.mjs', packagesURL));
    // Each CLI request owns a fresh interpreter lifecycle.
    for (const fixture of fixtures) {
      await record(fixture, async () => {
        const php = new PhpCliNode({ ...options, script: '/int64-tests/0.php' });
        const output = captureOutput(php);
        mountFixtures(await php.binary, [fixture]);
        const status = await php.run();
        await php.flush();
        assert.equal(status, 0, JSON.stringify(output.read()));
        const { stdout, stderr } = output.read();
        checkFixtureResult(fixture, stdout, stderr);
      });
    }
    await record({ path: 'sapi-status.mjs (CLI)' }, () => verifyCliStatus(extra => new PhpCliNode({ ...options, ...extra })));
  } else if (runtimeKind === 'cgi') {
    const { PhpCgiNode } = await import(new URL('php-cgi-wasm/PhpCgiNode.mjs', packagesURL));
    let php;
    // Repeat each request to catch lifecycle/reuse and extension-shutdown failures.
    for (let pass = 0; pass < 2; pass++) {
      for (const [index, fixture] of fixtures.entries()) {
        const passed = await record({ path: `${fixture.path} (request pass ${pass + 1})` }, async () => {
          if (!php) {
            php = new PhpCgiNode({ ...options, prefix: '/', docroot: '/int64-tests', persist: [] });
            const binary = await php.binary;
            // The cookie jar needs an ephemeral directory when persistence is disabled.
            binary.FS.mkdirTree('/config');
            mountFixtures(binary, fixtures);
          }
          // PhpCgiNode builds the origin from headers, as with Node's IncomingMessage.
          const response = await php.request({ url: `/${index}.php`, method: 'GET', headers: { host: 'localhost' } });
          assert.ok(response instanceof Response, `${fixture.path}: missing CGI response`);
          const text = await response.text();
          assert.equal(response.status, 200, text);
          checkFixtureResult(fixture, text, new TextDecoder().decode(Uint8Array.from(php.error)));
        });
        if (!passed) php = undefined;
      }
    }
    await record({ path: 'sapi-status.mjs (CGI)' }, () => verifyCgiStatus(
      extra => new PhpCgiNode({ ...options, ...extra }),
      (runtime, path) => runtime.request({ url: path, method: 'GET', headers: { host: 'localhost' } }),
      { nodeAccessLog: true },
    ));
  } else if (runtimeKind === 'debugger') {
    const { PhpDbgNode } = await import(new URL('php-dbg-wasm/PhpDbgNode.mjs', packagesURL));
    await record({ path: 'interactive debugger session' }, async () => {
      const php = new PhpDbgNode(options);
      const output = captureOutput(php);
      const binary = await php.binary;
      mountFixtures(binary, fixtures);
      const source = [
        '<?php', '$maximum = PHP_INT_MAX;', '$minimum = PHP_INT_MIN;', '$large = 4294967296;',
        'echo "int64-debug-break\\n";',
        ...fixtures.map((_, index) => `try { require '/int64-tests/${index}.php'; } catch (\\Throwable $error) { echo 'int64-debugger-fixture-error:' . json_encode([${index}, (string) $error]) . "\\n"; }`),
        'echo "int64-debugger-ok\\n";',
      ].join('\n');
      binary.FS.writeFile('/int64-tests/debug.php', source, { encoding: 'utf8' });
      const processPromise = php.run();
      // Observe early startup rejection while prompt checks are running; the
      // original promise is still awaited and asserted after the session.
      processPromise.catch(() => {});
      await waitFor(async () => /prompt>/i.test(await php.getPrompt()), 'debugger boot', output);
      await php.provideInput('set pagination off');
      await php.provideInput('exec /int64-tests/debug.php');
      await waitFor(() => output.read().stdout.includes('[Successful compilation of /int64-tests/debug.php]'), 'debugger compilation', output);
      await php.provideInput('break /int64-tests/debug.php:5');
      await php.provideInput('run');
      await waitFor(async () => (await php.isExecuting()) && (await php.currentLine()) === 5 && (await php.bpCount()) === 1, 'int64 breakpoint', output);
      const symbols = await php.dumpVars();
      await record({ path: 'int64 breakpoint variables' }, async () => {
        assert.equal(symbols.maximum, 9223372036854775807n, 'Debugger must preserve PHP_INT_MAX exactly');
        assert.equal(symbols.minimum, -9223372036854775808n, 'Debugger must preserve PHP_INT_MIN exactly');
        assert.equal(symbols.large, 4294967296, 'Debugger must preserve safe JS integers as Number');
      });
      await php.provideInput('continue');
      await waitFor(() => output.read().stdout.includes('int64-debugger-ok'), 'debugger completion', output);
      const fixtureErrors = output.read().stdout.split('\n')
        .filter(line => line.startsWith('int64-debugger-fixture-error:'))
        .map(line => JSON.parse(line.slice('int64-debugger-fixture-error:'.length)));
      for (const [index, fixture] of fixtures.entries()) {
        await record(fixture, async () => {
          const failure = fixtureErrors.find(([failedIndex]) => failedIndex === index);
          assert.equal(failure, undefined, failure?.[1]);
          assert.ok(output.read().stdout.includes(fixture.marker), `Debugger did not finish ${fixture.path}`);
        });
      }
      await record({ path: 'debugger diagnostics' }, async () => assert.equal(output.read().stderr, ''));
      await php.provideInput('quit');
      const exitCode = await processPromise.catch(error => {
        if (typeof error?.status === 'number') return error.status;
        throw error;
      });
      assert.equal(exitCode, 0);
    });
    await record({ path: 'phpdbg-status.mjs' }, () => verifyPhpDbgBatchStatus(extra => new PhpDbgNode({ ...options, ...extra })));
  } else {
    throw new Error(`Unknown runtime kind: ${runtimeKind}`);
  }
  if (failures.length) throw new AggregateError(failures, `PHP ${expectedVersion} ${runtimeKind}: ${failures.length} validation failure(s)`);
  console.log(JSON.stringify({ mode: buildSmoke ? 'build-smoke' : 'archive', php: expectedVersion, runtime: runtimeKind, passed: true }));
}

if (childMode) {
  try {
    await validate(kind);
    // Each SAPI lives in a dedicated test process; Emscripten has no universal dispose API.
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else {
  const failures = [];
  for (const runtimeKind of buildSmoke ? ['embedded'] : ['embedded', 'cli', 'cgi', 'debugger']) {
    try {
      await new Promise((resolvePromise, reject) => {
        const arguments_ = buildSmoke
          ? [fileURLToPath(import.meta.url), version, directory, '--build-smoke', expectedVersion, '--child']
          : [fileURLToPath(import.meta.url), version, directory, runtimeKind];
        const child = spawn(process.execPath, arguments_, {
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
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, `PHP ${expectedVersion}: ${failures.length} runtime(s) failed`);
}
