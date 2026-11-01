<?php
declare(strict_types=1);

/** Native integer and mixed-width address regression checks for wasm32-int64. */
function int64_check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function int64_same(mixed $expected, mixed $actual, string $message): void
{
    int64_check($expected === $actual, $message . ': ' . var_export($actual, true));
}

function int64_throws(callable $operation, string $class, string $message): void
{
    try {
        $operation();
    } catch (Throwable $error) {
        int64_same($class, get_class($error), $message . ' exception class');
        return;
    }
    throw new RuntimeException($message . ': expected ' . $class);
}

set_error_handler(static function (int $severity, string $message, string $file, int $line): never {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

int64_same(8, PHP_INT_SIZE, 'PHP integer width');
$expectedVersion = getenv('JOOMENGINE_EXPECTED_PHP_VERSION');
int64_check(is_string($expectedVersion) && $expectedVersion !== '', 'expected PHP release is provided by the manifest');
int64_same($expectedVersion, PHP_VERSION, 'runtime matches the pinned PHP release');
int64_same('9223372036854775807', (string) PHP_INT_MAX, 'maximum signed integer');
int64_same('-9223372036854775808', (string) PHP_INT_MIN, 'minimum signed integer');

ob_start();
phpinfo(INFO_GENERAL);
$information = ob_get_clean();
int64_check(substr_count($information, 'wasm32-int64') >= 2, 'PHP and Zend extension ABI identifiers');

int64_same(2147483648, 2147483647 + 1, 'addition beyond int32');
int64_same(4294967296, 65536 * 65536, 'multiplication beyond int32');
int64_same(9223372030926249001, 3037000499 * 3037000499, 'exact multiplication near int64 maximum');
int64_same(9007199254740993, 9007199254740992 + 1, 'integer beyond JavaScript Number precision');
int64_same(3074457345618258602, intdiv(PHP_INT_MAX, 3), '64-bit integer division');
int64_same(1099511627776, 1 << 40, 'left shift');
int64_same(PHP_INT_MIN, 1 << 63, 'signed high bit');
int64_same(-1, PHP_INT_MIN >> 63, 'arithmetic right shift');
int64_same(4294967295, hexdec('ffffffff'), 'hexadecimal conversion');
int64_same(PHP_INT_MAX, intval('9223372036854775807'), 'decimal parsing maximum');
int64_same(PHP_INT_MIN, intval('-9223372036854775808'), 'decimal parsing minimum');
int64_check(is_float(PHP_INT_MAX + 1), 'overflow addition becomes float');
int64_check(is_float(PHP_INT_MIN - 1), 'underflow subtraction becomes float');
int64_check(is_float(PHP_INT_MAX * 2), 'overflow multiplication becomes float');
int64_throws(static fn () => intdiv(PHP_INT_MIN, -1), ArithmeticError::class, 'division overflow');
$increment = 2147483647;
int64_same(2147483648, ++$increment, 'increment beyond int32');
$decrement = -2147483648;
int64_same(-2147483649, --$decrement, 'decrement beyond int32');

// These keys deliberately collide in their low 32 bits.
$keys = [1, 4294967297, 9007199254740993, PHP_INT_MAX, PHP_INT_MIN];
$values = [];
foreach ($keys as $index => $key) {
    $values[$key] = 'entry-' . $index;
}
int64_same($keys, array_keys($values), 'full-width hash keys');
foreach ($keys as $index => $key) {
    int64_same('entry-' . $index, $values[$key], 'hash lookup ' . $index);
}
$copy = $values;
int64_same($values, unserialize(serialize($copy)), 'serialization preserves integer keys');
$numericKeys = ['4294967297' => 'large'];
int64_same([4294967297], array_keys($numericKeys), 'numeric string key conversion');
$object = (object) ['value' => PHP_INT_MAX];
$reference = &$object->value;
int64_same(PHP_INT_MAX, $reference, 'object and reference copy');
int64_same(PHP_INT_MAX, (static fn (int $value): int => $value)(PHP_INT_MAX), 'typed argument and return');

$fiber = new Fiber(static function (int $initial): int {
    int64_same(PHP_INT_MAX, $initial, 'fiber start argument');
    $resumed = Fiber::suspend(PHP_INT_MIN);
    int64_same(PHP_INT_MAX, $resumed, 'fiber resume argument');
    return PHP_INT_MIN;
});
int64_same(PHP_INT_MIN, $fiber->start(PHP_INT_MAX), 'fiber suspension value');
int64_check($fiber->isSuspended(), 'fiber suspends');
int64_same(null, $fiber->resume(PHP_INT_MAX), 'fiber resume completes');
int64_same(PHP_INT_MIN, $fiber->getReturn(), 'fiber return value');
$throwingFiber = new Fiber(static function (): void {
    Fiber::suspend(PHP_INT_MAX);
    throw new LogicException('fiber exception');
});
int64_same(PHP_INT_MAX, $throwingFiber->start(), 'throwing fiber suspension value');
int64_throws(static fn () => $throwingFiber->resume(), LogicException::class, 'fiber exception propagation');
int64_check($throwingFiber->isTerminated(), 'throwing fiber terminates');

$numbers = [PHP_INT_MIN, PHP_INT_MAX, 9007199254740993];
int64_same($numbers, json_decode(json_encode($numbers, JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR), 'PHP JSON integer round trip');
int64_same('18446744073709551615', json_decode('18446744073709551615', true, 512, JSON_BIGINT_AS_STRING | JSON_THROW_ON_ERROR), 'unsigned overflow remains an exact string');
int64_same('7fffffffffffffff', bin2hex(pack('J', PHP_INT_MAX)), 'big-endian uint64 packing');
int64_same(PHP_INT_MAX, unpack('Jvalue', hex2bin('7fffffffffffffff'))['value'], 'big-endian uint64 unpacking');
int64_same('0000000000000080', bin2hex(pack('q', PHP_INT_MIN)), 'signed int64 packing on wasm little endian');
int64_same(PHP_INT_MIN, unpack('qvalue', hex2bin('0000000000000080'))['value'], 'signed int64 unpacking');

$utc = new DateTimeZone('UTC');
int64_same(2208988800, (new DateTimeImmutable('2040-01-01 00:00:00', $utc))->getTimestamp(), 'timestamp beyond 2038');
int64_same(-2208988800, (new DateTimeImmutable('1900-01-01 00:00:00', $utc))->getTimestamp(), 'timestamp before 1901');
int64_same('2106-02-07 06:28:16', (new DateTimeImmutable('@4294967296'))->format('Y-m-d H:i:s'), 'timelib 64-bit timestamp conversion');

// Memory stays wasm32. Out-of-range offsets must not wrap to an in-bounds byte.
$text = 'abc';
foreach ([4294967296, 4294967297, PHP_INT_MAX, PHP_INT_MIN] as $offset) {
    int64_same(false, isset($text[$offset]), 'isset out-of-range offset');
    int64_same(true, empty($text[$offset]), 'empty out-of-range offset');
    int64_throws(static fn () => $text[$offset], ErrorException::class, 'string read out-of-range offset');
}
int64_same('c', $text[-1], 'negative string offset remains valid');
foreach ([4294967296, 4294967297, PHP_INT_MAX] as $offset) {
    int64_throws(static function () use ($offset): void {
        $value = 'abc';
        $value[$offset] = 'x';
    }, Error::class, 'string write exceeds addressable size');
    foreach (['strpos', 'stripos', 'strrpos', 'strripos'] as $function) {
        int64_throws(static fn () => $function('abcabc', 'a', $offset), ValueError::class, $function . ' offset narrowing');
        int64_throws(static fn () => $function('abcabc', 'a', -$offset), ValueError::class, $function . ' negative offset narrowing');
    }
    int64_throws(static fn () => substr_count('abcabc', 'a', $offset), ValueError::class, 'substr_count offset narrowing');
    int64_throws(static fn () => substr_count('abcabc', 'a', 0, $offset), ValueError::class, 'substr_count length narrowing');
    int64_throws(static fn () => substr_compare('abc', 'a', $offset), ValueError::class, 'substr_compare offset narrowing');
    // These are rejected by length checks before any large allocation occurs.
    int64_throws(static fn () => str_repeat('x', $offset), ValueError::class, 'str_repeat size narrowing');
    int64_throws(static fn () => str_pad('x', $offset), ValueError::class, 'str_pad size narrowing');
}
int64_check(substr_compare('abc', 'abd', 0, 4294967296) < 0, 'large comparison length is not truncated');
int64_same('abc', substr('abc', 0, 4294967296), 'large substring length clamps');
int64_same('', substr('abc', 4294967296), 'large substring offset clamps');
int64_same('abc', substr('abc', PHP_INT_MIN), 'minimum negative substring offset clamps');
int64_same('', substr('abc', 0, PHP_INT_MIN), 'minimum negative substring length clamps');
int64_same('abc!', chunk_split('abc', 4294967296, '!'), 'large chunk length clamps');
int64_same(['abc'], str_split('abc', 4294967296), 'large split length clamps');
int64_same('abcx', substr_replace('abc', 'x', 4294967296), 'large replacement offset clamps');
int64_same('x', substr_replace('abc', 'x', 0, 4294967296), 'large replacement length clamps');

$stream = fopen('php://memory', 'w+b');
int64_check(is_resource($stream), 'create memory stream');
int64_same(3, fwrite($stream, 'abc', 4294967296), 'large write limit clamps to actual input');
rewind($stream);
int64_same('abc', stream_get_contents($stream), 'ordinary stream read preserves content');
foreach ([4294967296, PHP_INT_MAX] as $length) {
    int64_throws(static fn () => fread($stream, $length), ValueError::class, 'fread allocation narrowing');
    int64_throws(static fn () => fgets($stream, $length), ValueError::class, 'fgets allocation narrowing');
    int64_throws(static fn () => fgetcsv($stream, $length, ',', '"', ''), ValueError::class, 'fgetcsv allocation narrowing');
    int64_throws(static fn () => stream_get_contents($stream, $length), ValueError::class, 'stream_get_contents allocation narrowing');
    int64_throws(static fn () => stream_get_line($stream, $length), ValueError::class, 'stream_get_line allocation narrowing');
    int64_throws(static fn () => file_get_contents('php://memory', false, null, 0, $length), ValueError::class, 'file_get_contents allocation narrowing');
    int64_throws(static fn () => random_bytes($length), ValueError::class, 'random_bytes allocation narrowing');
}
fclose($stream);

restore_error_handler();
echo "int64-core-ok\n";
