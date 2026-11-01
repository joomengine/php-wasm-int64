import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('compiled cache keys cover legal payloads while allowing test-only reruns', t => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), 'php-fingerprint-contract-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const path of ['versions.json', 'VERSION', 'LICENSE', 'NOTICE', 'config', 'patches', 'scripts']) {
    cpSync(join(repository, path), join(fixture, path), { recursive: true });
  }
  const fingerprint = () => execFileSync('bash', ['-euo', 'pipefail', '-c',
    'source "$1/scripts/common.sh"; select_php 8.5; printf "%s" "$BUILD_FINGERPRINT"',
    'fingerprint-contract', fixture], { encoding: 'utf8', env: { ...process.env, BASH_ENV: '' } });
  const original = fingerprint();
  assert.match(original, /^[a-f0-9]{64}$/);
  for (const name of ['LICENSE', 'NOTICE']) {
    const path = join(fixture, name);
    const contents = readFileSync(path);
    appendFileSync(path, '\nLegal payload changed.\n');
    assert.notEqual(fingerprint(), original, `${name} must invalidate the cached archive`);
    writeFileSync(path, contents);
    assert.equal(fingerprint(), original);
  }
  mkdirSync(join(fixture, 'tests'));
  writeFileSync(join(fixture, 'tests', 'new-runtime-check.mjs'), '// New runtime coverage.\n');
  appendFileSync(join(fixture, 'scripts', 'check.sh'), '\n# New source validation.\n');
  appendFileSync(join(fixture, 'scripts', 'verify-artifact.mjs'), '\n// New archive validation.\n');
  assert.equal(fingerprint(), original, 'Validation-only changes must reuse compiled bytes and rerun tests');
});
