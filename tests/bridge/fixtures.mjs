/** Install deterministic host values in the same realm as the PHP runtime. */
export function installBridgeFixtures(host = globalThis) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const keys = new Map([
    ['-9223372036854775808', 'min'], ['-4294967296', 'negative'], ['-1', 'minus-one'],
    ['0', 'zero'], ['2147483648', 'int32'], ['4294967296', 'uint32'],
    ['9007199254740993', 'unsafe'], ['9223372036854775807', 'max'],
    ['01', 'leading-zero'], ['-0', 'negative-zero'], ['9223372036854775808', 'out-of-range'],
  ]);
  const cycle = {};
  cycle.self = cycle;
  const first = {}, second = {};
  first.next = second;
  second.next = first;
  host.__joomengineInt64 = {
    int32: 2147483648,
    uint32: 4294967296,
    safe: Number.MAX_SAFE_INTEGER,
    unsafeNumber: 9007199254740992,
    unsafe: 9007199254740993n,
    min: -9223372036854775808n,
    max: 9223372036854775807n,
    zero: 0n,
    iterable: [2147483648n, 9007199254740993n, 9223372036854775807n],
    indexed: {'-9223372036854775808': 'minimum', '9223372036854775807': 'maximum'},
    inspectable: {min: -9223372036854775808n, max: 9223372036854775807n, text: 'retained',
      'a\u0000b': 9223372036854775807n, a: 1,
      nested: [{max: 9223372036854775807n, text: '9223372036854775807'}]},
    cycle,
    mutualCycle: first,
    identity: value => value,
    kind: value => `${typeof value}:${value}`,
    overflow: () => 9223372036854775808n,
    underflow: () => -9223372036854775809n,
    callback: callback => callback(9223372036854775807n),
    promise: () => Promise.resolve(9007199254740993n),
    inspectArray: array => {
      const actual = Object.keys(array);
      check(actual.length === keys.size, `Unexpected PHP array keys: ${actual}`);
      for (const [key, value] of keys) {
        check(key in array, `Missing PHP key ${key}`);
        check(array[key] === value, `Wrong PHP value for ${key}`);
        check(Object.getOwnPropertyDescriptor(array, key)?.value === value, `Wrong PHP descriptor for ${key}`);
      }
      check(!('9007199254740992' in array), 'Adjacent unsafe keys must stay distinct');
      return true;
    },
  };
  host.__joomengineInt64Legacy = (...values) => values.map(value => `${typeof value}:${value}`).join('|');
  host.__joomengineInt64LegacyNested = value => {
    check(Array.isArray(value), 'Legacy PHP array remains a detached JS array');
    check(Object.getPrototypeOf(value[0]) === Object.prototype, 'Legacy object remains a detached JS object');
    check(value[0].max === 9223372036854775807n, 'Nested int64 lost precision');
    check(value[0].text === '9223372036854775807', 'Numeric strings remain strings');
    check(value[1] === 9007199254740992 && typeof value[1] === 'number', 'PHP float remains Number');
    return 'nested-ok';
  };
  return host.__joomengineInt64;
}
