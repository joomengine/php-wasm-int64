import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const minors = ['8.3', '8.4', '8.5'];
let root, checkout, artifacts, sha, version, fakeBin;

// These tiny valid Wasm modules test archive verification and publication only.
// The production workflow downloads archives that already passed real runtime tests.
function writeArchive(minor, pins, fingerprint, destination, changeManifest = value => value) {
  const directory = join(root, `fixture-${minor}`, `php-${minor}`);
  rmSync(dirname(directory), { recursive: true, force: true });
  const files = {};
  function add(name, contents = '// Release contract fixture.\n') {
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), bytes);
    files[name] = { size: bytes.length, sha256: digest(bytes) };
  }
  for (const [pkg, prefix, environments, wrappers] of [
    ['php-wasm', '', ['web', 'worker', 'webview', 'node'], ['PhpWeb', 'PhpWorker', 'PhpWebview', 'PhpNode']],
    ['php-cgi-wasm', 'cgi-', ['web', 'worker', 'webview', 'node'], ['PhpCgiWeb', 'PhpCgiWorker', 'PhpCgiWebview', 'PhpCgiNode']],
    ['php-cli-wasm', 'cli-', ['web', 'node'], ['PhpCliWeb', 'PhpCliNode']],
    ['php-dbg-wasm', 'dbg-', ['web', 'node'], ['PhpDbgWeb', 'PhpDbgNode']],
  ]) {
    for (const wrapper of wrappers) add(`packages/${pkg}/${wrapper}.mjs`);
    for (const environment of environments) {
      add(`packages/${pkg}/php${minor}-${prefix}${environment}.mjs`);
      add(`packages/${pkg}/php${minor}-${prefix}${environment}.mjs.wasm`, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    }
  }
  for (const extension of ['libxml', 'dom', 'zlib', 'libzip', 'gd', 'iconv', 'intl', 'openssl', 'mbstring', 'phar', 'sqlite', 'xml', 'simplexml', 'xmlreader', 'xmlwriter']) {
    add(`packages/${extension}/${extension === 'libxml' ? 'index' : minor}.mjs`);
  }
  add('include/Zend/zend_long.h');
  add('LICENSE', readFileSync(join(checkout, 'LICENSE')));
  add('NOTICE', readFileSync(join(checkout, 'NOTICE')));
  const manifest = {
    schemaVersion: 1, version, fingerprint, build: { fingerprint },
    php: pins.php.find(php => php.minor === minor), abi: pins.abi,
    upstream: pins.upstream, vrzno: pins.vrzno, emscripten: pins.emscripten,
    patches: ['php', 'runtime', 'bridge'].map(path => ({ path, sha256: digest(path) })), files,
  };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(changeManifest(manifest)));
  const filename = `php-wasm-int64-${version}-php${minor}.tar.gz`;
  execFileSync('tar', ['-czf', join(destination, filename), '-C', dirname(directory), `php-${minor}`]);
  writeFileSync(join(destination, `${filename}.sha256`), `${digest(readFileSync(join(destination, filename)))}  ${filename}\n`);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'php-int64-release-contract-'));
  checkout = join(root, 'checkout');
  artifacts = join(root, 'artifacts');
  fakeBin = join(root, 'bin');
  for (const directory of [checkout, artifacts, fakeBin]) mkdirSync(directory);
  mkdirSync(join(checkout, '.github'));
  for (const filename of ['.github/scripts', 'scripts', 'config', 'patches', 'versions.json', 'VERSION', 'LICENSE', 'NOTICE']) {
    cpSync(join(source, filename), join(checkout, filename), { recursive: true });
  }
  const git = args => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  git(['add', '.']);
  git(['-c', 'user.name=Release contract', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture inputs']);
  sha = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', sha]);
  version = readFileSync(join(checkout, 'VERSION'), 'utf8').trim();
  git(['tag', `v${version}`, sha]);
  const pins = JSON.parse(readFileSync(join(checkout, 'versions.json'), 'utf8'));
  for (const minor of minors) {
    const fingerprint = execFileSync('bash', ['-c', 'source "$1/scripts/common.sh"; select_php "$2"; printf "%s" "$BUILD_FINGERPRINT"', 'fingerprint', checkout, minor], { encoding: 'utf8', env: { ...process.env, BASH_ENV: '' } });
    writeArchive(minor, pins, fingerprint, artifacts);
  }
  writeFileSync(join(fakeBin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE_PATH, 'utf8'));
fs.appendFileSync(process.env.GH_CALLS_PATH, JSON.stringify(args) + '\\n');
const save = () => fs.writeFileSync(process.env.GH_STATE_PATH, JSON.stringify(state));
const fail = () => { console.error('Simulated GitHub API failure'); process.exit(1); };
const value = flag => args[args.indexOf(flag) + 1];
const output = value => console.log(JSON.stringify(value));
if (args[0] === 'api') {
  const endpoint = args.find(argument => argument.startsWith('repos/'));
  if (endpoint.endsWith('/releases') && value('--method') === 'POST') {
    if (state.release || !state.tag || state.failAt === 'create') fail();
    const input = JSON.parse(fs.readFileSync(value('--input'), 'utf8'));
    const target = state.annotated ? state.annotatedTarget : state.tag;
    if (!input.draft || input.tag_name !== 'v${version}' || input.target_commitish !== target) fail();
    state.release = { id: 1901, tag_name: input.tag_name, draft: true, target_commitish: input.target_commitish, assets: [] };
    state.notes = input.body;
    save();
    output({ ...state.release, ...state.createOverride });
  } else if (endpoint.includes('/releases?')) {
    if (state.failAt === 'releases') fail();
    const release = state.staleCollection ? state.collectionRelease : state.release;
    output([release ? [release] : []]);
  } else if (endpoint.endsWith('/releases/1901')) {
    if (!state.release || state.failAt === 'release') fail();
    output({ ...state.release, ...state.readOverride });
  } else if (endpoint.includes('/git/matching-refs/')) {
    if (state.failAt === 'tag') fail();
    output(state.tag ? [{ ref: 'refs/tags/v${version}', object: { type: state.annotated ? 'tag' : 'commit', sha: state.tag } }] : []);
  } else if (endpoint.includes('/git/tags/')) {
    if (state.failAt === 'annotated') fail();
    output({ object: { type: 'commit', sha: state.annotatedTarget } });
  } else fail();
} else if (args[0] === 'release' && args[1] === 'upload') {
  if (!state.release?.draft || !args.includes('--clobber')) fail();
  let names = args.slice(3, args.indexOf('--repo')).map(file => path.basename(file));
  if (state.failAt === 'upload' || state.failAt === 'incomplete') names = names.slice(0, 1);
  state.release.assets = [...state.release.assets.filter(asset => !names.includes(asset.name)), ...names.map(name => ({ name }))];
  save();
  if (state.failAt === 'upload') fail();
} else if (args[0] === 'release' && args[1] === 'edit') {
  if (!state.release?.draft || !args.includes('--draft=false')) fail();
  state.release.draft = false;
  save();
} else fail();
`, { mode: 0o755 });
});

after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function scenario(initial = {}) {
  const directory = mkdtempSync(join(root, 'scenario-'));
  const statePath = join(directory, 'state.json');
  const callsPath = join(directory, 'calls.jsonl');
  writeFileSync(statePath, JSON.stringify({ tag: sha, collectionRelease: initial.release ?? null, ...initial }));
  writeFileSync(callsPath, '');
  return {
    directory,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    update: state => writeFileSync(statePath, JSON.stringify(state)),
    calls: () => readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    run: (directory = artifacts, overrides = {}) => spawnSync('bash', [join(checkout, '.github/scripts/release.sh'), directory], {
      cwd: checkout, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BASH_ENV: '', RUNNER_TEMP: root,
        GH_STATE_PATH: statePath, GH_CALLS_PATH: callsPath, GH_TOKEN: 'fixture-token',
        GITHUB_REPOSITORY: 'joomengine/php-wasm-int64', VALIDATED_SHA: sha,
        GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}`,
        VALIDATION_RUN_ID: '12345', DEFAULT_BRANCH: 'main', ...overrides },
    }),
  };
}
function succeeded(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); }
function rejected(result, message) { assert.notEqual(result.status, 0); assert.match(result.stderr, message); }
function mutations(item) { return item.calls().filter(call => call[0] === 'release' || call[0] === 'api' && call.includes('POST')); }
const mutationType = call => call[0] === 'api' ? 'create' : call[1];
const draft = target => ({ id: 1901, tag_name: `v${version}`, draft: true, target_commitish: target, assets: [] });

