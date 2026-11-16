<?php
/** Real callers for the virtual Sendmail contract. All addresses are non-deliverable. */
require_once '/int64-mail/vendor/Exception.php';
require_once '/int64-mail/vendor/PHPMailer.php';

use PHPMailer\PHPMailer\PHPMailer;

$expectCapture = getenv('JOOMENGINE_MAIL_EXPECT_CAPTURE') !== '0';
$expected = [];
$assertMail = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};
$makeMailer = static function (string $case, string $outcome = 'accept'): PHPMailer {
    $mailer = new PHPMailer(false);
    $mailer->isSendmail();
    $mailer->Sendmail = '/usr/sbin/sendmail';
    $mailer->CharSet = 'UTF-8';
    $mailer->setFrom('author@example.invalid', 'Mail author');
    $mailer->Sender = 'bounce-tag@example.invalid';
    $mailer->addAddress('recipient@example.invalid', 'Mail recipient');
    $mailer->addCC('copy@example.invalid');
    $mailer->addBCC('hidden@example.invalid');
    $mailer->Subject = 'UTF-8 subject: Grüße — 日本語';
    $mailer->MessageID = '<fixture-' . $case . '@example.invalid>';
    $mailer->MessageDate = 'Mon, 16 Nov 2026 12:00:00 +0000';
    $mailer->addCustomHeader('X-Capture-Case', $case);
    $mailer->addCustomHeader('X-Capture-Result', $outcome);
    $mailer->isHTML(true);
    $mailer->Body = '<p>HTML body: Grüße 日本語</p>';
    $mailer->AltBody = 'Plain text body: Grüße 日本語';
    $mailer->addStringAttachment("attachment\0\xff\x80\r\nend", 'fixture.bin', 'base64', 'application/octet-stream');
    return $mailer;
};

if (!$expectCapture) {
    $assertMail(@mail('recipient@example.invalid', 'missing handler', 'body') === false, 'mail() reported success without a host handler');
    $pipe = @popen('/usr/sbin/sendmail -t -i', 'w');
    if (is_resource($pipe)) {
        fwrite($pipe, "Subject: missing handler\r\n\r\nbody");
        $assertMail(@pclose($pipe) !== 0, 'pclose() reported success without a host handler');
    }
    $mailer = $makeMailer('missing-handler');
    $assertMail($mailer->send() === false && $mailer->ErrorInfo !== '', 'PHPMailer reported success without a host handler');
    echo json_encode(['passed' => true, 'captures' => []], JSON_THROW_ON_ERROR) . "\n";
    return;
}

$body = "UTF-8 body: Grüße 日本語\r\n" . str_repeat('message-bytes-', 6000) . "\r\nmail-body-end";
$headers = "From: author@example.invalid\r\nX-Capture-Case: php-mail\r\nX-Capture-Result: accept";
$assertMail(mail('recipient@example.invalid', 'ordinary PHP mail', $body, $headers, '-fbounce@example.invalid') === true, 'mail() did not accept a captured message');
$expected[] = ['case' => 'php-mail', 'body' => $body, 'sender' => 'bounce@example.invalid', 'recipients' => [], 'readHeaders' => true];

// Two simultaneously open pipes close in the opposite order. Their buffers and
// envelope arguments must remain independent, including NUL and non-UTF-8 bytes.
$commands = [
    "'/usr/sbin/sendmail' -oi -f'first+tag@example.invalid' -t",
    '/usr/sbin/sendmail -i -f "second@example.invalid" "one@example.invalid" two@example.invalid',
];
$raw = [
    "X-Capture-Case: pipe-first\r\nSubject: byte exact\r\n\r\nfirst\0\xff\x80last",
    "X-Capture-Case: pipe-second\r\nSubject: second\r\n\r\nsecond\0\xfe\r\nlast",
];
$pipes = [];
foreach ($commands as $index => $command) {
    $pipes[$index] = popen($command, 'w');
    $assertMail(is_resource($pipes[$index]), 'popen() did not open an allowed command');
    $first = substr($raw[$index], 0, 13);
    $rest = substr($raw[$index], 13);
    $assertMail(fwrite($pipes[$index], $first) === strlen($first), 'first stream write was incomplete');
    $assertMail(fwrite($pipes[$index], $rest) === strlen($rest), 'second stream write was incomplete');
    $assertMail(fflush($pipes[$index]), 'stream flush failed');
}
$assertMail(pclose($pipes[1]) === 0 && pclose($pipes[0]) === 0, 'pclose() did not return successful capture status');
$expected[] = ['case' => 'pipe-second', 'raw' => base64_encode($raw[1]), 'sender' => 'second@example.invalid', 'recipients' => ['one@example.invalid', 'two@example.invalid'], 'readHeaders' => false];
$expected[] = ['case' => 'pipe-first', 'raw' => base64_encode($raw[0]), 'sender' => 'first+tag@example.invalid', 'recipients' => [], 'readHeaders' => true];

