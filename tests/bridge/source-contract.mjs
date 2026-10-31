import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

if (!process.env.VRZNO_SOURCE_ROOT) {
  throw new Error('Set VRZNO_SOURCE_ROOT to the pinned, patched Vrzno source directory.');
}
const sourceRoot = resolve(process.env.VRZNO_SOURCE_ROOT);
const embeddedSources = new Map();
const compiledDirectory = mkdtempSync(resolve(tmpdir(), 'vrzno-embedded-'));
after(() => rmSync(compiledDirectory, { recursive: true, force: true }));
function source(name) {
  if (embeddedSources.has(name)) return embeddedSources.get(name);
  const body = readFileSync(resolve(sourceRoot, 'js', name), 'utf8');
  // Match the C preprocessor stringification used by Emscripten's EM_JS.
  // Compile and emit the resulting C string: preprocessing alone also misses
  // escape sequences that C consumes before Emscripten receives the JS bytes.
  const executable = resolve(compiledDirectory, name);
  const result = spawnSync(process.env.BRIDGE_CC || 'cc', ['-Werror', '-x', 'c', '-', '-o', executable], {
    input: '#include <stdio.h>\n#define EM_JS(result, name, arguments, ...) #__VA_ARGS__\n'
      + `static const char embedded[] = EM_JS(void, bridge_contract, (void), {\n${body}\n});\n`
      + 'int main(void) { return fputs(embedded, stdout) < 0; }\n',
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined, `${name}: host C compiler must be available`);
  assert.equal(result.status, 0, `${name}: EM_JS stringification failed\n${result.stderr}`);
  const execution = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(execution.status, 0, `${name}: compiled string emitter failed\n${execution.stderr}`);
  const embedded = execution.stdout;
  assert.ok(embedded.startsWith('{') && embedded.endsWith('}'), name);
  const decoded = embedded.slice(1, -1);
  embeddedSources.set(name, decoded);
  return decoded;
}

test('changed EM_JS bodies survive C stringification and JavaScript parsing', () => {
  for (const name of ['vrzno_init.js', 'vrzno_json.js', 'vrzno_values.js', 'vrzno_php_arrays.js',
    'vrzno_array_current.js', 'vrzno_array_valid.js', 'vrzno_index_read.js', 'vrzno_index_write.js',
    'vrzno_index_has.js', 'vrzno_index_unset.js', 'vrzno_timeout.js', 'vrzno_run.js',
    'vrzno_properties_json.js']) {
    assert.doesNotThrow(() => new Function(source(name)), name);
  }
});

// A real Wasm i64 identity function checks the JS argument and return ABI.
const wasm = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 6, 1, 96, 1, 126, 1, 126,
  3, 2, 1, 0,
  7, 12, 1, 8, 105, 100, 101, 110, 116, 105, 116, 121, 0, 0,
  10, 6, 1, 4, 0, 32, 0, 11,
))).exports;

function fixture() {
  const values = new Map(), strings = new Map(), calls = [], errors = [];
  let next = 1024;
  const pointer = value => {
    const result = next;
    next += 32;
    if (value !== undefined) values.set(result, value);
    return result;
  };
  const Module = {
    _arrays: new Map(),
    targets: new Map(),
    ownedZvalRegistry: { register() {} },
    vrznoCopyZval: value => value,
    vrznoAssertGeneration() {},
    ccall(name, returns, types, args) {
      calls.push({ name, returns, types, args });
      if (name === 'vrzno_expose_create_long') {
        assert.deepEqual(types, ['bigint', 'number']);
        assert.equal(typeof args[1], 'number', 'zval pointer remains wasm32 Number');
        values.set(args[1], wasm.identity(args[0]));
      } else if (name === 'vrzno_expose_create_null') values.set(args[0], null);
      else if (name === 'vrzno_expose_create_double') values.set(args[1], args[0]);
      else if (name === 'vrzno_expose_zval_deref') return args[0];
      else if (name === 'vrzno_expose_zval_target' || name === 'vrzno_expose_callable') return 0;
      else if (name === 'vrzno_expose_type') return typeof values.get(args[0]) === 'bigint' ? 4 : 5;
      else if (name === 'vrzno_expose_long') {
        assert.equal(returns, 'bigint');
        return wasm.identity(values.get(args[0]));
      } else if (name === 'vrzno_expose_double') return args[0];
      else if (name === 'vrzno_expose_type_error') errors.push(strings.get(args[0]));
      else if (name === 'vrzno_expose_dimension_pointer') {
        assert.deepEqual(types, ['number', 'bigint']);
        assert.equal(typeof args[0], 'number', 'array pointer remains wasm32 Number');
        return Module.array.get(wasm.identity(args[1])) ?? 0;
      } else if (name === 'vrzno_expose_array_length') return Module.array.size;
      else if (name === 'vrzno_expose_key_pointer') return Module.array.get(strings.get(args[1])) ?? 0;
      else throw new Error(`Unexpected native call ${name}`);
    },
  };
  new Function('Module', '_malloc', '_free', 'lengthBytesUTF8', 'stringToUTF8', 'getValue',
    [source('vrzno_init.js'), source('vrzno_json.js'), source('vrzno_values.js'), source('vrzno_php_arrays.js')].join('\n'))(
    Module, pointer, () => {}, value => Buffer.byteLength(value),
    (value, address) => strings.set(address, value), address => values.get(address),
  );
  return { Module, values, pointer, calls, errors };
}

