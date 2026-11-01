import { installBridgeFixtures } from './bridge/fixtures.mjs';
import { validateEmbeddedStatus } from './runtime-status.mjs';
import { verifyCgiStatus } from './sapi-status.mjs';
import { describeBrowserError } from './browser-errors.mjs';
import {
  runtimeIni, loadExtensions, captureOutput, check, checkFixtureResult, mountFixtures, runtimeIdentityEnvironment,
} from './browser-common.mjs';

export async function runBrowserRuntime(kind, version, expectedVersion, fixtures) {
  installBridgeFixtures(globalThis);
  const packagesURL = new URL('/packages/', globalThis.location.href);
  const sharedLibs = await loadExtensions(packagesURL, version);
  const options = { version, sharedLibs, ini: runtimeIni, autoTransaction: false, persist: [],
    ...runtimeIdentityEnvironment(version, expectedVersion) };
  const results = [];
  const exercise = async (fixture, pass, operation) => {
    try {
      await operation();
      results.push({ fixture: fixture.path, pass, passed: true });
      return true;
    } catch (error) {
      results.push({ fixture: fixture.path, pass, passed: false, error: describeBrowserError(error) });
      return false;
    }
  };
  if (kind === 'cgi-worker') {
    const { PhpCgiWorker } = await import(new URL('php-cgi-wasm/PhpCgiWorker.mjs', packagesURL));
    let php;
    for (let pass = 0; pass < 2; pass++) {
      for (const [index, fixture] of fixtures.entries()) {
        const passed = await exercise(fixture, pass + 1, async () => {
          if (!php) {
            php = new PhpCgiWorker({ ...options, prefix: '/', docroot: '/int64-tests', staticFS: true });
            const binary = await php.binary;
            // With persistence disabled, the CGI cookie jar still needs an ephemeral directory.
            binary.FS.mkdirTree('/config');
            mountFixtures(binary, fixtures);
          }
          const response = await php.request({
            url: new URL(`/${index}.php`, globalThis.location.href).href,
            method: 'GET', headers: { host: globalThis.location.host },
          });
          check(response instanceof Response, `${fixture.path}: missing CGI response`);
          const text = await response.text();
          check(response.status === 200, `${fixture.path}: HTTP ${response.status}: ${text}`);
          checkFixtureResult(fixture, text, new TextDecoder().decode(Uint8Array.from(php.error)));
        });
        // Successful requests keep exercising reuse. A failed instance must not
        // prevent independent fixtures from reporting their own result.
        if (!passed) php = undefined;
      }
    }
    await exercise({ path: 'sapi-status.mjs' }, 1, () => verifyCgiStatus(
      extra => new PhpCgiWorker({ ...options, staticFS: true, ...extra }),
      (runtime, path) => runtime.request({
        url: new URL(path, globalThis.location.href).href,
        method: 'GET', headers: { host: globalThis.location.host },
      }),
    ));
  } else {
    check(kind === 'web' || kind === 'worker', `Unsupported browser runtime: ${kind}`);
    const wrapper = kind === 'web' ? 'PhpWeb' : 'PhpWorker';
    const module = await import(new URL(`php-wasm/${wrapper}.mjs`, packagesURL));
    let php, output;
    for (const fixture of fixtures) {
      const passed = await exercise(fixture, 1, async () => {
        if (!php) {
          php = new module[wrapper](options);
          output = captureOutput(php);
          await php.binary;
        }
        output.clear();
        const status = await php.run(fixture.source);
        await php.flush();
        check(status === 0, `${fixture.path}: PHP exit status ${status}: ${JSON.stringify(output.read())}`);
        const { stdout, stderr } = output.read();
        checkFixtureResult(fixture, stdout, stderr);
      });
      if (!passed) php = undefined;
    }
    await exercise({ path: 'runtime-status.mjs' }, 1, () =>
      validateEmbeddedStatus(() => new module[wrapper](options)));
  }
  return { php: expectedVersion, runtime: kind, passed: results.every(result => result.passed), results };
}