$mailer = $makeMailer('phpmailer');
$assertMail($mailer->preSend(), 'PHPMailer could not build its MIME message');
$expectedMime = $mailer->getSentMIMEMessage();
$assertMail($mailer->postSend(), 'PHPMailer Sendmail did not accept a captured message: ' . $mailer->ErrorInfo);
$expected[] = ['case' => 'phpmailer', 'raw' => base64_encode($expectedMime), 'sender' => 'bounce-tag@example.invalid', 'recipients' => [], 'readHeaders' => true];

// PHPMailer deliberately omits -f for plus-addresses in isShellSafe(). The host
// must preserve that omission instead of inventing an envelope from the headers.
$mailer = $makeMailer('phpmailer-plus-sender');
$mailer->Sender = 'bounce+tag@example.invalid';
$assertMail($mailer->preSend(), 'PHPMailer could not prepare the plus-sender message');
$expectedMime = $mailer->getSentMIMEMessage();
$assertMail($mailer->postSend(), 'PHPMailer did not accept the plus-sender message');
$expected[] = ['case' => 'phpmailer-plus-sender', 'raw' => base64_encode($expectedMime), 'sender' => null, 'recipients' => [], 'readHeaders' => true];

// Host acceptance may be asynchronous. Every non-true result must fail in both
// callers, with subsequent successful messages still possible in this request.
foreach (['async-accept', 'reject', 'throw', 'async-reject', 'async-throw', 'undefined', 'truthy-object'] as $outcome) {
    $success = $outcome === 'async-accept';
    $case = 'php-mail-' . $outcome;
    $headers = "From: author@example.invalid\r\nX-Capture-Case: $case\r\nX-Capture-Result: $outcome";
    $assertMail(@mail('recipient@example.invalid', $case, 'outcome-body', $headers) === $success, 'mail() returned an incorrect result for ' . $outcome);
    $expected[] = ['case' => $case, 'body' => 'outcome-body', 'sender' => null, 'recipients' => [], 'readHeaders' => true];
    $case = 'direct-' . $outcome;
    $message = "X-Capture-Case: $case\r\nX-Capture-Result: $outcome\r\n\r\ndirect outcome";
    $pipe = popen('/usr/sbin/sendmail -t -i', 'w');
    $assertMail(is_resource($pipe) && fwrite($pipe, $message) === strlen($message), 'Direct outcome write failed');
    $assertMail(pclose($pipe) === ($success ? 0 : 1), 'pclose() returned an incorrect decoded status for ' . $outcome);
    $expected[] = ['case' => $case, 'raw' => base64_encode($message), 'sender' => null, 'recipients' => [], 'readHeaders' => true];
    $case = 'phpmailer-' . $outcome;
    $mailer = $makeMailer($case, $outcome);
    $assertMail($mailer->preSend(), 'PHPMailer preparation failed for ' . $outcome);
    $expectedMime = $mailer->getSentMIMEMessage();
    $assertMail($mailer->postSend() === $success, 'PHPMailer returned an incorrect result for ' . $outcome);
    if (!$success) {
        $assertMail($mailer->ErrorInfo !== '', 'PHPMailer omitted the failure diagnostic for ' . $outcome);
    }
    $expected[] = ['case' => $case, 'raw' => base64_encode($expectedMime), 'sender' => 'bounce-tag@example.invalid', 'recipients' => [], 'readHeaders' => true];
}

foreach ([
    '/bin/sh -c true', '/usr/sbin/sendmail-other -t', '/usr/sbin/sendmail -X /tmp/mail-log',
    '/usr/sbin/sendmail -t; touch /tmp/mail-command-injection',
    '/usr/sbin/sendmail -t | cat', '/usr/sbin/sendmail -t && true',
    '/usr/sbin/sendmail -f$(touch /tmp/mail-command-injection) -t',
    '/usr/sbin/sendmail -f`touch /tmp/mail-command-injection` -t',
    "/usr/sbin/sendmail -t\ntouch /tmp/mail-command-injection",
    '/usr/sbin/sendmail -f', "/usr/sbin/sendmail -f'unterminated",
] as $command) {
    $assertMail(@popen($command, 'w') === false, 'Unsupported command was accepted: ' . $command);
}
$assertMail(@popen('/usr/sbin/sendmail -t', 'r') === false, 'A read-mode Sendmail pipe was accepted');
$assertMail(!file_exists('/tmp/mail-command-injection'), 'Command syntax was executed');

for ($index = 0; $index < 16; ++$index) {
    $case = 'repeat-' . $index;
    $message = "X-Capture-Case: $case\r\n\r\nrepeat-$index";
    $pipe = popen('/usr/sbin/sendmail -t -i', 'w');
    $assertMail(is_resource($pipe) && fwrite($pipe, $message) === strlen($message), 'Repeated pipe write failed');
    $assertMail(pclose($pipe) === 0, 'Repeated pipe close failed');
    $expected[] = ['case' => $case, 'raw' => base64_encode($message), 'sender' => null, 'recipients' => [], 'readHeaders' => true];
}

echo json_encode(['passed' => true, 'captures' => $expected], JSON_THROW_ON_ERROR) . "\n";