test('PHP integers cross the real Wasm i64 ABI and become safe Numbers or exact BigInts', () => {
  const f = fixture();
  for (const integer of [-9223372036854775808n, -9007199254740992n, -9007199254740991n,
    -4294967296n, 0n, 2147483648n, 4294967296n, 9007199254740991n, 9007199254740992n,
    9007199254740993n, 9223372036854775807n]) {
    const value = f.Module.zvalToJS(f.pointer(integer));
    const safe = integer >= -9007199254740991n && integer <= 9007199254740991n;
    assert.equal(typeof value, safe ? 'number' : 'bigint');
    assert.equal(BigInt(value), integer);
    const target = f.pointer();
    f.Module.jsToZval(value, target);
    assert.equal(f.values.get(target), integer);
  }
});

test('unsafe Number values remain floats and out-of-range BigInts raise PHP type errors', () => {
  const f = fixture();
  for (const value of [9007199254740992, -9007199254740992, 1.5, Infinity, NaN]) {
    const target = f.pointer();
    f.Module.jsToZval(value, target);
    assert.equal(f.values.get(target), value);
  }
  for (const value of [-9223372036854775809n, 9223372036854775808n, 1n << 100n]) {
    const target = f.pointer();
    f.Module.jsToZval(value, target);
    assert.equal(f.values.get(target), null);
    assert.match(f.errors.at(-1), /signed 64-bit PHP integer range/);
  }
  assert.equal(f.Module.vrznoPhpTruthy(0n), false);
  assert.equal(f.Module.vrznoPhpTruthy(1n), true);
});

test('canonical array key normalization preserves the complete signed int64 range', () => {
  const { Module } = fixture();
  for (const key of ['-9223372036854775808', '-4294967296', '-1', '0', '2147483648',
    '4294967296', '9007199254740993', '9223372036854775807']) {
    assert.equal(BigInt(Module.vrznoNormalizeArrayKey(key)), BigInt(key));
  }
  for (const key of ['01', '-0', '+1', ' 1', '1 ', '1.0', '1e3', '9223372036854775808',
    '-9223372036854775809', '9'.repeat(1000), '']) {
    assert.equal(Module.vrznoNormalizeArrayKey(key), key);
  }
});

test('PHP array get, has and descriptors use exact i64 keys with wasm32 pointers', () => {
  const f = fixture();
  const integers = [-9223372036854775808n, -4294967296n, -1n, 0n, 4294967296n,
    9007199254740993n, 9223372036854775807n];
  f.Module.array = new Map(integers.map(integer => [integer, f.pointer(integer)]));
  const array = f.Module.marshalZArray(512, 256);
  for (const integer of integers) {
    const key = String(integer);
    assert.equal(key in array, true);
    assert.equal(BigInt(array[key]), integer);
    assert.equal(BigInt(Object.getOwnPropertyDescriptor(array, key).value), integer);
  }
  assert.equal('9007199254740992' in array, false);
});

