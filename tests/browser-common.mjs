// Shared by the Node and real-browser harnesses; no Node-only dependencies.
export const supportedVersions = Object.freeze(['8.3', '8.4', '8.5']);
export const extensionPackages = Object.freeze([
  'libxml', 'dom', 'zlib', 'libzip', 'gd', 'iconv', 'intl', 'openssl',
  'mbstring', 'phar', 'sqlite', 'xml', 'simplexml', 'xmlreader', 'xmlwriter',
]);
export const fixtureDefinitions = Object.freeze([
  { path: 'php/core.php', marker: 'int64-core-ok\n' },
  { path: 'bridge/int64.php', marker: 'int64-bridge-ok\n' },
  { path: 'browser-extensions.php', marker: 'int64-extensions-ok\n' },
]);
export const runtimeIni = [
  'display_errors=1', 'display_startup_errors=1', 'log_errors=0',
  'error_reporting=E_ALL', 'date.timezone=UTC', 'memory_limit=256M',
  'max_execution_time=30', 'phar.readonly=0',
].join('\n');

export async function loadExtensions(packagesURL, version) {
  if (!supportedVersions.includes(version)) throw new Error(`Unsupported PHP minor: ${version}`);
  const modules = await Promise.all(extensionPackages.map(name => import(new URL(`${name}/${version}.mjs`, packagesURL).href)));
  return modules.map(module => module.default);
}

export function captureOutput(php) {
  let stdout = '';
  let stderr = '';
  php.addEventListener('output', event => { stdout += event.detail.join(''); });
  php.addEventListener('error', event => { stderr += event.detail.join(''); });
  return {
    read: () => ({ stdout, stderr }),
    clear: () => { stdout = ''; stderr = ''; },
  };
}

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function checkFixtureResult(fixture, stdout, stderr = '') {
  check(stdout === fixture.marker, `${fixture.path}: expected ${JSON.stringify(fixture.marker)}, got ${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`);
  check(stderr === '', `${fixture.path} emitted stderr: ${stderr}`);
}

export function mountFixtures(binary, fixtures) {
  binary.FS.mkdirTree('/int64-tests');
  for (const [index, fixture] of fixtures.entries()) {
    binary.FS.writeFile(`/int64-tests/${index}.php`, fixture.source, { encoding: 'utf8' });
  }
}
