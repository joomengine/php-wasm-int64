import { captureOutput, check } from './browser-common.mjs';

const fiber = '$fiber = new Fiber(static function (): void { Fiber::suspend(42); }); $fiber->start(); $fiber->resume();';
const cases = [
  { name: 'plain-success', switched: false, status: 0 },
  { name: 'fiber-success', switched: true, status: 0 },
  { name: 'plain-exit', switched: false, status: 7 },
  { name: 'fiber-exit', switched: true, status: 7 },
  { name: 'plain-error', switched: false, status: 255 },
  { name: 'fiber-error', switched: true, status: 255 },
];

function program(sample, cgi = false) {
  const marker = `sapi-status-${sample.name}-ok\n`;
  const failure = `sapi-status-fatal-${sample.name}`;
  const ending = sample.status === 255
    ? `throw new RuntimeException(${JSON.stringify(failure)});`
    : `exit(${sample.status});`;
  return {
    marker, failure,
    code: `${sample.switched ? fiber : ''}${cgi ? 'http_response_code(201);' : ''}echo ${JSON.stringify(marker)};${ending}`,
  };
}

async function verifyCases(label, run) {
  const failures = [];
  for (const sample of cases) {
    try {
      await run(sample);
    } catch (error) {
      failures.push(new Error(`${sample.name}: ${error.message || error}`, { cause: error }));
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `${label}: ${failures.length} status cases failed:\n${failures.map(error => error.message).join('\n')}`);
  }
}

export async function verifyCliStatus(createRuntime) {
  await verifyCases('CLI', async sample => {
    const { marker, failure, code } = program(sample);
    const php = await createRuntime({ code, autoTransaction: false });
    const output = captureOutput(php);
    const status = await php.run();
    await php.flush();
    const { stdout, stderr } = output.read();
    check(status === sample.status, `${sample.name}: CLI returned ${status}, expected ${sample.status}; ${stdout}${stderr}`);
    const binary = await php.binary;
    check(binary.ccall('wasm_sapi_cli_result', 'number', [], []) === sample.status,
      `${sample.name}: CLI public and retained native results disagree`);
    if (sample.status === 255) {
      check(stdout.includes(marker) && `${stdout}${stderr}`.includes(failure), `${sample.name}: missing deliberate PHP error`);
    } else {
      check(stdout === marker && stderr === '', `${sample.name}: unexpected CLI output ${JSON.stringify({ stdout, stderr })}`);
    }
  });
}

export async function verifyCgiStatus(createRuntime, makeRequest, { nodeAccessLog = false } = {}) {
  await verifyCases('CGI', async sample => {
    const { marker, failure, code } = program(sample, true);
    const php = await createRuntime({ prefix: '/', docroot: '/int64-status', persist: [], autoTransaction: false });
    const initialPromise = php.binary;
    const binary = await initialPromise;
    binary.FS.mkdirTree('/config');
    binary.FS.mkdirTree('/int64-status');
    const path = `/${sample.name}.php`;
    binary.FS.writeFile(`/int64-status${path}`, `<?php ${code}`);
    let persisted = 0;
    const afterRequest = php._afterRequest.bind(php);
    php._afterRequest = async (...args) => { persisted++; return afterRequest(...args); };
    const warnings = [], errors = [];
    const warn = console.warn, error = console.error;
    let response, body, rawOutput, rawError;
    try {
      // These requests deliberately exercise PHP failures. Capture their expected
      // diagnostics exactly while retaining rejection/error visibility below.
      console.warn = (...args) => warnings.push(args);
      console.error = (...args) => errors.push(args);
      response = await makeRequest(php, path);
      body = await response.text();
      rawOutput = new TextDecoder().decode(Uint8Array.from(php.output));
      rawError = new TextDecoder().decode(Uint8Array.from(php.error));
      // A failed replacement must reject this test instead of logging unnoticed.
      await php.binary;
    } finally {
      console.warn = warn;
      console.error = error;
    }
    const report = JSON.stringify({ warnings: warnings.map(args => args.map(String)), errors: errors.map(args => args.map(String)), body });
    check(response.status === 201, `${sample.name}: CGI changed the explicit HTTP status; ${report}`);
    check(binary.ccall('wasm_sapi_cgi_result', 'number', [], []) === sample.status,
      `${sample.name}: CGI lost its native exit status ${sample.status}; ${report}`);
    check((php.binary !== initialPromise) === (sample.status !== 0), `${sample.name}: incorrect CGI refresh lifecycle; ${report}`);
    check(persisted === (sample.status === 0 ? 1 : 0), `${sample.name}: incorrect CGI persistence lifecycle; ${report}`);
    if (sample.status === 255) {
      check(body.includes(marker) && `${body}${rawError}`.includes(failure), `${sample.name}: missing deliberate PHP error; ${report}`);
    } else {
      check(body === marker && rawError === '', `${sample.name}: unexpected CGI output; ${report}`);
    }
    if (nodeAccessLog) {
      const access = errors.filter(args => args.length === 1 && typeof args[0] === 'string'
        && args[0].includes('[HTTP 201]   GET ') && args[0].endsWith(path));
      check(access.length === 1, `${sample.name}: unexpected Node access log; ${report}`);
      errors.splice(errors.indexOf(access[0]), 1);
    }
    const expectedCount = sample.status === 0 ? 0 : 1;
    check(warnings.length === expectedCount && errors.length === expectedCount,
      `${sample.name}: unexpected CGI diagnostics; ${report}`);
    if (expectedCount) {
      check(warnings[0].length === 1 && warnings[0][0] === rawOutput
        && errors[0].length === 1 && errors[0][0] === rawError,
      `${sample.name}: CGI diagnostics did not match the completed request; ${report}`);
    }
  });
}
