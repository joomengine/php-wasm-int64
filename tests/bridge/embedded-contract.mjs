import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// This preflight deliberately uses the real generator and linker. A host C
// stringification test misses Emscripten's compatibility unescaping in
// tools/extract_metadata.py:data_to_string, before its JS optimizer runs.
test('generated Vrzno headers link and preserve JSON through the pinned Emscripten pipeline', async t => {
  assert.ok(process.env.VRZNO_SOURCE_ROOT, 'Set VRZNO_SOURCE_ROOT to the pinned, patched Vrzno source');
  const source = resolve(process.env.VRZNO_SOURCE_ROOT);
  const build = mkdtempSync(join(tmpdir(), 'vrzno-embedded-contract-'));
  t.after(() => rmSync(build, { recursive: true, force: true }));
  const compiler = process.env.BRIDGE_EMCC || 'emcc';
  const run = (command, args, timeout = 120000) => {
    const result = spawnSync(command, args, { cwd: build, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, `${command} must finish successfully`);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const version = run(compiler, ['--version']);
  assert.match(version, /\b6\.0\.6\b/, 'Run with the same pinned Emscripten version as the PHP build');
  const templates = readdirSync(source).filter(name => name.endsWith('_js.h.in')).sort();
  assert.equal(templates.length, 5, 'Every Vrzno JS translation unit must be generated');
  const declarations = templates.flatMap(name => [...readFileSync(join(source, name), 'utf8')
    .matchAll(/^EM_(?:ASYNC_)?JS\(([^,]+), (\w+), \(([^)]*)\), \{/gm)]
    .map(match => ({ result: match[1], name: match[2], parameters: match[3] })));
  assert.equal(declarations.length, 44, 'Every embedded function must survive the linker');
  mkdirSync(join(build, 'generated'));
  const headers = templates.map(name => join(build, 'generated', name.slice(0, -3)));
  // Include upstream's Make fragment unchanged. This also runs its locked npm
  // install, Weakermap bundle, and -fdirectives-only include expansion.
  writeFileSync(join(build, 'Makefile'), 'all: ' + headers.join(' ') + '\n'
    + `srcdir = ${source}\nbuilddir = ${build}\ninclude ${join(source, 'Makefile.frag')}\n`);
  run('make', ['--no-print-directory', '-j2', `CC=${compiler}`, 'all']);
  const wrappers = declarations.map(({ result, name, parameters }) => {
    const args = parameters === 'void' ? '' : parameters.split(',').map(arg => arg.trim().match(/\w+$/)[0]).join(', ');
    return `EMSCRIPTEN_KEEPALIVE ${result} test_${name}(${parameters}) { ${result === 'void' ? '' : 'return '}${name}(${args}); }\n`;
  }).join('');
  writeFileSync(join(build, 'glue.c'), '#include <emscripten.h>\n#include <stdbool.h>\n#include <stdint.h>\n#include <sys/types.h>\n'
    + 'typedef uint32_t vrzno_target_id; typedef int64_t zend_long; typedef void zval; typedef void zend_class_entry;\n'
    + '_Static_assert(sizeof(zend_long) == 8, "64-bit PHP integers");\n'
    + '_Static_assert(sizeof(void *) == 4, "32-bit Wasm pointers");\n'
    + headers.map(header => `#include "${header}"\n`).join('') + wrappers);
  run(compiler, ['-O1', '-c', 'glue.c', '-o', 'glue.o']);
  // Link the compiled object independently, just as PHP's final link does.
  // 4GiB memory enables the unsignPointers optimizer that exposed the regression.
  run(compiler, ['glue.o', '-O1', '--no-entry', '-o', 'bridge.mjs',
    '-sASYNCIFY=1', '-sWASM_BIGINT=1', '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=4294967296',
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=node',
    '-sEXPORTED_RUNTIME_METHODS=["ccall","getValue","setValue","UTF8ToString","lengthBytesUTF8","stringToUTF8","HEAPU8"]',
    '-sEXPORTED_FUNCTIONS=["_malloc","_free"]']);
  const { default: createModule } = await import(pathToFileURL(join(build, 'bridge.mjs')).href);
  const Module = await createModule();
  for (const { name } of declarations) assert.equal(typeof Module[`_test_${name}`], 'function', name);
  Module._test_vrzno_js_init();
  t.after(() => Module._test_vrzno_js_shutdown());

  const ordinary = [null, true, false, 0, -0, 1.5, 1e50, '\n\t"\\',
    'escaped quote: \\"; backslashes: \\\\; Unicode: ☺', [1, 2], { 'quoted"key\\': 'value\\' }];
  for (const value of ordinary) {
    const json = JSON.stringify(value);
    assert.deepEqual(Module.vrznoParseJson(json), JSON.parse(json));
  }
  assert.deepEqual(Module.vrznoParseJson('[9223372036854775807,-9223372036854775808,9007199254740993,9007199254740992.0,{"nested":["a\\\"b","\\u263a"]}]'),
    [9223372036854775807n, -9223372036854775808n, 9007199254740993n, 9007199254740992, { nested: ['a"b', '☺'] }]);
  assert.deepEqual(Module.vrznoParseJson(' \t[\r\n-9223372036854775808, 1.5, 1e3]\n'),
    [-9223372036854775808n, 1.5, 1000]);
  for (const json of ['[1,]', '{"x":1,}', '01', '1e', '1x2', '1.', 'true false', '"unfinished', '{x:1}', '[1 2]']) {
    assert.throws(() => Module.vrznoParseJson(json), SyntaxError, json);
  }

  const target = {
    max: 9223372036854775807n, min: -9223372036854775808n,
    string: '9223372036854775807', 'a\u0000b': 9007199254740993n,
    'quoted"key\\': 'quote" backslash\\ escaped newline\n tab\t and Unicode ☺',
    nested: [{ value: 9007199254740993n, string: '9007199254740993' }],
  };
  const id = Module.targets.add(target);
  const pointer = Module._test_vrzno_js_properties_json(id);
  assert.equal(typeof pointer, 'number', 'Snapshot pointers remain wasm32');
  try {
    assert.deepEqual(Module.vrznoParseJson(Module.UTF8ToString(pointer)), target);
  } finally {
    Module._free(pointer);
    Module.targets.remove(id);
  }
});