test('only explicit version tags release, after identity checks and same-run reusable validation', () => {
  const workflow = readFileSync(join(source, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /on:\s+push:\s+tags: \['v\*\.\*\.\*'\]/);
  assert.match(workflow, /validate:\s+needs: identity\s+uses: \.\/\.github\/workflows\/validate\.yml/);
  assert.match(workflow, /release:\s+name: Publish verified archives\s+needs: \[identity, validate\]/);
  assert.ok(workflow.includes('test "$GITHUB_REF_NAME" = "v$(cat VERSION)"'));
  assert.ok(workflow.includes('git merge-base --is-ancestor HEAD "refs/remotes/origin/$DEFAULT_BRANCH"'));
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /commit: \$\{\{ steps\.tag\.outputs\.commit \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.identity\.outputs\.commit \}\}/);
  assert.match(workflow, /VALIDATED_SHA: \$\{\{ needs\.identity\.outputs\.commit \}\}/);
  assert.match(workflow, /VALIDATION_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /pattern: int64-php-\*/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|workflow_run:|branches:|run-id:/);
});

test('the workflow identity job rejects a wrong version tag or branch before validation', () => {
  const lines = readFileSync(join(source, '.github/workflows/release.yml'), 'utf8').split('\n');
  const start = lines.findIndex(line => line.trim() === 'run: |') + 1;
  const commands = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith('          ')) break;
    commands.push(line.slice(10));
  }
  assert.ok(commands.length >= 3);
  const output = join(root, 'identity-output');
  const run = overrides => spawnSync('bash', ['-euo', 'pipefail', '-c', commands.join('\n')], {
    cwd: checkout, encoding: 'utf8', env: { ...process.env, BASH_ENV: '',
      GITHUB_REF_NAME: `v${version}`, DEFAULT_BRANCH: 'main', GITHUB_OUTPUT: output, ...overrides },
  });
  succeeded(run({}));
  assert.equal(readFileSync(output, 'utf8'), `commit=${sha}\n`);
  assert.notEqual(run({ GITHUB_REF_NAME: 'v999.0.0' }).status, 0);
  const unrelated = execFileSync('git', ['-C', checkout, '-c', 'user.name=Release contract', '-c', 'user.email=release@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit-tree', 'HEAD^{tree}', '-m', 'Unrelated branch'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', checkout, 'update-ref', 'refs/remotes/origin/unrelated', unrelated]);
  assert.notEqual(run({ DEFAULT_BRANCH: 'unrelated' }).status, 0);
});

