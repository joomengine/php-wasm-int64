import { installBridgeFixtures } from './bridge/fixtures.mjs';
import {
  runtimeIni, loadExtensions, captureOutput, check, checkFixtureResult, mountFixtures,
} from './browser-common.mjs';

export async function runBrowserRuntime(kind, version, fixtures) {
  installBridgeFixtures(globalThis);
  const packagesURL = new URL('/packages/', globalThis.location.href);
  const sharedLibs = await loadExtensions(packagesURL, version);
  const options = { version, sharedLibs, ini: runtimeIni, autoTransaction: false, persist: [] };
  if (kind === 'cgi-worker') {
    const { PhpCgiWorker } = await import(new URL('php-cgi-wasm/PhpCgiWorker.mjs', packagesURL));
    const php = new PhpCgiWorker({ ...options, prefix: '/', docroot: '/int64-tests', staticFS: true });
    mountFixtures(await php.binary, fixtures);
    for (let pass = 0; pass < 2; pass++) {
      for (const [index, fixture] of fixtures.entries()) {
        const response = await php.request({
          url: new URL(`/${index}.php`, globalThis.location.href).href,
          method: 'GET', headers: { host: globalThis.location.host },
        });
        check(response instanceof Response, `${fixture.path}: missing CGI response`);
        const text = await response.text();
        check(response.status === 200, `${fixture.path}: HTTP ${response.status}: ${text}`);
        checkFixtureResult(fixture, text, new TextDecoder().decode(Uint8Array.from(php.error)));
      }
    }
  } else {
    check(kind === 'web' || kind === 'worker', `Unsupported browser runtime: ${kind}`);
    const wrapper = kind === 'web' ? 'PhpWeb' : 'PhpWorker';
    const module = await import(new URL(`php-wasm/${wrapper}.mjs`, packagesURL));
    const php = new module[wrapper](options);
    const output = captureOutput(php);
    await php.binary;
    for (const fixture of fixtures) {
      output.clear();
      const status = await php.run(fixture.source);
      await php.flush();
      check(status === 0, `${fixture.path}: PHP exit status ${status}: ${JSON.stringify(output.read())}`);
      const { stdout, stderr } = output.read();
      checkFixtureResult(fixture, stdout, stderr);
    }
  }
  return { php: version, runtime: kind, passed: true };
}
