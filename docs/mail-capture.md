# Local mail capture

The runtime supports a virtual Sendmail pipe for PHP `mail()` and PHPMailer's
Sendmail transport. A host application accepts the message through an `onMail`
constructor callback. No operating-system process or external mail delivery is
involved. SMTP and HTTP email APIs do not use this hook.

Configure PHP with `sendmail_path=/usr/sbin/sendmail -t -i` and configure
PHPMailer/Joomla to use Sendmail at `/usr/sbin/sendmail`. Applications keep their
normal mail APIs. The host owns inbox storage, presentation, and transport
configuration; this runtime does not modify Joomla or store mail in its database.

## Host callback

Pass `onMail` to the runtime constructor before executing application code. The
callback receives a versioned capture record:

| Property | Meaning |
| --- | --- |
| `version` | Capture contract version, currently `1` |
| `raw` | A new `Uint8Array` containing the complete bytes written to the pipe |
| `command` | The original supported Sendmail command |
| `args` | Parsed command arguments |
| `envelopeSender` | Explicit envelope sender, or `null` when absent |
| `envelopeRecipients` | Recipients explicitly supplied as command arguments |
| `readRecipientsFromHeaders` | Whether the command requested Sendmail's `-t` behavior |

Do not decode `raw` before retaining the original bytes. MIME can contain
attachments and non-UTF-8 content. The envelope is separate from visible MIME
headers; a host must not invent missing BCC recipients.

The callback may return a Boolean or a Promise resolving to a Boolean. Only
literal `true` accepts the capture. Return it after the host has retained the
message, not merely after posting an unacknowledged notification to another
worker. A missing callback, `false`, another return value, a thrown error, or a
rejected Promise produces a failed close/delivery result. PHP `mail()` and
PHPMailer therefore observe capture failure instead of a false success.

The callback must not re-enter the same executing interpreter while its mail
operation is awaiting acceptance. It may communicate with a separate owner
through a normal asynchronous request/acknowledgment channel.

## Lifetime and compatibility

Each open mail pipe owns an independent memory buffer. Explicitly closing a pipe
finalizes it once; pipes still open at request shutdown or explicit refresh are
abandoned without capture and released by the normal stream cleanup.
There are no spool files in the application webroot or persistent filesystem.
The constructor callback survives runtime refresh independently of Vrzno's
request-scoped shared values. Separate interpreter instances have separate
callbacks and buffers.

Distribution manifests declare `capabilities.mailCapture: 1`. After awaiting
`runtime.binary`, consumers must also check `runtime.mailCaptureVersion === 1`;
this property is read from the native binary. An older
archive must not be presented as an active catcher. The capability identifies
the transport contract, not a promise that an inbox exists in every host.

The command parser accepts `/usr/sbin/sendmail`, literal quoting, `-t`, `-i`,
`-oi`, an optional `-f` sender, and explicit recipients (with optional `--`).
Only write mode is supported. It does not invoke a shell or enable unrelated process
commands, redirection, command substitution, or pipelines. Unsupported input
fails explicitly. This facility is not an outbound-network firewall.

## Validation

The runtime suites exercise both PHP `mail()` and unmodified PHPMailer Sendmail
with synthetic `.invalid` addresses. Coverage includes raw MIME bytes,
attachments, command quoting and envelope fields, synchronous and asynchronous
acceptance, missing/rejecting/throwing handlers, repeated captures and refresh,
and unsupported commands. These tests run with the compiled runtime in the
existing PHP 8.3/8.4/8.5 Node and browser matrix.

The host application must separately verify its inbox, site isolation, recovery,
HTML preview isolation, and production export behavior. A runtime capture test
does not prove those integration requirements or real external delivery.
