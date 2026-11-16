// Shared by Node and real-browser wrappers. There are no simulated PHP callers:
// transport.php runs native mail(), PHP stream calls, and vendored PHPMailer.
import { captureOutput, check } from '../browser-common.mjs';

export const mailFixturePaths = Object.freeze([
  'mail/transport.php', 'mail/vendor/phpmailer/Exception.php', 'mail/vendor/phpmailer/PHPMailer.php',
]);
export const mailIni = '\nsendmail_path=/usr/sbin/sendmail -t -i\n';
const decoder = new TextDecoder();

function equalBytes(actual, expected, label) {
  check(actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${label}: captured message bytes differ (${actual.length} versus ${expected.length})`);
}
function base64Bytes(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function mountMailFiles(binary, files) {
  binary.FS.mkdirTree('/config');
  binary.FS.mkdirTree('/int64-mail/vendor');
  for (const name of ['Exception.php', 'PHPMailer.php']) {
    binary.FS.writeFile(`/int64-mail/vendor/${name}`, files[`mail/vendor/phpmailer/${name}`], { encoding: 'utf8' });
  }
}

async function verifyTransport(createRuntime, execute, files, { refresh = false, cgiLifecycle = false } = {}) {
  for (const handlerPresent of [false, true]) {
    const events = [];
    let binary;
    const onMail = event => {
      check(event?.version === 1 && event.raw instanceof Uint8Array, 'Capture callback must receive versioned byte data');
      check(event.raw.buffer !== binary.HEAPU8.buffer, 'Capture callback borrowed the mutable Wasm heap');
      check(event.command.startsWith('/usr/sbin/sendmail') || event.command.startsWith("'/usr/sbin/sendmail'"), 'Capture callback lost the original command');
      check(Array.isArray(event.args) && event.args.every(value => typeof value === 'string'), 'Capture callback must expose parsed arguments');
      check(!event.args.includes('/usr/sbin/sendmail'), 'Capture args unexpectedly include the executable');
      const text = decoder.decode(event.raw);
      const name = /^X-Capture-Case: ([^\r\n]+)\r?$/m.exec(text)?.[1];
      const outcome = /^X-Capture-Result: ([^\r\n]+)\r?$/m.exec(text)?.[1] || 'accept';
      check(name, 'Capture callback received an unidentifiable test message');
      events.push({ event, name });
      if (outcome === 'throw') throw new Error('Deliberate host capture failure');
      if (outcome === 'reject') return false;
      if (outcome === 'undefined') return undefined;
      if (outcome === 'truthy-object') return { accepted: true };
      if (outcome.startsWith('async-')) {
        return new Promise((resolve, reject) => setTimeout(() => {
          if (outcome === 'async-throw') reject(new Error('Deliberate asynchronous capture failure'));
          else resolve(outcome === 'async-accept');
        }, 2));
      }
      return true;
    };
    const environment = { JOOMENGINE_MAIL_EXPECT_CAPTURE: handlerPresent ? '1' : '0' };
    const php = await createRuntime({ ...(handlerPresent ? { onMail } : {}), ENV: environment, env: environment });
    binary = await php.binary;
    check(php.mailCaptureVersion === 1, 'Runtime is missing the version 1 mail capture capability');
    mountMailFiles(binary, files);
    const resultText = await execute(php, files['mail/transport.php']);
    const result = JSON.parse(resultText);
    check(result.passed === true && Array.isArray(result.captures), `Mail fixture did not complete: ${resultText}`);
    check(events.length === result.captures.length,
      `Expected ${result.captures.length} capture attempts, received ${events.length}: ${events.map(item => item.name).join(', ')}`);
    for (const [index, expected] of result.captures.entries()) {
      const { event, name } = events[index];
      check(name === expected.case, `Capture order/isolation failure: expected ${expected.case}, received ${name}`);
      check(event.envelopeSender === expected.sender, `${name}: wrong envelope sender ${JSON.stringify(event.envelopeSender)}`);
      check(JSON.stringify(event.envelopeRecipients) === JSON.stringify(expected.recipients), `${name}: envelope recipients were lost or fabricated`);
      check(event.readRecipientsFromHeaders === expected.readHeaders, `${name}: incorrect -t metadata`);
      if (expected.raw) equalBytes(event.raw, base64Bytes(expected.raw), name);
      else check(decoder.decode(event.raw).includes(expected.body), `${name}: mail() body was truncated or decoded incorrectly`);
    }
    if (handlerPresent) {
      const phpmailer = events.find(item => item.name === 'phpmailer');
      const raw = decoder.decode(phpmailer.event.raw);
      check(raw.includes('multipart/mixed') && raw.includes('multipart/alternative')
        && /filename="?fixture\.bin"?/.test(raw) && raw.includes('Bcc: hidden@example.invalid'),
      'PHPMailer fixture did not exercise HTML, text, attachment, and BCC MIME headers');
      check(phpmailer.event.args.includes('-oi') && phpmailer.event.args.includes('-fbounce-tag@example.invalid')
        && phpmailer.event.args.includes('-t'), 'PHPMailer real Sendmail arguments were not retained');
      const plusSender = events.find(item => item.name === 'phpmailer-plus-sender');
      check(!plusSender.event.args.some(argument => argument.startsWith('-f')),
        'PHPMailer deliberately omitted -f for its plus-address sender, but capture fabricated it');
    }
    if (cgiLifecycle && handlerPresent) {
      let originalCount = events.length;
      for (let index = 0; index < 2; index++) {
        const result = await execute(php, `<?php echo mail("recipient@example.invalid", "reuse", "body", "X-Capture-Case: reused-${index}") ? "accepted" : "failed";`);
        check(result === 'accepted' && events.length === ++originalCount && events.at(-1).name === `reused-${index}`,
          'A repeated CGI request lost its mail handler or duplicated capture');
      }
      await execute(php, '<?php $GLOBALS["mailAbandonedPipe"] = popen("/usr/sbin/sendmail -t -i", "w"); fwrite($GLOBALS["mailAbandonedPipe"], "X-Capture-Case: request-abandoned\\r\\n\\r\\nincomplete"); echo "open";');
      check(events.length === originalCount, 'CGI request shutdown captured an unfinished message');
      const previousBinary = binary;
      const beforeRecovery = await execute(php, '<?php echo mail("recipient@example.invalid", "before recovery", "body", "X-Capture-Case: before-recovery") ? "accepted" : "failed"; exit(7);', { expectedExit: 7 });
      binary = await php.binary;
      check(binary !== previousBinary, 'The failing CGI request did not replace its interpreter');
      check(beforeRecovery === 'accepted' && events.length === ++originalCount && events.at(-1).name === 'before-recovery',
        'A completed message was lost or duplicated during CGI recovery');
      mountMailFiles(binary, files);
      const recovered = await execute(php, '<?php echo mail("recipient@example.invalid", "recovered", "body", "X-Capture-Case: recovered") ? "accepted" : "failed";');
      check(recovered === 'accepted' && events.length === originalCount + 1 && events.at(-1).name === 'recovered',
        'Automatic CGI recovery lost its mail handler or duplicated capture');
    }
    if (refresh && handlerPresent) {
      for (let cycle = 0; cycle < 3; cycle++) {
        const originalCount = events.length;
        // Explicit refresh must abandon an unfinished pipe before PHP shuts down
        // its resources. The callback is an instance option, not transient shared state.
        await execute(php, '<?php $GLOBALS["mailAbandonedPipe"] = popen("/usr/sbin/sendmail -t -i", "w"); fwrite($GLOBALS["mailAbandonedPipe"], "X-Capture-Case: abandoned\\r\\n\\r\\nincomplete"); echo "open";');
        await php.refresh();
        binary = await php.binary;
        check(events.length === originalCount, 'Explicit runtime refresh captured an abandoned message');
        mountMailFiles(binary, files);
        const next = await execute(php, '<?php echo mail("recipient@example.invalid", "after refresh", "body", "X-Capture-Case: after-refresh") ? "accepted" : "failed";');
        check(next === 'accepted' && events.length === originalCount + 1 && events.at(-1).name === 'after-refresh',
          'Runtime refresh lost its mail handler or duplicated capture');
      }
    }
  }
}

export async function verifyEmbeddedMail(createRuntime, files) {
  await verifyTransport(createRuntime, async (php, source) => {
    const output = captureOutput(php);
    const status = await php.run(source);
    await php.flush();
    const { stdout, stderr } = output.read();
    check(status === 0 && stderr === '', `Embedded mail failed (${status}): ${stdout}${stderr}`);
    return stdout;
  }, files, { refresh: true });
}

export async function verifyCgiMail(createRuntime, makeRequest, files) {
  await verifyTransport(extra => createRuntime({ prefix: '/', docroot: '/int64-mail', persist: [], ...extra }), async (php, source, { expectedExit = 0 } = {}) => {
    const binary = await php.binary;
    binary.FS.writeFile('/int64-mail/transport.php', source, { encoding: 'utf8' });
    const diagnostics = [];
    const warn = console.warn, error = console.error;
    let response, text, rawError;
    try {
      if (expectedExit) {
        // A nonzero CGI exit deliberately emits diagnostics while replacing its
        // interpreter. Capture those known diagnostics, not browser page errors.
        console.warn = (...args) => diagnostics.push(args);
        console.error = (...args) => diagnostics.push(args);
      }
      response = await makeRequest(php, '/transport.php');
      text = await response.text();
      rawError = decoder.decode(Uint8Array.from(php.error));
      await php.binary;
    } finally {
      console.warn = warn;
      console.error = error;
    }
    check(response.status === 200 && rawError === '', `CGI mail failed (HTTP ${response.status}): ${text}${rawError}`);
    check(binary.ccall('wasm_sapi_cgi_result', 'number', [], []) === expectedExit,
      `CGI mail lost its expected native exit status ${expectedExit}: ${JSON.stringify(diagnostics)}`);
    if (expectedExit) check(diagnostics.length >= 2, 'The failed CGI request did not report its diagnostics');
    return text;
  }, files, { cgiLifecycle: true });
}

export async function verifyCliMail(createRuntime, files) {
  await verifyTransport(extra => createRuntime({ script: '/int64-mail/transport.php', ...extra }), async (php, source) => {
    const binary = await php.binary;
    binary.FS.writeFile('/int64-mail/transport.php', source, { encoding: 'utf8' });
    const output = captureOutput(php);
    const status = await php.run();
    await php.flush();
    const { stdout, stderr } = output.read();
    check(status === 0 && stderr === '', `CLI mail failed (${status}): ${stdout}${stderr}`);
    return stdout;
  }, files);
}

export async function verifyDebuggerMail(createRuntime, files) {
  await verifyTransport(createRuntime, async (php, source) => {
    const binary = await php.binary;
    binary.FS.writeFile('/int64-mail/transport.php', source, { encoding: 'utf8' });
    const output = captureOutput(php);
    const command = ['phpdbg', '-c', '/php.ini', '-qrr', '/int64-mail/transport.php'];
    const pointers = command.map(value => {
      const pointer = binary._malloc(binary.lengthBytesUTF8(value) + 1);
      binary.stringToUTF8(value, pointer, binary.lengthBytesUTF8(value) + 1);
      return pointer;
    });
    const vector = binary._malloc(4 * (pointers.length + 1));
    pointers.forEach((pointer, index) => binary.setValue(vector + 4 * index, pointer, '*'));
    binary.setValue(vector + 4 * pointers.length, 0, '*');
    let status;
    try {
      await binary.ccall('wasm_sapi_phpdbg_main', null, ['number', 'number'], [pointers.length, vector], { async: true });
      status = binary.ccall('wasm_sapi_phpdbg_result', 'number', [], []);
    } finally {
      pointers.forEach(pointer => binary._free(pointer));
      binary._free(vector);
    }
    await php.flush();
    const { stdout, stderr } = output.read();
    check(status === 0 && stderr === '', `Debugger mail failed (${status}): ${stdout}${stderr}`);
    return stdout;
  }, files);
}
