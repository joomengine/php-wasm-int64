<?php
declare(strict_types=1);

set_error_handler(static function (int $severity, string $message, string $file, int $line): never {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

function int64_extension_check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

int64_extension_check(PHP_INT_SIZE === 8, 'Extension runtime is not int64');
foreach (['dom', 'zlib', 'zip', 'gd', 'iconv', 'intl', 'openssl', 'mbstring', 'Phar',
    'sqlite3', 'pdo_sqlite', 'xml', 'SimpleXML', 'xmlreader', 'xmlwriter', 'fileinfo'] as $extension) {
    int64_extension_check(extension_loaded($extension), 'Missing required extension: ' . $extension);
}

$text = (string) PHP_INT_MAX;
$document = new DOMDocument();
int64_extension_check($document->loadXML('<number value="' . $text . '"/>'), 'DOM XML parse failed');
int64_extension_check($document->documentElement->getAttribute('value') === $text, 'DOM changed integer text');
$simple = simplexml_load_string('<number>' . $text . '</number>');
int64_extension_check((string) $simple === $text, 'SimpleXML changed integer text');
$reader = new XMLReader();
int64_extension_check($reader->XML('<number>' . $text . '</number>'), 'XMLReader initialization failed');
while ($reader->read() && $reader->nodeType !== XMLReader::TEXT) {
}
int64_extension_check($reader->value === $text, 'XMLReader changed integer text');
$reader->close();
$writer = new XMLWriter();
$writer->openMemory();
$writer->writeElement('number', $text);
int64_extension_check(str_contains($writer->outputMemory(), $text), 'XMLWriter changed integer text');
$parser = xml_parser_create();
int64_extension_check(xml_parse($parser, '<number>' . $text . '</number>', true) === 1, 'XML parser failed');

$zip = new ZipArchive();
int64_extension_check($zip->open('/tmp/int64-extension.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE) === true, 'ZIP creation failed');
int64_extension_check($zip->addFromString('integer.txt', $text), 'ZIP write failed');
int64_extension_check($zip->addFromString('range.txt', 'abc'), 'ZIP range fixture write failed');
int64_extension_check($zip->close(), 'ZIP close failed');
int64_extension_check($zip->open('/tmp/int64-extension.zip') === true, 'ZIP reopen failed');
int64_extension_check($zip->getFromName('integer.txt') === $text, 'ZIP integer round trip failed');
int64_extension_check($zip->getFromName('range.txt', 2) === 'ab', 'ZIP bounded read failed');
int64_extension_check($zip->getFromIndex(1, 0) === 'abc', 'ZIP zero-length full read failed');
int64_extension_check($zip->getFromName('range.txt', -1) === 'abc', 'ZIP negative-length full read failed');
foreach ([static fn () => $zip->getFromName('range.txt', 4294967296),
    static fn () => $zip->getFromIndex(1, 4294967297)] as $readPastLimit) {
    $lengthRejected = false;
    try {
        $readPastLimit();
    } catch (ValueError $error) {
        $lengthRejected = true;
    }
    int64_extension_check($lengthRejected, 'ZIP wrapped a 64-bit read length');
}
$zip->close();
unlink('/tmp/int64-extension.zip');
int64_extension_check(gzuncompress(gzcompress($text)) === $text, 'zlib round trip failed');

$image = imagecreatetruecolor(2, 2);
ob_start();
imagepng($image);
$png = ob_get_clean();
int64_extension_check(str_starts_with($png, "\x89PNG\r\n\x1a\n"), 'GD did not produce PNG');
int64_extension_check((new finfo(FILEINFO_MIME_TYPE))->buffer($png) === 'image/png', 'fileinfo PNG recognition failed');
int64_extension_check(mb_strtoupper('é', 'UTF-8') === 'É', 'mbstring UTF-8 conversion failed');
int64_extension_check(mb_substr('abc', 4294967296, null, 'UTF-8') === '', 'mb_substr wrapped a 64-bit offset');
int64_extension_check(mb_substr('abc', 0, 4294967296, 'UTF-8') === 'abc', 'mb_substr wrapped a 64-bit length');
$fixedWidthText = "A\0\0\0B\0\0\0";
int64_extension_check(mb_substr($fixedWidthText, 0, 1073741824, 'UTF-32LE') === $fixedWidthText, 'mb_substr overflowed a fixed-width byte length');
int64_extension_check(mb_substr($fixedWidthText, 1073741824, null, 'UTF-32LE') === '', 'mb_substr overflowed a fixed-width byte offset');
int64_extension_check(mb_strcut('abc', 4294967296, null, 'UTF-8') === '', 'mb_strcut wrapped a 64-bit offset');
int64_extension_check(mb_strcut('abc', 0, 4294967296, 'UTF-8') === 'abc', 'mb_strcut wrapped a 64-bit length');
int64_extension_check(mb_strimwidth('abc', 0, 4294967296, '', 'UTF-8') === 'abc', 'mb_strimwidth wrapped a 64-bit width');
foreach (['mb_strpos', 'mb_strrpos', 'mb_stripos', 'mb_strripos'] as $search) {
    foreach ([4294967296, -4294967296, PHP_INT_MIN, PHP_INT_MAX] as $offset) {
        $offsetRejected = false;
        try {
            $search('abc', 'a', $offset, 'UTF-8');
        } catch (ValueError $error) {
            $offsetRejected = true;
        }
        int64_extension_check($offsetRejected, $search . ' accepted an out-of-range 64-bit offset');
    }
}
$paddingRejected = false;
try {
    mb_str_pad('x', 4294967296);
} catch (Error $error) {
    $paddingRejected = true;
}
int64_extension_check($paddingRejected, 'mb_str_pad must reject output larger than wasm32 memory');
if (function_exists('mb_ereg_search_setpos')) {
    mb_ereg_search_init('abc', 'a');
    $offsetRejected = false;
    try {
        mb_ereg_search_setpos(4294967296);
    } catch (ValueError $error) {
        $offsetRejected = true;
    }
    int64_extension_check($offsetRejected, 'mb_ereg_search_setpos wrapped a 64-bit offset');
}
int64_extension_check(iconv('UTF-8', 'UTF-8', $text) === $text, 'iconv round trip failed');
$formatter = new NumberFormatter('en_US', NumberFormatter::DECIMAL);
int64_extension_check($formatter->format(PHP_INT_MAX, NumberFormatter::TYPE_INT64) === '9,223,372,036,854,775,807', 'Intl truncated int64');
$dateFormatter = new IntlDateFormatter('en_US', IntlDateFormatter::NONE, IntlDateFormatter::NONE,
    'UTC', IntlDateFormatter::GREGORIAN, 'yyyy-MM-dd HH:mm:ss');
int64_extension_check($dateFormatter->parse('2040-01-01 00:00:00') === 2208988800, 'Intl truncated a post-2038 timestamp');
int64_extension_check(openssl_digest($text, 'sha256') === hash('sha256', $text), 'OpenSSL digest mismatch');
foreach ([4294967296, PHP_INT_MAX] as $length) {
    $lengthRejected = false;
    try {
        // Invalid keys keep this regression safe even before the length guard exists.
        openssl_pkey_derive('', '', $length);
    } catch (ValueError $error) {
        $lengthRejected = true;
    }
    int64_extension_check($lengthRejected, 'OpenSSL did not reject an unrepresentable derived-key length before parsing keys');
}
$privateKey = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
int64_extension_check($privateKey !== false, 'OpenSSL EC key generation failed');
$publicKey = openssl_pkey_get_details($privateKey)['key'];
int64_extension_check(strlen(openssl_pkey_derive($publicKey, $privateKey)) === 32, 'OpenSSL default derived-key length changed');

$pdo = class_exists(Pdo\Sqlite::class) ? new Pdo\Sqlite('sqlite::memory:') : new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('CREATE TABLE integers (value INTEGER NOT NULL)');
$insert = $pdo->prepare('INSERT INTO integers(value) VALUES (?)');
$boundaryIntegers = [PHP_INT_MIN, -4294967296, 4294967296, 9007199254740993, PHP_INT_MAX];
foreach ($boundaryIntegers as $value) {
    $insert->bindValue(1, $value, PDO::PARAM_INT);
    $insert->execute();
}
$actual = $pdo->query('SELECT value FROM integers ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN);
int64_extension_check($actual === $boundaryIntegers, 'PDO SQLite int64 round trip failed');
$createFunction = method_exists($pdo, 'createFunction') ? 'createFunction' : 'sqliteCreateFunction';
int64_extension_check($pdo->$createFunction('int64_identity', static fn (int $value): int => $value, 1), 'PDO SQLite UDF registration failed');
$viaFunction = $pdo->query('SELECT int64_identity(value) FROM integers ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN);
int64_extension_check($viaFunction === $boundaryIntegers, 'PDO SQLite UDF integer argument/result round trip failed');
foreach ($boundaryIntegers as $index => $value) {
    $function = 'int64_return_' . $index;
    int64_extension_check($pdo->$createFunction($function, static fn (): int => $value, 0), 'PDO SQLite zero-argument UDF registration failed');
    int64_extension_check($pdo->query('SELECT ' . $function . '()')->fetchColumn() === $value, 'PDO SQLite UDF truncated an integer return value');
}
$sqlite = new SQLite3(':memory:');
int64_extension_check($sqlite->querySingle('SELECT 9223372036854775807') === PHP_INT_MAX, 'SQLite3 truncated int64');

$archive = new PharData('/tmp/int64-extension.tar');
$archive->addFromString('integer.txt', $text);
int64_extension_check($archive['integer.txt']->getContent() === $text, 'Phar integer text round trip failed');
unset($archive);
unlink('/tmp/int64-extension.tar');

restore_error_handler();
echo "int64-extensions-ok\n";
