<?php
declare(strict_types=1);

function bridge_check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

bridge_check(PHP_INT_SIZE === 8, 'Bridge requires native int64 PHP');
$bridge = (new Vrzno)->__joomengineInt64;

foreach (['int32' => 2147483648, 'uint32' => 4294967296, 'safe' => 9007199254740991,
    'unsafe' => 9007199254740993, 'min' => PHP_INT_MIN, 'max' => PHP_INT_MAX] as $name => $expected) {
    bridge_check($bridge->$name === $expected, 'JavaScript to PHP: ' . $name);
    bridge_check($bridge->identity($expected) === $expected, 'Round trip: ' . $name);
}
bridge_check(is_float($bridge->unsafeNumber), 'An unsafe JS Number must stay a float');
bridge_check(is_float($bridge->negativeUnsafeNumber) && $bridge->negativeUnsafeNumber === -9007199254740992.0,
    'A negative unsafe JS Number must stay a float');
bridge_check($bridge->fraction === 1.5 && is_nan($bridge->nan)
    && is_infinite($bridge->positiveInfinity) && $bridge->positiveInfinity > 0
    && is_infinite($bridge->negativeInfinity) && $bridge->negativeInfinity < 0,
    'Fractional and nonfinite JS Numbers retain float semantics');
bridge_check($bridge->kind(2147483648) === 'number:2147483648', 'Safe PHP int becomes Number');
bridge_check($bridge->kind(9007199254740991) === 'number:9007199254740991', 'Safe integer boundary');
bridge_check($bridge->kind(9007199254740993) === 'bigint:9007199254740993', 'Unsafe PHP int becomes BigInt');
bridge_check($bridge->kind(PHP_INT_MIN) === 'bigint:-9223372036854775808', 'Minimum stays exact');
bridge_check($bridge->kind(PHP_INT_MAX) === 'bigint:9223372036854775807', 'Maximum stays exact');

foreach (['overflow', 'underflow'] as $operation) {
    $rejected = false;
    try {
        $bridge->$operation();
    } catch (TypeError $error) {
        $rejected = str_contains($error->getMessage(), 'signed 64-bit PHP integer range');
    }
    bridge_check($rejected, 'Out-of-range BigInt must raise TypeError: ' . $operation);
}
bridge_check($bridge->identity(42) === 42, 'Runtime remains usable after overflow');
bridge_check(isset($bridge->zero) && empty($bridge->zero), 'BigInt zero has PHP integer truthiness');
bridge_check($bridge->callback(static fn(int $value): int => $value) === PHP_INT_MAX, 'Typed PHP callback int64');
bridge_check(vrzno_await($bridge->promise()) === 9007199254740993, 'Promise result int64');
foreach ([PHP_INT_MIN, -9007199254740993, -9007199254740991, 0, 9007199254740992,
    9007199254740993, PHP_INT_MAX] as $expected) {
    bridge_check($bridge->callbackWith(static fn(int $value): int => $value, $expected) === $expected,
        'Typed callback boundary: ' . $expected);
    bridge_check(vrzno_await($bridge->promiseOf($expected)) === $expected, 'Promise boundary: ' . $expected);
    $bridge->written = $expected;
    bridge_check($bridge->written === $expected, 'Property write boundary: ' . $expected);
}
foreach (['tooHigh', 'tooLow'] as $property) {
    $rejected = false;
    try {
        $value = $bridge->$property;
    } catch (TypeError $error) {
        $rejected = str_contains($error->getMessage(), 'signed 64-bit PHP integer range');
    }
    bridge_check($rejected, 'Out-of-range BigInt property: ' . $property);
}
foreach (['callback', 'promise'] as $transport) {
    $rejected = false;
    try {
        if ($transport === 'callback') {
            $bridge->overflowCallback(static fn(int $value): int => $value);
        } else {
            vrzno_await($bridge->overflowPromise());
        }
    } catch (TypeError $error) {
        $rejected = str_contains($error->getMessage(), 'signed 64-bit PHP integer range');
    }
    bridge_check($rejected, 'Out-of-range BigInt through ' . $transport);
}
$callbackRejected = false;
try {
    $bridge->callback(static function (int $value): int { throw new LogicException('Int64 callback rejection'); });
} catch (LogicException $error) {
    $callbackRejected = $error->getMessage() === 'Int64 callback rejection';
}
bridge_check($callbackRejected, 'PHP callback exception is preserved');
$promiseRejected = false;
try {
    vrzno_await($bridge->rejectedPromise());
} catch (RuntimeException $error) {
    $promiseRejected = str_contains($error->getMessage(), 'Int64 promise rejection');
}
bridge_check($promiseRejected, 'Rejected Promise becomes a PHP exception');
bridge_check($bridge->callback(static fn(int $value): int => $value) === PHP_INT_MAX
    && vrzno_await($bridge->promise()) === 9007199254740993, 'Callback and Promise recovery after exceptions');

