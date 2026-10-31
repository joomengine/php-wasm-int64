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
int64_extension_check($zip->close(), 'ZIP close failed');
int64_extension_check($zip->open('/tmp/int64-extension.zip') === true, 'ZIP reopen failed');
int64_extension_check($zip->getFromName('integer.txt') === $text, 'ZIP integer round trip failed');
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
int64_extension_check(iconv('UTF-8', 'UTF-8', $text) === $text, 'iconv round trip failed');
$formatter = new NumberFormatter('en_US', NumberFormatter::DECIMAL);
int64_extension_check($formatter->format(PHP_INT_MAX, NumberFormatter::TYPE_INT64) === '9,223,372,036,854,775,807', 'Intl truncated int64');
int64_extension_check(openssl_digest($text, 'sha256') === hash('sha256', $text), 'OpenSSL digest mismatch');

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('CREATE TABLE integers (value INTEGER NOT NULL)');
$insert = $pdo->prepare('INSERT INTO integers(value) VALUES (?)');
foreach ([PHP_INT_MIN, -4294967296, 4294967296, 9007199254740993, PHP_INT_MAX] as $value) {
    $insert->bindValue(1, $value, PDO::PARAM_INT);
    $insert->execute();
}
$actual = $pdo->query('SELECT value FROM integers ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN);
int64_extension_check($actual === [PHP_INT_MIN, -4294967296, 4294967296, 9007199254740993, PHP_INT_MAX], 'PDO SQLite int64 round trip failed');
$sqlite = new SQLite3(':memory:');
int64_extension_check($sqlite->querySingle('SELECT 9223372036854775807') === PHP_INT_MAX, 'SQLite3 truncated int64');

$archive = new PharData('/tmp/int64-extension.tar');
$archive->addFromString('integer.txt', $text);
int64_extension_check($archive['integer.txt']->getContent() === $text, 'Phar integer text round trip failed');
unset($archive);
unlink('/tmp/int64-extension.tar');

restore_error_handler();
echo "int64-extensions-ok\n";
