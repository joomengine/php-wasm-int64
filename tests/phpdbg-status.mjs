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

// The interactive debugger's next stdin wait can hide a lost Fiber return.
// Batch mode has no subsequent stdin rewind: retain the final native result
// explicitly, and check it independently of interactive prompt/breakpoint tests.
export async function verifyPhpDbgBatchStatus(createRuntime) {
  const failures = [];
  for (const sample of cases) {
    try {
      const php = await createRuntime({ autoTransaction: false });
      const output = captureOutput(php);
      const binary = await php.binary;
      const marker = `phpdbg-status-${sample.name}-ok\n`;
      const diagnostic = `phpdbg-status-fatal-${sample.name}`;
      const ending = sample.status === 255
        ? `throw new RuntimeException(${JSON.stringify(diagnostic)});`
        : `exit(${sample.status});`;
      binary.FS.mkdirTree('/int64-phpdbg-status');
      const path = `/int64-phpdbg-status/${sample.name}.php`;
      binary.FS.writeFile(path, `<?php ${sample.switched ? fiber : ''}echo ${JSON.stringify(marker)};${ending}`);

      const command = ['phpdbg', '-c', '/php.ini', '-qrr', path];
      const pointers = command.map(value => {
        const size = binary.lengthBytesUTF8(value) + 1;
        const pointer = binary._malloc(size);
        binary.stringToUTF8(value, pointer, size);
        return pointer;
      });
      const vector = binary._malloc(4 * (pointers.length + 1));
      for (const [index, pointer] of pointers.entries()) binary.setValue(vector + 4 * index, pointer, '*');
      binary.setValue(vector + 4 * pointers.length, 0, '*');
      let status;
      try {
        await binary.ccall('wasm_sapi_phpdbg_main', null, ['number', 'number'], [pointers.length, vector], { async: true });
        status = binary.ccall('wasm_sapi_phpdbg_result', 'number', [], []);
      } finally {
        for (const pointer of pointers) binary._free(pointer);
        binary._free(vector);
      }
      await php.flush();
      const { stdout, stderr } = output.read();
      check(status === sample.status,
        `${sample.name}: phpdbg retained ${status}, expected ${sample.status}; ${JSON.stringify({ stdout, stderr })}`);
      check(stderr === '', `${sample.name}: unexpected phpdbg stderr ${JSON.stringify(stderr)}`);
      if (sample.status === 255) {
        check(stdout.startsWith(marker) && stdout.includes(`RuntimeException: ${diagnostic}`),
          `${sample.name}: missing deliberate PHP exception ${JSON.stringify(stdout)}`);
      } else {
        check(stdout === marker, `${sample.name}: unexpected phpdbg output ${JSON.stringify(stdout)}`);
      }
    } catch (cause) {
      failures.push(new Error(`Debugger batch result contract: ${sample.name}`, { cause }));
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} debugger batch result contract(s) failed`);
}