test('legacy JSON argument transport preserves types, nesting and exact int64 tokens', () => {
  const { Module } = fixture();
  const value = Module.vrznoParseJson('[9223372036854775807,-9223372036854775808,9007199254740993,9007199254740992.0,{"text":"9223372036854775807","nested":[true,false,null,"a\\\"b","\\u263a"]}]');
  assert.deepEqual(value, [9223372036854775807n, -9223372036854775808n, 9007199254740993n,
    9007199254740992, {text: '9223372036854775807', nested: [true, false, null, 'a"b', '☺']}]);
  assert.deepEqual(Module.vrznoParseJson(' \t[\r\n-9223372036854775808, 1.5, 1e3]\n'),
    [-9223372036854775808n, 1.5, 1000]);
  const prototype = Module.vrznoParseJson('{"__proto__":{"max":9223372036854775807}}');
  assert.equal(Object.getPrototypeOf(prototype), Object.prototype);
  assert.equal(Object.hasOwn(prototype, '__proto__'), true);
  assert.equal(prototype.__proto__.max, 9223372036854775807n);
  for (const input of ['[1,]', '{"x":1,}', '01', '1e', '1x2', '1.', 'true false', '"unfinished', '{x:1}', '[1 2]']) {
    assert.throws(() => Module.vrznoParseJson(input), SyntaxError, input);
  }
  const ordinary = [null, true, false, 0, -0, 1.5, 1e50, '\n\t"\\', [1, 2], {x: 'y'}];
  for (const input of ordinary) {
    const json = JSON.stringify(input);
    assert.deepEqual(Module.vrznoParseJson(json), JSON.parse(json));
  }
});

test('timer import narrows a validated BigInt delay to Number', () => {
  let received;
  new Function('Module', 'milliseconds', 'callbackAddress', 'setTimeout', source('vrzno_timeout.js'))(
    { vrznoGeneration: 1, ownedZvalRegistry: {register() {}} }, 2147483647n, 256,
    (callback, timeout) => { received = timeout; },
  );
  assert.equal(received, 2147483647);
  assert.equal(typeof received, 'number');
});

test('object inspection snapshots preserve BigInt, nested JSON semantics and cycle bounds', () => {
  const { Module } = fixture();
  const inspect = target => {
    let json;
    const pointer = new Function('Module', 'targetId', '_malloc', 'lengthBytesUTF8', 'stringToUTF8',
      source('vrzno_properties_json.js'))(
      {targets: new Map([[1, target]])}, 1, () => 512,
      value => Buffer.byteLength(value), value => { json = value; },
    );
    assert.equal(pointer, 512);
    return Module.vrznoParseJson(json);
  };
  let getterCalls = 0;
  const object = {
    max: 9223372036854775807n, min: -9223372036854775808n,
    same: '9223372036854775807', '9223372036854775807': '9223372036854775807',
    'a\u0000b': 9223372036854775807n,
    'quoted"key\\': 'quote" backslash\\ escaped newline\n tab\t and unicode ☺',
    nested: [{text: '9223372036854775807', max: 9223372036854775807n}],
    get computed() { getterCalls++; return 9007199254740993n; },
    converted: {toJSON: () => ({value: 9223372036854775807n})},
  };
  const actual = inspect(object);
  assert.equal(actual.max, 9223372036854775807n);
  assert.equal(actual.min, -9223372036854775808n);
  assert.equal(actual.same, '9223372036854775807');
  assert.equal(actual['9223372036854775807'], '9223372036854775807');
  assert.equal(actual['a\u0000b'], 9223372036854775807n);
  assert.equal(actual['quoted"key\\'], 'quote" backslash\\ escaped newline\n tab\t and unicode ☺');
  assert.deepEqual(actual.nested, [{text: '9223372036854775807', max: 9223372036854775807n}]);
  assert.equal(actual.computed, 9007199254740993n);
  assert.equal(actual.converted.value, 9223372036854775807n);
  assert.equal(getterCalls, 1, 'Inspection must not re-read getters to choose markers');
  const cycle = {};
  cycle.self = cycle;
  assert.deepEqual(inspect(cycle), {});
  const first = {}, second = {};
  first.next = second;
  second.next = first;
  assert.deepEqual(inspect(first), {});
  assert.deepEqual(inspect({value: 9223372036854775808n}), {});
  if (typeof JSON.rawJSON === 'function') {
    assert.deepEqual(inspect({raw: JSON.rawJSON('"same"'), next: 9223372036854775807n}),
      {raw: 'same', next: 9223372036854775807n});
  }
});
