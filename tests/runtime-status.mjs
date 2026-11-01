// Shared by Node, browser pages, and workers. These cases exercise the public
// queued APIs, including recovery in the same interpreter after termination.
import { captureOutput, check } from './browser-common.mjs';

const fiber = '$fiber = new Fiber(static function () { Fiber::suspend(); return "fiber-result"; }); $fiber->start(); $fiber->resume();';
const throwingFiber = '$fiber = new Fiber(static function () { Fiber::suspend(); throw new LogicException("fiber-error"); }); $fiber->start(); try { $fiber->resume(); } catch (LogicException $error) {}';
const cases = [
  { name: 'success', source: 'echo "success\\n";', status: 0, output: 'success\n' },
  { name: 'caught exception', source: 'try { throw new RuntimeException("caught"); } catch (Throwable $error) { echo "caught\\n"; }', status: 0, output: 'caught\n' },
  { name: 'uncaught exception', source: 'throw new RuntimeException("status-uncaught");', status: 2, diagnostic: /Fatal error: Uncaught RuntimeException: status-uncaught/ },
  { name: 'parse error', source: '$broken = ;', status: 2, diagnostic: /Parse error: syntax error/ },
  { name: 'uncaught Error', source: 'int64_missing_status_function();', status: 2, diagnostic: /Fatal error: Uncaught Error: Call to undefined function int64_missing_status_function/ },
  { name: 'caught Fiber exception', source: throwingFiber + ' echo "caught-fiber\\n";', status: 0, output: 'caught-fiber\n' },
  { name: 'uncaught exception after Fiber return', source: fiber + ' throw new RuntimeException("after-fiber-return");', status: 2, diagnostic: /Fatal error: Uncaught RuntimeException: after-fiber-return/ },
  { name: 'uncaught exception after Fiber exception', source: throwingFiber + ' throw new RuntimeException("after-fiber-exception");', status: 2, diagnostic: /Fatal error: Uncaught RuntimeException: after-fiber-exception/ },
  { name: 'exit', source: 'exit;', status: 0, output: '' },
  { name: 'exit zero', source: 'exit(0);', status: 0, output: '' },
  { name: 'exit status', source: 'exit(7);', status: 7, output: '' },
  { name: 'exit status 255', source: 'exit(255);', status: 255, output: '' },
  { name: 'exit status after Fiber', source: fiber + ' exit(9);', status: 9, output: '' },
  { name: 'exit string', source: 'exit("exit-message\\n");', status: 0, output: 'exit-message\n' },
  { name: 'top-level return', source: 'return 7;', status: 0, output: '' },
  { name: 'exec string', expression: '"plain-expression"', value: 'plain-expression', output: '' },
  { name: 'exec Fiber string', expression: `(static function () { ${fiber} return "value-" . $fiber->getReturn(); })()`, value: 'value-fiber-result', output: '' },
  { name: 'exec Fiber integer', expression: `(static function () { ${fiber} return PHP_INT_MAX; })()`, value: '9223372036854775807', output: '' },
  { name: 'exec caught Fiber exception', expression: `(static function () { ${throwingFiber} return "exec-recovered"; })()`, value: 'exec-recovered', output: '' },
  { name: 'exec uncaught exception', expression: '(static function () { throw new RuntimeException("exec-uncaught"); })()', value: '', diagnostic: /Fatal error: Uncaught RuntimeException: exec-uncaught/ },
  { name: 'exec exit', expression: '(static function () { exit(4); })()', value: '', output: '' },
  { name: 'exec object conversion', expression: 'new class { public function __toString(): string { return "converted-object"; } }', value: 'converted-object', output: '' },
  { name: 'exec failed conversion', expression: 'new class { public function __toString(): string { throw new RuntimeException("conversion-failed"); } }', value: '', diagnostic: /Fatal error: Uncaught RuntimeException: conversion-failed/, resetsRequest: true },
  { name: 'run output callback exception', source: 'ob_start(static function ($buffer) { throw new RuntimeException("output-failed"); }); echo "buffered";', status: 255, output: '', resetsRequest: true },
  { name: 'run output callback exit', source: 'ob_start(static function ($buffer) { exit(7); }); echo "buffered";', status: 7, output: '', resetsRequest: true },
  { name: 'run output callback exit zero', source: 'ob_start(static function ($buffer) { exit(0); }); echo "buffered";', status: 0, output: '', resetsRequest: true },
  { name: 'run output callback exit 255', source: 'ob_start(static function ($buffer) { exit(255); }); echo "buffered";', status: 255, output: '', resetsRequest: true },
  { name: 'exec output callback exception', expression: '(static function () { ob_start(static function ($buffer) { throw new RuntimeException("output-failed"); }); echo "buffered"; return "discarded-value"; })()', value: '', output: '', resetsRequest: true },
  { name: 'exec output callback exit', expression: '(static function () { ob_start(static function ($buffer) { exit(7); }); echo "buffered"; return "discarded-value"; })()', value: '', output: '', resetsRequest: true },
  { name: 'Zend fatal bailout', source: 'error_reporting(E_ALL & ~E_DEPRECATED); trigger_error("status-bailout", E_USER_ERROR);', status: 255, diagnostic: /Fatal error: status-bailout/, resetsRequest: true },
];

