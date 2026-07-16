"""
Email notification service.

Sends daily digests and urgent notifications via SMTP.
Supports both Gmail and local SMTP servers.

Includes guardrails: preview before send, validation, rate limiting,
threading safety checks, and send logging.
"""

import email as email_lib
import imaplib
import json
import logging
import os
import re
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.header import decode_header
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


# Placeholder patterns that indicate unfinished content
_PLACEHOLDER_PATTERNS = [
    re.compile(r"\[INSERT[^\]]*\]", re.IGNORECASE),
    re.compile(r"\[TODO\]", re.IGNORECASE),
    re.compile(r"\[NAME\]", re.IGNORECASE),
    re.compile(r"\[DATE\]", re.IGNORECASE),
    re.compile(r"\[YOUR NAME\]", re.IGNORECASE),
    re.compile(r"<PLACEHOLDER>", re.IGNORECASE),
    re.compile(r"\{RECIPIENT_NAME\}", re.IGNORECASE),
    re.compile(r"\{\{[^}]+\}\}"),
    re.compile(r"\bXXX\b"),
    re.compile(r"\bTBD\b"),
    re.compile(r"\bFIXME\b"),
]


class EmailValidationError(Exception):
    """Raised when email content fails validation checks."""

    def __init__(self, errors: list[dict]):
        self.errors = errors
        messages = "; ".join(e["message"] for e in errors)
        super().__init__(f"Email validation failed: {messages}")


class EmailRateLimitError(Exception):
    """Raised when email send rate limit is exceeded."""

    pass


