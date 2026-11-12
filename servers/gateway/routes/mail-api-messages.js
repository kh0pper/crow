/**
 * The mailbox routes of the private mail API — message lists, one message with its sanitised body,
 * the per-sender image allow list, search and older mail.
 *
 * Task 20 fills this file. Task 19 builds the router (`routes/mail-api.js`), its guards, its error
 * shape and the account routes, and calls this function with `ctx = {guards, openDb, credentials,
 * supervisor, adapterFactory, localInstance, sendError, sendMailError, logCode}` — the same guard
 * chain, JSON parser and error shape the account routes use, so nothing here re-implements them.
 *
 * @param {import("express").Router} router the mail API router (prefix `/dashboard/mail/api`)
 * @param {object} ctx the guards and per-request helpers, as mail-api.js builds them
 */
export function registerMessageRoutes(router, ctx) {}

export default registerMessageRoutes;