test('new version publishes exactly six verified assets after uploading a commit-bound draft', () => {
  const item = scenario();
  succeeded(item.run());
  assert.equal(item.state().tag, sha);
  assert.equal(item.state().release.draft, false);
  assert.equal(item.state().release.target_commitish, sha);
  assert.deepEqual(item.state().release.assets.map(asset => asset.name).sort(), readdirSync(artifacts).sort());
  assert.deepEqual(mutations(item).map(mutationType), ['create', 'upload', 'edit']);
  assert.match(item.state().notes, /actions\/runs\/12345/);
  assert.ok(item.state().notes.includes(sha));
});

test('new and resumed drafts publish when collection reads remain stale after every mutation', () => {
  for (const release of [undefined, draft(sha)]) {
    const item = scenario({ release, staleCollection: true });
    succeeded(item.run());
    assert.equal(item.state().release.draft, false);
    assert.deepEqual(item.state().release.assets.map(asset => asset.name).sort(), readdirSync(artifacts).sort());
    assert.deepEqual(mutations(item).map(mutationType), release ? ['upload', 'edit'] : ['create', 'upload', 'edit']);
  }
});

test('a failed direct draft lookup cannot authorize upload or publication', () => {
  const item = scenario({ release: draft(sha), failAt: 'release' });
  rejected(item.run(), /Simulated GitHub API failure/);
  assert.deepEqual(mutations(item), []);
});

test('draft identity changes returned by the direct lookup block publication', () => {
  for (const readOverride of [{ tag_name: 'v999.0.0' }, { target_commitish: 'c'.repeat(40) }, { id: 1902 }]) {
    const item = scenario({ release: draft(sha), readOverride });
    assert.notEqual(item.run().status, 0);
    assert.deepEqual(mutations(item), []);
  }
});

test('an invalid draft creation identifier cannot authorize an upload', () => {
  const item = scenario({ createOverride: { id: 'invalid' } });
  assert.notEqual(item.run().status, 0);
  assert.deepEqual(mutations(item).map(mutationType), ['create']);
});

test('published version remains untouched when its tag validation is rerun', () => {
  const release = { ...draft(sha), draft: false, assets: [{ name: 'existing-asset' }] };
  const item = scenario({ release });
  succeeded(item.run());
  assert.deepEqual(item.state().release, release);
  assert.deepEqual(mutations(item), []);
});

test('force-moving a published version tag does not silently accept the old release', () => {
  const release = { ...draft('a'.repeat(40)), draft: false, assets: [{ name: 'existing-asset' }] };
  const item = scenario({ release });
  rejected(item.run(), /existing release belongs to a different validated commit/);
  assert.deepEqual(item.state().release, release);
  assert.deepEqual(mutations(item), []);
});

