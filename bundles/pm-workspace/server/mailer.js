/**
 * PM Workspace — SMTP mailer for the daily digest.
 *
 * Transport from SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS. The From
 * address is SMTP_USER; recipient is DIGEST_TO.
 */

import nodemailer from "nodemailer";

export function smtpConfigured(config) {
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS && config.DIGEST_TO);
}

export function createTransport(config) {
  const port = Number(config.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
}

/**
 * Send an email. Throws on failure.
 * @param {{subject:string, html:string, text?:string}} msg
 * @param {object} config loadConfig() result
 */
export async function send({ subject, html, text }, config) {
  if (!smtpConfigured(config)) {
    throw new Error("SMTP not configured (need SMTP_HOST, SMTP_USER, SMTP_PASS, DIGEST_TO)");
  }
  const transport = createTransport(config);
  const info = await transport.sendMail({
    from: config.SMTP_USER,
    to: config.DIGEST_TO,
    subject,
    html,
    text: text || undefined,
  });
  return { messageId: info.messageId, accepted: info.accepted };
}