class EmailService:
    """
    Sends email notifications for Capstone Companion.

    Supports:
    - Daily digest emails (HTML + plain text)
    - Urgent notifications (due date changes)
    - MFA required alerts
    - Preview before send (validation + IMAP match preview)
    - Send logging to database
    - Rate limiting (10 emails per 5 minutes)
    """

    def __init__(
        self,
        smtp_host: str,
        smtp_port: int,
        username: str,
        password: str,
        from_addr: str,
        to_addr: str,
        use_tls: bool = True,
    ):
        """
        Initialize email service.

        Args:
            smtp_host: SMTP server hostname
            smtp_port: SMTP server port
            username: SMTP username
            password: SMTP password (app password for Gmail)
            from_addr: Sender email address
            to_addr: Recipient email address
            use_tls: Whether to use TLS
        """
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
        self.username = username
        self.password = password
        self.from_addr = from_addr
        self.to_addr = to_addr
        self.use_tls = use_tls

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def _validate_email(
        self,
        subject: str,
        body_text: str,
        to_addr: str,
        cc: Optional[list[str]] = None,
        bcc: Optional[list[str]] = None,
    ) -> dict:
        """
        Validate email content before sending.

        Returns:
            {"errors": [...], "warnings": [...]}
            Each entry is {"field": str, "message": str, "severity": "error"|"warning"}
        """
        errors: list[dict] = []
        warnings: list[dict] = []

        # Hard errors: empty subject/body
        if not subject or not subject.strip():
            errors.append({
                "field": "subject",
                "message": "Subject is empty",
                "severity": "error",
            })
        if not body_text or not body_text.strip():
            errors.append({
                "field": "body_text",
                "message": "Body is empty",
                "severity": "error",
            })

        # Hard errors: malformed email addresses
        all_addrs = [(to_addr, "to_addr")]
        for addr in (cc or []):
            if addr:
                all_addrs.append((addr, "cc"))
        for addr in (bcc or []):
            if addr:
                all_addrs.append((addr, "bcc"))

        for addr, field_name in all_addrs:
            if addr and not self._is_valid_email(addr):
                errors.append({
                    "field": field_name,
                    "message": f"Malformed email address: {addr}",
                    "severity": "error",
                })

        # Hard errors: placeholder text
        if body_text:
            placeholders = self._detect_placeholders(body_text)
            if placeholders:
                errors.append({
                    "field": "body_text",
                    "message": f"Placeholder text detected: {', '.join(placeholders)}",
                    "severity": "error",
                })
        if subject:
            placeholders = self._detect_placeholders(subject)
            if placeholders:
                errors.append({
                    "field": "subject",
                    "message": f"Placeholder text detected: {', '.join(placeholders)}",
                    "severity": "error",
                })

        # Warnings: self-send
        if (
            to_addr
            and to_addr.strip().lower() == self.from_addr.strip().lower()
            and not cc
            and not bcc
        ):
            warnings.append({
                "field": "to_addr",
                "message": "Sending to yourself with no CC/BCC",
                "severity": "warning",
            })

        # Warnings: suspiciously short body
        if body_text and 0 < len(body_text.strip()) < 20:
            warnings.append({
                "field": "body_text",
                "message": f"Suspiciously short body ({len(body_text.strip())} chars)",
                "severity": "warning",
            })

        # Warnings: hard-wrapped lines (mid-sentence line breaks)
        if body_text and body_text.strip():
            lines = body_text.strip().split('\n')
            hard_wrapped = 0
            for line in lines:
                stripped = line.rstrip()
                # Skip empty lines (paragraph breaks), short lines (signatures, list items),
                # and lines ending with punctuation (intentional breaks)
                if (stripped
                        and len(stripped) > 20
                        and not stripped.endswith(('.', ':', '?', '!', ','))
                        and not stripped.lstrip().startswith(
                            ('- ', '* ', '1', '2', '3', '4', '5', '6', '7', '8', '9'))):
                    hard_wrapped += 1
            if hard_wrapped >= 3:
                warnings.append({
                    "field": "body",
                    "message": (
                        f"Body may contain hard-wrapped lines ({hard_wrapped} lines end "
                        f"without punctuation). This causes jagged line breaks in email "
                        f"clients. Each paragraph should be one continuous line."
                    ),
                    "severity": "warning",
                })

        return {"errors": errors, "warnings": warnings}

    @staticmethod
    def _is_valid_email(addr: str) -> bool:
        """Basic email format validation. Handles both bare and 'Name <email>' formats."""
        if not addr:
            return False
        addr = addr.strip()
        # Handle "Display Name <email>" format
        if "<" in addr and addr.endswith(">"):
            addr = addr[addr.rindex("<") + 1 : -1].strip()
        if " " in addr or "\t" in addr or "\n" in addr:
            return False
        if "@" not in addr:
            return False
        local, _, domain = addr.rpartition("@")
        if not local or not domain or "." not in domain:
            return False
        return True

    @staticmethod
    def _detect_placeholders(text: str) -> list[str]:
        """Find placeholder patterns in text. Returns list of matched strings."""
        found = []
        for pattern in _PLACEHOLDER_PATTERNS:
            match = pattern.search(text)
            if match:
                found.append(match.group())
        return found

    # ------------------------------------------------------------------
    # Rate limiting
    # ------------------------------------------------------------------

    def _check_rate_limit(self) -> None:
        """Rate limiting disabled in capstone-tracker (no EmailLog table)."""
        return

    # ------------------------------------------------------------------
    # Send logging
    # ------------------------------------------------------------------

    def _log_send(
        self,
        to_addr: str,
        cc: Optional[list[str]],
        bcc: Optional[list[str]],
        subject: str,
        body_text: str,
        body_html: Optional[str],
        attachments: Optional[list],
        in_reply_to: Optional[str],
        references: Optional[str],
        caller: Optional[str],
        success: bool,
        error_message: Optional[str],
    ) -> None:
        """Send-logging disabled in capstone-tracker (no EmailLog table).

        Failures are still surfaced via logger; the bundle does not persist
        a history. Phase 4a.5 may add an audit log in capstone.db if needed.
        """
        if not success:
            logger.warning(
                "Email send failed to=%s subject=%r caller=%s err=%s",
                to_addr, subject, caller, error_message,
            )

    # ------------------------------------------------------------------
    # Core send
    # ------------------------------------------------------------------

    def send_email(
        self,
        subject: str,
        body_text: str,
        body_html: Optional[str] = None,
        attachments: Optional[list[tuple[str, bytes, str]]] = None,
        to_addr: Optional[str] = None,
        cc: Optional[list[str]] = None,
        bcc: Optional[list[str]] = None,
        in_reply_to: Optional[str] = None,
        references: Optional[str] = None,
        caller: Optional[str] = None,
        skip_rate_limit: bool = False,
    ) -> bool:
        """
        Send an email.

        Args:
            subject: Email subject
            body_text: Plain text body
            body_html: Optional HTML body
            attachments: Optional list of (filename, content_bytes, content_type) tuples
            to_addr: Optional override recipient (uses self.to_addr if not provided)
            cc: Optional list of CC recipients
            bcc: Optional list of BCC recipients (envelope only, NOT in headers)
            in_reply_to: Message-ID of the email being replied to (for threading)
            references: References header chain (for threading)
            caller: Who initiated the send ("claude", "celery_digest", etc.)
            skip_rate_limit: Bypass rate limit check (for Celery tasks)

        Returns:
            True if sent successfully

        Raises:
            EmailValidationError: If subject/body is empty, address is malformed,
                or placeholder text is detected
            EmailRateLimitError: If >10 emails sent in last 5 minutes
        """
        recipient = to_addr or self.to_addr

        # Validate (raises EmailValidationError on hard errors)
        validation = self._validate_email(subject, body_text, recipient, cc, bcc)
        if validation["errors"]:
            raise EmailValidationError(validation["errors"])

        # Rate limit
        if not skip_rate_limit:
            self._check_rate_limit()

        try:
            # Build message
            msg = MIMEMultipart("mixed" if attachments else "alternative")
            msg["Subject"] = subject
            msg["From"] = self.from_addr
            msg["To"] = recipient

            # CC header (BCC intentionally NOT added as header -- only in SMTP envelope)
            if cc:
                cc = [addr for addr in cc if addr]
                if cc:
                    msg["Cc"] = ", ".join(cc)

            # Threading headers (RFC 2822)
            if in_reply_to:
                msg["In-Reply-To"] = in_reply_to
                msg["References"] = references or in_reply_to

            if attachments:
                # Nested alternative part for text/html body
                body_part = MIMEMultipart("alternative")
                body_part.attach(MIMEText(body_text, "plain"))
                if body_html:
                    body_part.attach(MIMEText(body_html, "html"))
                msg.attach(body_part)

                # Attach files
                for filename, content_bytes, content_type in attachments:
                    _, subtype = content_type.split("/", 1)
                    attachment = MIMEApplication(content_bytes, _subtype=subtype)
                    attachment.add_header(
                        "Content-Disposition", "attachment", filename=filename
                    )
                    msg.attach(attachment)
            else:
                msg.attach(MIMEText(body_text, "plain"))
                if body_html:
                    msg.attach(MIMEText(body_html, "html"))

            # Build recipient list for SMTP envelope
            all_recipients = [recipient]
            if cc:
                all_recipients.extend(cc)
            if bcc:
                bcc = [addr for addr in bcc if addr]
                all_recipients.extend(bcc)

            # Connect and send
            context = ssl.create_default_context()

            if self.use_tls:
                server = smtplib.SMTP(self.smtp_host, self.smtp_port)
                server.starttls(context=context)
            else:
                server = smtplib.SMTP_SSL(self.smtp_host, self.smtp_port, context=context)

            with server:
                server.login(self.username, self.password)
                server.sendmail(self.from_addr, all_recipients, msg.as_string())

            self._log_send(
                recipient, cc, bcc, subject, body_text, body_html,
                attachments, in_reply_to, references, caller, True, None,
            )
            logger.info(f"Email sent to {all_recipients}: {subject}")
            return True

        except Exception as e:
            self._log_send(
                recipient, cc, bcc, subject, body_text, body_html,
                attachments, in_reply_to, references, caller, False, str(e),
            )
            logger.error(f"Failed to send email to {recipient}: {e}")
            return False

    # ------------------------------------------------------------------
    # Reply with threading
    # ------------------------------------------------------------------

    def reply_to_message(
        self,
        body_text: str,
        body_html: Optional[str] = None,
        from_addr: Optional[str] = None,
        sent_to: Optional[str] = None,
        subject: Optional[str] = None,
        message_id: Optional[str] = None,
        reply_all: bool = False,
        cc: Optional[list[str]] = None,
        bcc: Optional[list[str]] = None,
        caller: Optional[str] = None,
    ) -> bool:
        """
        Reply to an existing email with proper threading.

        Looks up the original message via IMAP, extracts threading headers,
        and sends a properly threaded reply.

        Args:
            body_text: Reply body (plain text)
            body_html: Optional HTML body
            from_addr: Search for original message from this sender (received emails)
            sent_to: Search for original message sent TO this address (one-way threads)
            subject: Search for original message with this subject
            message_id: Directly specify the Message-ID to reply to
            reply_all: Include original To/Cc recipients in outgoing Cc
            cc: Additional Cc recipients (merged with reply-all recipients)
            bcc: BCC recipients
            caller: Who initiated the send ("claude", "celery_digest", etc.)

        Returns:
            True if reply sent successfully
        """
        if not message_id and not from_addr and not sent_to and not subject:
            raise ValueError(
                "Must provide message_id, from_addr, sent_to, or subject to find original"
            )

        try:
            if message_id:
                orig_headers = self._imap_search(message_id=message_id)
                if not orig_headers:
                    logger.warning(
                        f"Could not fetch headers for Message-ID {message_id}, "
                        "using bare ID"
                    )
                    orig_headers = {"Message-ID": message_id}
            else:
                orig_headers = self._imap_search(
                    from_addr=from_addr, sent_to=sent_to, subject=subject
                )
                if not orig_headers:
                    logger.warning("No matching message found for reply")
                    return False

            orig_message_id = orig_headers.get("Message-ID", "")
            orig_references = orig_headers.get("References", "")
            orig_subject = orig_headers.get("Subject", subject or "")
            orig_from = orig_headers.get("From", from_addr or "")
            orig_to = orig_headers.get("To", "")
            orig_cc = orig_headers.get("Cc", "")

            # Build References chain
            references = f"{orig_references} {orig_message_id}".strip()

            # Always prefer the IMAP-fetched subject to preserve exact encoding.
            # The `subject` param is for IMAP search only — never use it as the
            # reply subject when IMAP returned an original.
            reply_subject = orig_subject or subject or ""
            if reply_subject and not reply_subject.lower().startswith("re:"):
                reply_subject = f"Re: {reply_subject}"

            # Determine recipient: if WE sent the original, reply to the original
            # recipient (orig_to). If someone else sent it, reply to them (orig_from).
            orig_from_clean = orig_from.strip().lower()
            self_addr_clean = self.from_addr.strip().lower()
            if orig_from_clean == self_addr_clean:
                reply_recipient = orig_to
            else:
                reply_recipient = orig_from

            # Build Cc list for reply-all
            merged_cc = list(cc or [])
            if reply_all:
                # Add original To and Cc recipients, minus ourselves
                for addr_str in [orig_to, orig_cc]:
                    if addr_str:
                        for addr in addr_str.split(","):
                            addr = addr.strip()
                            if addr and addr.lower() != self.from_addr.lower():
                                merged_cc.append(addr)

                # Deduplicate (case-insensitive)
                seen = set()
                deduped = []
                for addr in merged_cc:
                    lower = addr.lower()
                    if lower not in seen and lower != self.from_addr.lower():
                        seen.add(lower)
                        deduped.append(addr)
                merged_cc = deduped

            return self.send_email(
                subject=reply_subject,
                body_text=body_text,
                body_html=body_html,
                to_addr=reply_recipient,
                cc=merged_cc or None,
                bcc=bcc,
                in_reply_to=orig_message_id,
                references=references,
                caller=caller,
            )

        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to send reply: {e}")
            return False

    # ------------------------------------------------------------------
    # IMAP search
    # ------------------------------------------------------------------

    def _imap_search(
        self,
        from_addr: Optional[str] = None,
        sent_to: Optional[str] = None,
        subject: Optional[str] = None,
        message_id: Optional[str] = None,
    ) -> Optional[dict]:
        """
        Search IMAP for the most recent matching message and return its headers.

        Delegates to _imap_search_with_meta() and discards the metadata.
        """
        headers, _ = self._imap_search_with_meta(
            from_addr=from_addr, sent_to=sent_to,
            subject=subject, message_id=message_id,
        )
        return headers

    def _imap_search_with_meta(
        self,
        from_addr: Optional[str] = None,
        sent_to: Optional[str] = None,
        subject: Optional[str] = None,
        message_id: Optional[str] = None,
        before_date: Optional[str] = None,
    ) -> tuple[Optional[dict], dict]:
        """
        Search IMAP for the most recent matching message.

        Like _imap_search() but also returns search metadata.

        Args:
            before_date: Optional IMAP date string (e.g. "01-Apr-2026") to
                exclude emails sent on or after this date. Use this when
                threading replies to avoid matching emails sent in the
                current session.

        Returns:
            (headers_dict_or_None, {"match_count": int, "mailbox": str, "search_criteria": str})
        """
        mail = None
        meta: dict = {"match_count": 0, "mailbox": "", "search_criteria": ""}
        try:
            mail = imaplib.IMAP4_SSL(
                os.environ.get("IMAP_HOST", "imap.gmail.com"),
                int(os.environ.get("IMAP_PORT", "993")),
            )
            mail.login(self.username, self.password)

            # Build IMAP search criteria
            criteria = []
            if from_addr:
                criteria.append(f'FROM "{from_addr}"')
            if sent_to:
                criteria.append(f'TO "{sent_to}"')
                # Also filter by our own From to ensure we only match emails
                # WE sent (not emails addressed to us)
                if not from_addr:
                    criteria.append(f'FROM "{self.from_addr}"')
            if subject:
                criteria.append(f'SUBJECT "{subject}"')
            if message_id:
                criteria.append(f'HEADER Message-ID "{message_id}"')
            if before_date:
                criteria.append(f'BEFORE "{before_date}"')
            search_str = " ".join(criteria) if criteria else "ALL"
            meta["search_criteria"] = search_str

            # Determine mailbox search order based on search type
            if message_id:
                # Message-IDs are globally unique — go straight to All Mail
                mailboxes = ['"[Gmail]/All Mail"']
            elif sent_to and not from_addr:
                # Looking for emails we sent — check Sent Mail first
                mailboxes = ['"[Gmail]/Sent Mail"', '"[Gmail]/All Mail"']
            else:
                # Default: INBOX first, then All Mail
                mailboxes = ["INBOX", '"[Gmail]/All Mail"']

            status = None
            messages = None
            for mailbox in mailboxes:
                mail.select(mailbox, readonly=True)
                status, messages = mail.search("UTF-8", search_str.encode("utf-8"))
                if status == "OK" and messages[0]:
                    meta["mailbox"] = mailbox.strip('"')
                    break

            if status != "OK" or not messages[0]:
                return None, meta

            # Get the most recent match (last in list)
            msg_ids = messages[0].split()
            meta["match_count"] = len(msg_ids)
            latest_id = msg_ids[-1]

            status, data = mail.fetch(latest_id, "(BODY[HEADER])")
            if status != "OK":
                return None, meta

            msg = email_lib.message_from_bytes(data[0][1])

            headers = {
                "Message-ID": msg.get("Message-ID", ""),
                "References": msg.get("References", ""),
                "From": self._decode_header_value(msg.get("From", "")),
                "To": self._decode_header_value(msg.get("To", "")),
                "Cc": self._decode_header_value(msg.get("Cc", "")),
                "Subject": self._decode_header_value(msg.get("Subject", "")),
            }
            return headers, meta

        except Exception as e:
            logger.error(f"IMAP search failed: {e}")
            return None, meta
        finally:
            if mail:
                try:
                    mail.logout()
                except Exception:
                    pass

    @staticmethod
    def _decode_header_value(raw: str) -> str:
        """Decode RFC 2047 encoded header values."""
        if not raw:
            return ""
        parts = decode_header(raw)
        decoded = []
        for content, charset in parts:
            if isinstance(content, bytes):
                decoded.append(content.decode(charset or "utf-8", errors="replace"))
            else:
                decoded.append(content)
        return " ".join(decoded)

    # ------------------------------------------------------------------
    # Threading safety checks
    # ------------------------------------------------------------------

    @staticmethod
    def _verify_imap_match(
        headers: Optional[dict],
        meta: dict,
        subject_search: Optional[str] = None,
    ) -> list[str]:
        """
        Check IMAP match for suspicious patterns.

        Returns list of warning strings (empty if match looks normal).
        """
        warnings = []
        if not headers:
            return warnings

        matched_subject = headers.get("Subject", "")
        matched_from = headers.get("From", "")

        # Automated email patterns
        auto_subjects = ["job alert", "invitation to apply", "newsletter"]
        auto_froms = ["noreply@", "@glassdoor.com", "@linkedin.com", "@indeed.com"]

        if any(p in matched_subject.lower() for p in auto_subjects):
            warnings.append(
                f"Subject looks like an automated email: '{matched_subject}'"
            )
        if any(p in matched_from.lower() for p in auto_froms):
            warnings.append(
                f"From address looks automated: '{matched_from}'"
            )

        # Multiple matches
        match_count = meta.get("match_count", 0)
        if match_count >= 5:
            warnings.append(
                f"IMAP search matched {match_count} messages — criteria may be too broad"
            )

        # Subject fragment mismatch
        if subject_search and matched_subject:
            if subject_search.lower() not in matched_subject.lower():
                warnings.append(
                    f"Search subject '{subject_search}' not found in "
                    f"matched subject '{matched_subject}'"
                )

        return warnings

    # ------------------------------------------------------------------
    # Preview (dry run)
    # ------------------------------------------------------------------

    def preview_email(
        self,
        subject: str,
        body_text: str,
        to_addr: Optional[str] = None,
        cc: Optional[list[str]] = None,
        bcc: Optional[list[str]] = None,
        body_html: Optional[str] = None,
    ) -> dict:
        """
        Preview a new email without sending. Runs validation.

        Returns dict with to, subject, body_text, validation results, etc.
        """
        recipient = to_addr or self.to_addr
        validation = self._validate_email(subject, body_text, recipient, cc, bcc)

        return {
            "to": recipient,
            "cc": cc or [],
            "bcc": bcc or [],
            "subject": subject,
            "body_text": body_text,
            "body_length": len(body_text) if body_text else 0,
            "has_html": body_html is not None,
            "threading": None,
            "validation": validation,
        }

    def preview_reply(
        self,
        body_text: str,
        body_html: Optional[str] = None,
        from_addr: Optional[str] = None,
        sent_to: Optional[str] = None,
        subject: Optional[str] = None,
        message_id: Optional[str] = None,
        reply_all: bool = False,
        cc: Optional[list[str]] = None,
        bcc: Optional[list[str]] = None,
    ) -> dict:
        """
        Preview a reply without sending. Does IMAP lookup and returns
        match details, threading info, validation, and pre-built send_args.

        After user confirms, call:
            send_email(**preview["send_args"], body_text=..., caller="claude")
        """
        if not message_id and not from_addr and not sent_to and not subject:
            raise ValueError(
                "Must provide message_id, from_addr, sent_to, or subject "
                "to find original"
            )

        # IMAP lookup with metadata
        # Exclude today's emails to avoid matching same-session sends
        # when threading replies. This prevents picking up a broken
        # unthreaded email we just sent instead of the original.
        today_imap = datetime.now().strftime("%d-%b-%Y")

        if message_id:
            orig_headers, meta = self._imap_search_with_meta(message_id=message_id)
            if not orig_headers:
                orig_headers = {"Message-ID": message_id}
        else:
            orig_headers, meta = self._imap_search_with_meta(
                from_addr=from_addr, sent_to=sent_to, subject=subject,
                before_date=today_imap,
            )
            if not orig_headers:
                return {
                    "error": "No matching message found",
                    "imap_match": None,
                    "validation": {
                        "errors": [{
                            "field": "imap",
                            "message": "No matching message found",
                            "severity": "error",
                        }],
                        "warnings": [],
                    },
                }

        # Threading safety checks
        imap_warnings = self._verify_imap_match(
            orig_headers, meta, subject_search=subject,
        )

        # Build reply details (same logic as reply_to_message)
        orig_message_id = orig_headers.get("Message-ID", "")
        orig_references = orig_headers.get("References", "")
        orig_subject = orig_headers.get("Subject", subject or "")
        orig_from = orig_headers.get("From", from_addr or "")
        orig_to = orig_headers.get("To", "")
        orig_cc = orig_headers.get("Cc", "")

        references = f"{orig_references} {orig_message_id}".strip()

        reply_subject = orig_subject or subject or ""
        if reply_subject and not reply_subject.lower().startswith("re:"):
            reply_subject = f"Re: {reply_subject}"

        # Determine recipient
        orig_from_clean = orig_from.strip().lower()
        self_addr_clean = self.from_addr.strip().lower()
        if orig_from_clean == self_addr_clean:
            reply_recipient = orig_to
        else:
            reply_recipient = orig_from

        # Build Cc list
        merged_cc = list(cc or [])
        if reply_all:
            for addr_str in [orig_to, orig_cc]:
                if addr_str:
                    for addr in addr_str.split(","):
                        addr = addr.strip()
                        if addr and addr.lower() != self.from_addr.lower():
                            merged_cc.append(addr)
            seen = set()
            deduped = []
            for addr in merged_cc:
                lower = addr.lower()
                if lower not in seen and lower != self.from_addr.lower():
                    seen.add(lower)
                    deduped.append(addr)
            merged_cc = deduped

        # Validate
        validation = self._validate_email(
            reply_subject, body_text, reply_recipient, merged_cc or None, bcc,
        )
        # Add IMAP warnings
        for w in imap_warnings:
            validation["warnings"].append({
                "field": "imap",
                "message": w,
                "severity": "warning",
            })

        # Build send_args (threading + recipient only; CC/BCC passed separately)
        send_args = {
            "subject": reply_subject,
            "to_addr": reply_recipient,
            "in_reply_to": orig_message_id,
            "references": references,
        }

        return {
            "to": reply_recipient,
            "cc": merged_cc or [],
            "bcc": bcc or [],
            "subject": reply_subject,
            "body_text": body_text,
            "body_length": len(body_text) if body_text else 0,
            "has_html": body_html is not None,
            "threading": {
                "in_reply_to": orig_message_id,
                "references": references,
            },
            "imap_match": {
                "matched_subject": orig_headers.get("Subject", ""),
                "matched_from": orig_headers.get("From", ""),
                "matched_to": orig_headers.get("To", ""),
                "matched_message_id": orig_message_id,
                "match_count": meta.get("match_count", 0),
                "search_mailbox": meta.get("mailbox", ""),
                "warnings": imap_warnings,
            },
            "validation": validation,
            "send_args": send_args,
        }

    # ------------------------------------------------------------------
    # Convenience senders (Celery tasks)
    # ------------------------------------------------------------------

    def send_daily_digest(self, digest: dict) -> bool:
        """
        Send daily digest email.

        Args:
            digest: Digest dict from DigestGenerator

        Returns:
            True if sent successfully
        """
        subject = f"\U0001f4da Canvas Digest - {datetime.now(timezone.utc).strftime('%B %d, %Y')}"

        return self.send_email(
            subject=subject,
            body_text=digest.get("email_content", "No content available."),
            body_html=digest.get("html_content"),
            caller="celery_digest",
            skip_rate_limit=True,
        )

    def send_urgent_notification(
        self,
        change_type: str,
        item_type: str,
        item_name: str,
        course_id: str,
        old_value: Optional[str] = None,
        new_value: Optional[str] = None,
        change_ids: Optional[list[int]] = None,
    ) -> bool:
        """
        Send urgent notification for critical changes.

        Args:
            change_type: Type of change (due_date_changed, new_assignment)
            item_type: Type of item (assignment, announcement)
            item_name: Name of the item
            course_id: Course identifier
            old_value: Previous value (for changes)
            new_value: New value (for changes)
            change_ids: Database IDs of changes to mark as notified

        Returns:
            True if sent successfully
        """
        # Build subject based on change type
        if change_type == "due_date_changed":
            subject = f"\u26a0\ufe0f DUE DATE CHANGED: {item_name}"
        elif change_type == "new_assignment":
            subject = f"\U0001f4dd NEW ASSIGNMENT: {item_name}"
        else:
            subject = f"\U0001f514 Canvas Update: {item_name}"

        # Build body
        body_lines = [
            f"URGENT CANVAS NOTIFICATION",
            "=" * 40,
            "",
            f"Course: {course_id}",
            f"Item: {item_name} ({item_type})",
            f"Change: {change_type.replace('_', ' ').title()}",
            "",
        ]

        if old_value and new_value:
            body_lines.extend([
                "Details:",
                f"  Previous: {old_value}",
                f"  Current:  {new_value}",
                "",
            ])

        body_lines.extend([
            "=" * 40,
            "View details: http://grackle:8080",
            "",
            f"Detected at: {datetime.now(timezone.utc).isoformat()}",
        ])

        body_text = "\n".join(body_lines)

        # HTML version
        body_html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body {{ font-family: -apple-system, sans-serif; padding: 20px; }}
                .alert {{ background: #fee; border: 2px solid #e74c3c; padding: 20px; border-radius: 8px; }}
                .details {{ background: #f8f9fa; padding: 15px; margin: 15px 0; border-radius: 4px; }}
                h1 {{ color: #c0392b; margin: 0 0 15px 0; }}
            </style>
        </head>
        <body>
            <div class="alert">
                <h1>\u26a0\ufe0f {change_type.replace('_', ' ').title()}</h1>
                <p><strong>{item_name}</strong></p>
                <p>Course: {course_id}</p>
            </div>
            {"<div class='details'><strong>Previous:</strong> " + old_value + "<br><strong>Current:</strong> " + new_value + "</div>" if old_value and new_value else ""}
            <p><a href="http://grackle:8080">View on Dashboard</a></p>
        </body>
        </html>
        """

        success = self.send_email(
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            caller="celery_urgent",
            skip_rate_limit=True,
        )

        # Mark changes as notified if successful
        if success and change_ids:
            self._mark_notified(change_ids)

        return success

    def send_mfa_required(self) -> bool:
        """
        Send notification that MFA is required.

        Called when Duo prompt is detected during sync.
        """
        subject = "\U0001f510 Canvas Sync: MFA Required"

        body_text = """
CAPSTONE COMPANION - MFA REQUIRED
================================

The automated Canvas sync requires Duo authentication.

Please:
1. Open Canvas in your browser
2. Complete Duo authentication
3. The next sync will use the authenticated session

Dashboard: http://grackle:8080
Tailscale: http://100.121.254.89:8080

Note: Cookies are stored, so you shouldn't need to do this often.
        """

        body_html = """
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: -apple-system, sans-serif; padding: 20px; }
                .alert { background: #fff3cd; border: 2px solid #ffc107; padding: 20px; border-radius: 8px; }
                h1 { color: #856404; }
                .steps { background: #f8f9fa; padding: 15px; margin: 15px 0; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="alert">
                <h1>\U0001f510 MFA Authentication Required</h1>
                <p>Canvas sync needs Duo authentication to continue.</p>
            </div>
            <div class="steps">
                <strong>Steps:</strong>
                <ol>
                    <li>Open Canvas in your browser</li>
                    <li>Complete Duo authentication</li>
                    <li>The next sync will use your session</li>
                </ol>
            </div>
            <p><a href="https://unt.instructure.com">Open Canvas</a></p>
        </body>
        </html>
        """

        return self.send_email(
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            caller="celery_mfa",
            skip_rate_limit=True,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _mark_notified(self, change_ids: list[int]):
        """No-op in capstone-tracker (ChangeLog is LMS-specific, not carried)."""
        return

    def process_urgent_notifications(self) -> int:
        """No-op in capstone-tracker (ChangeLog is LMS-specific, not carried).

        Phase 4a v1 only uses send_email() and send_digest()-style methods
        driven by the PIR audit task. Canvas-sync urgent notifications are
        not in scope.
        """
        return 0


def get_email_service() -> EmailService:
    """
    Get configured email service from settings.

    Returns:
        Configured EmailService instance
    """
    return EmailService(
        smtp_host=os.environ.get("SMTP_HOST", "smtp.gmail.com"),
        smtp_port=int(os.environ.get("SMTP_PORT", "587")),
        username=os.environ["SMTP_USERNAME"],
        password=os.environ["SMTP_PASSWORD"],
        from_addr=os.environ.get("EMAIL_FROM", os.environ["SMTP_USERNAME"]),
        to_addr=os.environ.get("EMAIL_TO", os.environ["SMTP_USERNAME"]),
    )


def test_email():
    """
    Send a test email.

    Run with: python -m src.ai.email_service --test-email
    """
    print("Testing email service...")
    print("=" * 40)

    try:
        service = get_email_service()

        success = service.send_email(
            subject="\U0001f9ea Capstone Companion - Test Email",
            body_text="This is a test email from Capstone Companion.\n\nIf you receive this, email is configured correctly!",
            body_html="""
            <html>
            <body>
                <h1>\U0001f9ea Test Email</h1>
                <p>This is a test email from <strong>Capstone Companion</strong>.</p>
                <p>If you receive this, email is configured correctly!</p>
            </body>
            </html>
            """,
            caller="manual",
        )

        if success:
            print("Test email sent successfully!")
        else:
            print("Failed to send test email.")

    except Exception as e:
        print(f"Error: {e}")
        print("\nMake sure email settings are configured in .env:")
        print("  SMTP_USERNAME=your-email@gmail.com")
        print("  SMTP_PASSWORD=your-app-password")
        print("  EMAIL_TO=recipient@example.com")
        print("  EMAIL_FROM=your-email@gmail.com")


if __name__ == "__main__":
    import sys

    if "--test-email" in sys.argv:
        test_email()
    else:
        print("Usage: python -m src.ai.email_service --test-email")