test('partial draft for this exact commit resumes without recreating the release', () => {
  const item = scenario({ release: draft(sha), tag: sha });
  succeeded(item.run());
  assert.deepEqual(mutations(item).map(mutationType), ['upload', 'edit']);
  assert.equal(item.state().release.assets.length, 6);
});

test('an existing tag or draft bound to another commit cannot publish', () => {
  for (const initial of [{ tag: 'b'.repeat(40) }, { release: draft('c'.repeat(40)) }]) {
    const item = scenario(initial);
    rejected(item.run(), /different (?:validated )?commit/);
    assert.deepEqual(mutations(item), []);
  }
});

test('annotated version tags resolve to their exact validated commit', () => {
  execFileSync('git', ['-C', checkout, '-c', 'user.name=Release contract', '-c', 'user.email=release@example.invalid',
    '-c', 'tag.gpgsign=false', 'tag', '--force', '--annotate', `v${version}`, '-m', 'Annotated fixture', sha]);
  try {
    const item = scenario({ tag: 'd'.repeat(40), annotated: true, annotatedTarget: sha });
    succeeded(item.run());
    assert.equal(item.state().release.target_commitish, sha);
    assert.equal(item.state().release.draft, false);
  } finally {
    execFileSync('git', ['-C', checkout, '-c', 'tag.gpgsign=false', 'tag', '--force', `v${version}`, sha]);
  }
});

test('a deleted remote version tag cannot be recreated implicitly by publishing', () => {
  const item = scenario({ tag: null });
  rejected(item.run(), /missing or points to a different commit/);
  assert.deepEqual(mutations(item), []);
});

test('release, tag and annotated-tag API failures never become absent-release permission', () => {
  for (const failAt of ['releases', 'tag', 'annotated']) {
    const item = scenario({ failAt, ...(failAt === 'annotated' ? { tag: 'd'.repeat(40), annotated: true, annotatedTarget: sha } : {}) });
    rejected(item.run(), /Simulated GitHub API failure/);
    assert.deepEqual(mutations(item), []);
  }
});

test('upload failure keeps a retryable draft and never publishes incomplete assets', () => {
  const item = scenario({ failAt: 'upload' });
  rejected(item.run(), /Simulated GitHub API failure/);
  assert.equal(item.state().release.draft, true);
  assert.deepEqual(mutations(item).map(mutationType), ['create', 'upload']);
  item.update({ ...item.state(), failAt: null });
  succeeded(item.run());
  assert.equal(item.state().release.draft, false);
  assert.deepEqual(mutations(item).map(mutationType), ['create', 'upload', 'upload', 'edit']);
});

test('unexpected or missing remote draft assets block publication', () => {
  for (const initial of [{ failAt: 'incomplete' }, { release: { ...draft(sha), assets: [{ name: 'unrelated-file' }] } }]) {
    const item = scenario(initial);
    rejected(item.run(), /exactly the six expected assets/);
    assert.equal(item.state().release.draft, true);
    assert.ok(!mutations(item).some(call => call[1] === 'edit'));
  }
});

test('corrupt checksums and different source provenance fail before any GitHub mutation', () => {
  for (const mode of ['checksum', 'fingerprint']) {
    const item = scenario();
    const directory = join(item.directory, 'artifacts');
    cpSync(artifacts, directory, { recursive: true });
    if (mode === 'checksum') {
      writeFileSync(join(directory, `php-wasm-int64-${version}-php8.3.tar.gz.sha256`), 'invalid\n');
    } else {
      const pins = JSON.parse(readFileSync(join(checkout, 'versions.json'), 'utf8'));
      writeArchive('8.3', pins, '0'.repeat(64), directory);
    }
    rejected(item.run(directory), /Checksum mismatch|provenance differs/);
    assert.deepEqual(item.calls(), []);
  }
});

test('checkout must be the exact validated commit before accepting any release artifact', () => {
  const item = scenario();
  rejected(item.run(artifacts, { VALIDATED_SHA: 'f'.repeat(40) }), /Checkout differs/);
  assert.deepEqual(item.calls(), []);
});

test('only the matching version tag on the default branch may publish', () => {
  for (const [overrides, error] of [
    [{ GITHUB_REF_TYPE: 'branch' }, /pushed tag must equal/],
    [{ GITHUB_REF_NAME: 'v999.0.0' }, /pushed tag must equal/],
    [{ DEFAULT_BRANCH: 'missing-branch' }, /no longer on the default branch/],
  ]) {
    const item = scenario();
    rejected(item.run(artifacts, overrides), error);
    assert.deepEqual(item.calls(), []);
  }
});