$array = [PHP_INT_MIN => 'min', -4294967296 => 'negative', -1 => 'minus-one',
    0 => 'zero', 2147483648 => 'int32', 4294967296 => 'uint32', 9007199254740993 => 'unsafe',
    PHP_INT_MAX => 'max', '01' => 'leading-zero', '-0' => 'negative-zero',
    '9223372036854775808' => 'out-of-range'];
bridge_check($bridge->inspectArray($array), 'PHP array int64 keys');
$actual = [];
foreach ($bridge->iterable as $key => $value) {
    $actual[$key] = $value;
}
bridge_check($actual === [2147483648, 9007199254740993, PHP_INT_MAX], 'JS array iteration');
bridge_check($bridge->indexed[PHP_INT_MIN] === 'minimum', 'Read minimum JS property index');
bridge_check($bridge->indexed[PHP_INT_MAX] === 'maximum', 'Read maximum JS property index');
$bridge->indexed[9007199254740993] = PHP_INT_MAX;
bridge_check(isset($bridge->indexed[9007199254740993]), 'Has int64 JS property');
bridge_check($bridge->indexed[9007199254740993] === PHP_INT_MAX, 'Write int64 JS property');
unset($bridge->indexed[9007199254740993]);
bridge_check(!isset($bridge->indexed[9007199254740993]), 'Unset int64 JS property');

$properties = (array) $bridge->inspectable;
bridge_check($properties['min'] === PHP_INT_MIN && $properties['max'] === PHP_INT_MAX
    && $properties['text'] === 'retained', 'Object inspection preserves BigInt properties');
bridge_check($properties["a\0b"] === PHP_INT_MAX && $properties['a'] === 1,
    'Object inspection preserves embedded-NUL property names');
bridge_check($properties['quoted"key\\'] === "quote\" backslash\\ newline\n tab\t unicode ☺",
    'Object inspection preserves escaped keys and values');
bridge_check($properties['boxed'] === PHP_INT_MIN && $properties['converted'] === ['max' => PHP_INT_MAX],
    'Object inspection preserves boxed BigInts and custom JSON values');
bridge_check($properties['nested'] === [['max' => PHP_INT_MAX, 'text' => '9223372036854775807']],
    'Nested properties retain detached JSON snapshot semantics');
bridge_check((array) $bridge->cycle === [] && (array) $bridge->mutualCycle === [],
    'Cyclic JS objects retain bounded empty inspection snapshots');
bridge_check(vrzno_run('__joomengineInt64Legacy', [PHP_INT_MIN, PHP_INT_MAX, 9007199254740993,
    9007199254740991, 9007199254740992.0]) ===
    'bigint:-9223372036854775808|bigint:9223372036854775807|bigint:9007199254740993|number:9007199254740991|number:9007199254740992',
    'Legacy helper retains exact integers and float types');
bridge_check(vrzno_run('__joomengineInt64LegacyNested', [[(object) ['max' => PHP_INT_MAX,
    'text' => '9223372036854775807', 'quoted"key\\' => "quote\" backslash\\ newline\n tab\t unicode ☺",
    "a\0b" => PHP_INT_MIN], 9007199254740992.0]]) === 'nested-ok', 'Legacy nested arguments');
$serializationRejected = false;
try {
    vrzno_run('__joomengineInt64Legacy', [new class implements JsonSerializable {
        public function jsonSerialize(): mixed { throw new LogicException('Original serialization failure'); }
    }]);
} catch (LogicException $error) {
    $serializationRejected = $error->getMessage() === 'Original serialization failure';
}
bridge_check($serializationRejected, 'Legacy helper preserves serialization exceptions');

foreach ([-1, 2147483648, PHP_INT_MIN, PHP_INT_MAX] as $milliseconds) {
    $timerRejected = false;
    try {
        vrzno_timeout($milliseconds, static function (): void {});
    } catch (ValueError $error) {
        $timerRejected = true;
    }
    bridge_check($timerRejected, 'Browser timer range is checked before narrowing: ' . $milliseconds);
}
echo "int64-bridge-ok\n";
