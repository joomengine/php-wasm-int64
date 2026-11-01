import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
let root, upstream, bin, pins, versions;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'php-int64-update-'));
  upstream = join(root, 'upstream');
  bin = join(root, 'bin');
  mkdirSync(upstream);
  mkdirSync(bin);
  const git = args => execFileSync(realGit, ['-C', upstream, ...args], { encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  git(['config', 'user.name', 'PHP update fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  pins = JSON.parse(readFileSync(join(source, 'versions.json'), 'utf8'));
  versions = new Map();
  mkdirSync(join(upstream, 'main'));
  for (const php of pins.php) {
    const next = `${php.minor}.${Number(php.version.split('.')[2]) + 1}`;
    for (const version of [php.version, next]) {
      writeFileSync(join(upstream, 'main/php_version.h'), `#define PHP_VERSION "${version}"\n`);
      writeFileSync(join(upstream, 'native.txt'), 'base\n');
      git(['add', '.']);
      git(['commit', '--quiet', '-m', `PHP ${version}`]);
      git(['-c', 'tag.gpgsign=false', 'tag', '--annotate', `php-${version}`, '-m', `PHP ${version}`]);
      versions.set(version, git(['rev-parse', 'HEAD']));
    }
    php.commit = versions.get(php.version);
  }
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2).map(value => value === 'https://github.com/php/php-src.git' ? process.env.FIXTURE_UPSTREAM : value);
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.at(-1) !== 'https://www.php.net/releases/active.php') process.exit(1);
fs.copyFileSync(process.env.FIXTURE_FEED, args[args.indexOf('--output') + 1]);
`, { mode: 0o755 });
});

after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function scenario() {
  const directory = mkdtempSync(join(root, 'case-'));
  for (const path of ['.github/scripts', 'scripts', 'patches/runtime', 'patches/php']) mkdirSync(join(directory, path), { recursive: true });
  cpSync(join(source, '.github/scripts/update-php.sh'), join(directory, '.github/scripts/update-php.sh'));
  cpSync(join(source, 'scripts/common.sh'), join(directory, 'scripts/common.sh'));
  const initial = JSON.stringify(pins, null, 2) + '\n';
  writeFileSync(join(directory, 'versions.json'), initial);
  writeFileSync(join(directory, 'VERSION'), '2.4.6\n');
  const feed = { 8: Object.fromEntries(pins.php.map(php => [php.minor, { version: php.version }])) };
  for (const php of pins.php) {
    writeFileSync(join(directory, `patches/runtime/${php.minor}.patch`), 'diff --git a/native.txt b/native.txt\n--- a/native.txt\n+++ b/native.txt\n@@ -1 +1,2 @@\n base\n+runtime\n');
    writeFileSync(join(directory, `patches/php/${php.minor}.patch`), 'diff --git a/native.txt b/native.txt\n--- a/native.txt\n+++ b/native.txt\n@@ -1,2 +1,3 @@\n base\n runtime\n+int64\n');
  }
  return {
    directory, feed, initial,
    advance(minor) {
      const php = pins.php.find(php => php.minor === minor);
      feed[8][minor].version = `${minor}.${Number(php.version.split('.')[2]) + 1}`;
    },
    run() {
      const feedFile = join(directory, 'feed.json');
      writeFileSync(feedFile, JSON.stringify(feed));
      return spawnSync('bash', ['.github/scripts/update-php.sh'], {
        cwd: directory, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASH_ENV: '',
          FIXTURE_UPSTREAM: upstream, FIXTURE_FEED: feedFile,
          GITHUB_OUTPUT: join(directory, 'outputs'), RUNNER_TEMP: directory },
      });
    },
    result() { return JSON.parse(readFileSync(join(directory, 'versions.json'), 'utf8')); },
  };
}

test('current stable sources are a no-op, including annotated tag resolution', () => {
  const item = scenario();
  const result = item.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(item.directory, 'versions.json'), 'utf8'), item.initial);
  assert.equal(readFileSync(join(item.directory, 'outputs'), 'utf8'), 'changed=false\n');
});

test('stable updates record exact verified commits without bumping distribution VERSION', () => {
  const item = scenario();
  item.advance('8.3');
  item.advance('8.5');
  const result = item.run();
  assert.equal(result.status, 0, result.stderr);
  for (const php of item.result().php) {
    assert.equal(php.version, item.feed[8][php.minor].version);
    assert.equal(php.commit, versions.get(php.version));
  }
  assert.equal(readFileSync(join(item.directory, 'VERSION'), 'utf8'), '2.4.6\n');
  assert.equal(readFileSync(join(item.directory, 'outputs'), 'utf8'), 'changed=true\n');
});

test('missing, prerelease and downgrade feed entries fail without a partial pin update', () => {
  for (const version of [undefined, '8.5.999RC1', '8.5.0']) {
    const item = scenario();
    item.advance('8.3');
    item.feed[8]['8.5'] = version === undefined ? {} : { version };
    const result = item.run();
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(item.directory, 'versions.json'), 'utf8'), item.initial);
  }
});

test('a missing official source tag or changed recorded tag cannot update pins', () => {
  for (const mode of ['missing', 'changed']) {
    const item = scenario();
    if (mode === 'missing') item.feed[8]['8.3'].version = '8.3.999999';
    else {
      const altered = structuredClone(pins);
      altered.php[0].commit = 'a'.repeat(40);
      writeFileSync(join(item.directory, 'versions.json'), JSON.stringify(altered));
    }
    const before = readFileSync(join(item.directory, 'versions.json'), 'utf8');
    assert.notEqual(item.run().status, 0);
    assert.equal(readFileSync(join(item.directory, 'versions.json'), 'utf8'), before);
  }
});

test('native patch conflicts fail before any source pin is written', () => {
  const item = scenario();
  item.advance('8.3');
  item.advance('8.5');
  writeFileSync(join(item.directory, 'patches/php/8.5.patch'), 'diff --git a/native.txt b/native.txt\n--- a/native.txt\n+++ b/native.txt\n@@ -1 +1 @@\n-missing context\n+int64\n');
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /patch failed|does not apply/);
  assert.equal(readFileSync(join(item.directory, 'versions.json'), 'utf8'), item.initial);
});

test('a source tag must contain the version advertised by the official feed', () => {
  const item = scenario();
  const version = '8.5.999998';
  execFileSync(realGit, ['-C', upstream, 'tag', `php-${version}`, pins.php[2].commit]);
  item.feed[8]['8.5'].version = version;
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source identifies itself as/);
  assert.equal(readFileSync(join(item.directory, 'versions.json'), 'utf8'), item.initial);
});

test('automation updates one draft and dispatches validation without publishing', () => {
  const workflow = readFileSync(join(source, '.github/workflows/update-php.yml'), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branch: maintenance\/php-stable-patches/);
  assert.match(workflow, /add-paths: versions\.json/);
  assert.match(workflow, /draft: always-true/);
  assert.match(workflow, /head_sha="\$UPDATE_SHA"/);
  assert.match(workflow, /gh workflow run validate\.yml/);
  assert.doesNotMatch(workflow, /gh release|git tag|gh pr merge/);
});

test('validation dispatch retries a missing run, avoids duplicates, and rejects a moved branch', () => {
  const workflow = readFileSync(join(source, '.github/workflows/update-php.yml'), 'utf8');
  const run = workflow.slice(workflow.lastIndexOf('        run: |') + '        run: |'.length)
    .trimEnd().split('\n').slice(1).map(line => line.slice(10)).join('\n');
  const directory = mkdtempSync(join(root, 'dispatch-'));
  const gh = join(directory, 'gh');
  const record = join(directory, 'calls');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1].includes('/git/ref/heads/')) console.log(process.env.REF_SHA);
else if (args[0] === 'api') console.log(process.env.EXISTING_RUNS);
else if (args[0] === 'workflow' && args[1] === 'run') fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
else process.exit(1);
`, { mode: 0o755 });
  const expected = 'a'.repeat(40);
  for (const [existing, ref, passes, dispatches] of [['0', expected, true, 1], ['1', expected, true, 0], ['0', 'b'.repeat(40), false, 0], ['null', expected, false, 0]]) {
    writeFileSync(record, '');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', run], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BASH_ENV: '',
        REF_SHA: ref, EXISTING_RUNS: existing, CALLS: record, UPDATE_SHA: expected,
        UPDATE_BRANCH: 'maintenance/php-stable-patches', GITHUB_REPOSITORY: 'joomengine/php-wasm-int64' },
    });
    assert.equal(result.status === 0, passes, result.stderr);
    const calls = readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(calls.length, dispatches);
    if (dispatches) assert.deepEqual(calls[0], ['workflow', 'run', 'validate.yml', '--repo', 'joomengine/php-wasm-int64', '--ref', 'maintenance/php-stable-patches']);
  }
});
