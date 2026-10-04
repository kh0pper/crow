/** Spec §4.4: comments inside the .docx (ONLYOFFICE's comment pane), never Nextcloud's sidebar comments. */
import { z } from "zod";
import { fileRef, refOf, writeOpts } from "./common.js";
import { defineTools } from "./define.js";
import { loadDocx, docxWrite } from "./docs.js";
import { listComments, addComment, replyComment, resolveComment, applyCommentEdit } from "../ooxml/docx-comments.js";

const commentId = z.string().regex(/^\d{1,9}$/).describe("Comment id from ws_docs_list_comments");

export const commentDefs = [
  { name: "ws_docs_list_comments", description: "ALL comments in a .docx (never truncated): id, author, date, content, quoted_text (the highlighted text), resolved, replies. Resolved threads only with include_resolved.",
    schema: { ...fileRef, include_resolved: z.boolean().optional().default(false) },
    run: async (a, c) => { const { entry, d } = await loadDocx(c.getConfig(), refOf(a)); return { path: entry.path, file_id: entry.fileId, comments: listComments(d, a.include_resolved) }; } },
  { name: "ws_docs_add_comment", description: "Add a comment by 'Crow bot' anchored to the first occurrence of quoted_text (a real highlight; it cannot cross a tab or line break), or to the first body paragraph without it.",
    schema: { ...fileRef, content: z.string().min(1).max(10000), quoted_text: z.string().min(1).max(2000).optional(), ...writeOpts },
    run: (a, c) => docxWrite(c, a, (d) => ({ changed: 1, summary: "add comment", data: addComment(d, a.content, a.quoted_text) })) },
  { name: "ws_docs_reply_comment", description: "Reply to a comment thread (comment_id = the thread's first comment).",
    schema: { ...fileRef, comment_id: commentId, content: z.string().min(1).max(10000), ...writeOpts },
    run: (a, c) => docxWrite(c, a, (d) => ({ changed: 1, summary: "reply to comment", data: replyComment(d, a.comment_id, a.content) })) },
  { name: "ws_docs_resolve_comment", description: "Mark a comment thread resolved.",
    schema: { ...fileRef, comment_id: commentId, ...writeOpts },
    run: (a, c) => docxWrite(c, a, (d) => { const r = resolveComment(d, a.comment_id); return { changed: r.already_resolved ? 0 : 1, summary: "resolve comment", data: r }; }) },
  { name: "ws_docs_apply_comment_edit", description: "Replace ONLY the comment's highlighted text with replace_text, reply with summary, and resolve — one version. Already resolved → error already_resolved. A paragraph holding links, fields, images or tracked changes is refused (not_plain_text). If the highlight is missing, empty, spans paragraphs or crosses a tab/line break, it replies explaining why and leaves the thread UNRESOLVED (applied:false, reason).",
    schema: { ...fileRef, comment_id: commentId, replace_text: z.string().max(20000), summary: z.string().min(1).max(2000), ...writeOpts },
    run: (a, c) => docxWrite(c, a, (d) => { const r = applyCommentEdit(d, a.comment_id, a.replace_text, a.summary); return { changed: 1, summary: r.applied ? "apply comment edit" : "reply to comment", data: r }; }) },
];
export const registerDocComments = (server, ctx) => defineTools(server, ctx, commentDefs);
