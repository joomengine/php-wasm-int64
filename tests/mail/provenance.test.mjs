import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// A real, unchanged third-party caller is part of the acceptance evidence. This
// prevents a locally simplified PHPMailer fixture from silently replacing it.
test('PHPMailer Sendmail fixtures match their pinned upstream provenance', async () => {
  const provenance = JSON.parse(await readFile(new URL('./provenance.json', import.meta.url), 'utf8'));
  assert.equal(provenance.repository, 'https://github.com/PHPMailer/PHPMailer');
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.license, 'LGPL-2.1-only');
  assert.deepEqual(Object.keys(provenance.files).sort(), ['Exception.php', 'LICENSE', 'PHPMailer.php']);
  for (const [name, expected] of Object.entries(provenance.files)) {
    const bytes = await readFile(new URL(`./vendor/phpmailer/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `${name} differs from the recorded upstream source`);
  }
  const source = await readFile(new URL('./vendor/phpmailer/PHPMailer.php', import.meta.url), 'utf8');
  assert.ok(source.includes(`const VERSION = '${provenance.version}';`));
});