export async function validateEmbeddedStatus(createRuntime) {
  const failures = [];
  let php, output;
  for (const test of cases) {
    try {
      if (!php) {
        php = await createRuntime();
        output = captureOutput(php);
        await php.binary;
      }
      check(await php.run('<?php $int64RequestMarker = true; if (!function_exists("int64_request_marker")) { function int64_request_marker() {} }') === 0,
        `${test.name}: could not initialize request marker`);
      output.clear();
      if (test.expression !== undefined) {
        const value = await php.exec(test.expression);
        check(value === test.value, `${test.name}: expected exec result ${JSON.stringify(test.value)}, got ${JSON.stringify(value)}`);
      } else {
        const status = await php.run(`<?php ${test.source}`);
        check(status === test.status, `${test.name}: expected status ${test.status}, got ${status}; ${JSON.stringify(output.read())}`);
      }
      await php.flush();
      const { stdout, stderr } = output.read();
      check(stderr === '', `${test.name}: unexpected stderr ${JSON.stringify(stderr)}`);
      if (test.diagnostic) check(test.diagnostic.test(stdout), `${test.name}: missing diagnostic: ${JSON.stringify(stdout)}`);
      else check(stdout === test.output, `${test.name}: unexpected stdout ${JSON.stringify(stdout)}`);

      // A status or string alone cannot prove that the next eval really ran.
      output.clear();
      const recoveryStatus = await php.run('<?php echo "status-recovery-ok\\n";');
      await php.flush();
      const recovered = output.read();
      check(recoveryStatus === 0 && recovered.stdout === 'status-recovery-ok\n' && recovered.stderr === '',
        `${test.name}: next run did not recover: status=${recoveryStatus}, output=${JSON.stringify(recovered)}`);
      const recoveryValue = await php.exec('"expression-recovery-ok"');
      check(recoveryValue === 'expression-recovery-ok', `${test.name}: next expression did not recover: ${JSON.stringify(recoveryValue)}`);
      const state = JSON.parse(await php.exec('(static function () { gc_collect_cycles(); $cycle = new stdClass; $cycle->self = $cycle; unset($cycle); return json_encode(["collected" => gc_collect_cycles(), "protected" => gc_status()["protected"], "marker" => isset($GLOBALS["int64RequestMarker"]), "function" => function_exists("int64_request_marker"), "buffers" => ob_get_level()]); })()'));
      check(state.protected === false && state.collected === 1,
        `${test.name}: garbage collection did not recover: ${JSON.stringify(state)}`);
      check(state.marker === !test.resetsRequest && state.function === !test.resetsRequest,
        `${test.name}: unexpected request-state preservation: ${JSON.stringify(state)}`);
      if (test.resetsRequest) check(state.buffers === 0, `${test.name}: failed output handlers remain active`);
    } catch (cause) {
      failures.push(new Error(`Embedded result contract: ${test.name}`, { cause }));
      // Continue independent cases after a failure without concealing successful
      // interpreter reuse in the ordinary path above.
      php = output = undefined;
    }
  }
  try {
    if (!php) {
      php = await createRuntime();
      output = captureOutput(php);
      await php.binary;
    }
    output.clear();
    // Enqueue together: each operation must copy its own native result before
    // the next operation can overwrite the retained status/string.
    const results = await Promise.all([
      php.run(`<?php ${fiber} exit(11);`),
      php.exec(`(static function () { ${fiber} return "queued-fiber-value"; })()`),
      php.run('<?php return 3;'),
      php.exec('"queued-final-value"'),
    ]);
    check(JSON.stringify(results) === JSON.stringify([11, 'queued-fiber-value', 0, 'queued-final-value']),
      `Queued run/exec operations mixed results: ${JSON.stringify(results)}`);
    await php.flush();
    check(output.read().stdout === '' && output.read().stderr === '', `Queued operations emitted output: ${JSON.stringify(output.read())}`);
  } catch (cause) {
    failures.push(new Error('Embedded result contract: queued operation ownership', { cause }));
  }
  try {
    // Request shutdown must invalidate owned PHP pointers before the new
    // request can reuse their memory, while newly created proxies remain usable.
    const proxy = await php.x`(object) ['value' => 41]`;
    check(proxy.value === 41, 'Bridge proxy did not expose its initial PHP value');
    output.clear();
    const status = await php.run('<?php error_reporting(E_ALL & ~E_DEPRECATED); trigger_error("proxy-request-reset", E_USER_ERROR);');
    check(status === 255, `Proxy request reset returned ${status}`);
    let staleError;
    try { void proxy.value; } catch (error) { staleError = error; }
    check(staleError instanceof ReferenceError, 'A proxy from the terminated PHP request remained accessible');
    const current = await php.x`(object) ['value' => 42]`;
    check(current.value === 42, 'Bridge proxy did not recover in the new PHP request');
  } catch (cause) {
    failures.push(new Error('Embedded result contract: bridge proxy request lifetime', { cause }));
  }
  try {
    const binary = await php.binary;
    const proxy = await php.x`(object) ['value' => 43]`;
    const extensions = await php.exec('json_encode(get_loaded_extensions())');
    const environment = await php.exec('getenv("PATH")');
    check(environment !== '', 'Refresh environment probe is missing');
    let callbacks = 0;
    binary.onRefresh.add(() => { callbacks++; });
    php.shared.int64RefreshSentinel = 'before';
    output.clear();
    const [setup, refreshed, stateText] = await Promise.all([
      php.run(`<?php ${fiber} $int64BeforeRefresh = true; file_put_contents('/int64-refresh.txt', 'retained-file');`),
      php.refresh(),
      php.exec('json_encode([isset($GLOBALS["int64BeforeRefresh"]), file_get_contents("/int64-refresh.txt"), getenv("PATH"), get_loaded_extensions(), headers_sent()])'),
    ]);
    const state = JSON.parse(stateText);
    check(setup === 0 && (refreshed === 0 || refreshed === undefined), 'Queued refresh did not complete');
    check(state[0] === false && state[1] === 'retained-file' && state[2] === environment && JSON.stringify(state[3]) === extensions && state[4] === false,
      `Refresh lost persistent runtime state or retained PHP request state: ${stateText}`);
    check(callbacks === 1 && !Object.hasOwn(php.shared, 'int64RefreshSentinel'), 'Refresh callbacks/shared state did not run within the queued reset');
    let staleError;
    try { void proxy.value; } catch (error) { staleError = error; }
    check(staleError instanceof ReferenceError, 'Refresh left an old PHP proxy accessible');
    check((await php.x`(object) ['value' => 44]`).value === 44, 'Refresh did not restore the PHP bridge');
  } catch (cause) {
    failures.push(new Error('Embedded result contract: queued public refresh', { cause }));
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} embedded result contract(s) failed`);
}
