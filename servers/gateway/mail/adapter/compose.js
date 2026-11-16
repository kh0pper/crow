/**
 * The RFC 822 bytes of an outgoing message, built without a socket.
 *
 * Two things in Crow Mail need a message as bytes rather than as a delivery: the Sent copy that is
 * appended to the provider's own mailbox, and a draft stored in the `\Drafts` folder. Both are built
 * here, through nodemailer's `mail-composer` — the same composer its transports use, which ships
 * inside the `nodemailer` dependency rather than as one of its own — so a stored copy is the message
 * the recipient's server would have received.
 *
 * Nothing here goes on the wire, and nothing here can be talked into reading a file or fetching a URL:
 * `validateOutgoing` runs first and its output is the only thing the composer is handed, so an
 * attachment is bytes with a filename and a media type, never a `path`, a `href`, a raw source or a
 * header map. The two access flags stay closed on the composer as well, exactly as they are on the
 * SMTP transport, so a source Crow did not intend cannot be reached by a second door.
 *
 * `keepBcc` is a MimeNode property, not a composer option: the transports set it on the compiled
 * message (`mail.message.keepBcc = true`) when the copy they write is the one that should keep the
 * blind recipient — sendmail and the stream and JSON transports do. A Sent copy is that kind of copy
 * and passes `true`; a message that is going to be delivered passes `false` (the default), because a
 * Bcc header written out on the wire would publish the recipient it is hiding.
 */
import MailComposer from "nodemailer/lib/mail-composer";
import { validateOutgoing } from "./interface.js";

/** One validated address as the composer wants it: a display name when there is one, else the address. */
function composerAddress(entry) {
  return entry.name ? { name: entry.name, address: entry.address } : { address: entry.address };
}

/**
 * An attachment's bytes as the composer takes them: the string as it is, a Buffer over the same
 * memory otherwise. Nothing else of the validated attachment travels.
 */
function contentBytes(content) {
  if (typeof content === "string") return content;
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

/**
 * The message handed to the composer, built from `validateOutgoing`'s output field by field. Every key
 * below is one of those fields; there is no way for a header map, a file or URL source, an envelope or
 * a raw body to arrive from the caller.
 */
function composerMessage(outgoing) {
  const message = {
    from: composerAddress(outgoing.from),
    to: outgoing.to.map(composerAddress),
    subject: outgoing.subject,
    text: outgoing.text,
    // The two flags the SMTP transport closes, closed here as well: no file and no URL is a source.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (outgoing.cc.length) message.cc = outgoing.cc.map(composerAddress);
  if (outgoing.bcc.length) message.bcc = outgoing.bcc.map(composerAddress);
  if (outgoing.html != null) message.html = outgoing.html;
  if (outgoing.inReplyTo) message.inReplyTo = outgoing.inReplyTo;
  if (outgoing.references.length) message.references = [...outgoing.references];
  // Absent, the composer writes one of its own; present, the caller's id is the one composed.
  if (outgoing.messageId) message.messageId = outgoing.messageId;
  if (outgoing.attachments.length) {
    message.attachments = outgoing.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: contentBytes(attachment.content),
    }));
  }
  return message;
}

/**
 * One outgoing message as its RFC 822 bytes.
 *
 * `validateOutgoing` runs first and runs whole: a message with a key Crow does not send, an address
 * that is not one clean addr-spec, a message id or media type carrying a control character, or an
 * attachment naming a file or a URL is refused with `BAD_INPUT` before a composer exists.
 *
 * @param {import("./interface.js").OutgoingMessage} message
 * @param {{keepBcc?: boolean}} [options] `keepBcc: true` writes the Bcc header — for a Sent copy only
 * @returns {Promise<Buffer>} the message as bytes
 */
export async function composeRaw(message, options = {}) {
  const outgoing = validateOutgoing(message);
  const keepBcc = options != null && options.keepBcc === true;

  const compiled = new MailComposer(composerMessage(outgoing)).compile();
  // Set before the stream is created: the headers are written as the message is streamed.
  compiled.keepBcc = keepBcc;
  const chunks = [];
  for await (const chunk of compiled.createReadStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}