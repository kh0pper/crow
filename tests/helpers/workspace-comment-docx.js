// Builds .docx buffers with comment threads, durableIds and a people.xml, on top of rich.docx.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDocx } from "../../bundles/workspace/server/ooxml/docx-model.js";
import { addComment, replyComment, listComments, deleteComment } from "../../bundles/workspace/server/ooxml/docx-comments.js";
import { addRel, setOverride, REL } from "../../bundles/workspace/server/ooxml/opc.js";
import { NS, parseXml, kids, attr } from "../../bundles/workspace/server/ooxml/xml.js";

const FIX = join(import.meta.dirname, "..", "fixtures", "workspace");
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const W = NS.w, W14 = NS.w14, W15 = NS.w15;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * commentDocx({ threads: [{ author, date, text, quoted, durableId?, resolved?, replies?: [{author,date,text}] }],
 *               people?: { [author]: userId } }) -> Buffer
 * Real comments come from addComment/replyComment; authors and dates are then patched in comments.xml,
 * commentsIds.xml is created with the requested durableIds, and people.xml with the people map.
 */
export function commentDocx({ threads = [], people = null } = {}) {
  const d = openDocx(readFileSync(join(FIX, "rich.docx")));
  for (const c of listComments(d, true)) deleteComment(d, c.id); // start from a document with no comments
  const rows = []; // { id, author, date, durableId }
  for (const t of threads) {
    const root = addComment(d, t.text, t.quoted ?? "", { author: t.author, initials: "XX" });
    rows.push({ id: root.comment_id, author: t.author, date: t.date, durableId: t.durableId });
    for (const r of t.replies || []) {
      const rep = replyComment(d, root.comment_id, r.text, { author: r.author, initials: "XX" });
      rows.push({ id: rep.comment_id, author: r.author, date: r.date, durableId: undefined });
    }
    if (t.resolved) {
      // done="1" on the root's commentEx row, which replyComment/addComment may not have created
      const ex = d.pkg.xml("word/commentsExtended.xml");
      const pid = attr(kids(kids(d.pkg.xml("word/comments.xml").documentElement, W, "comment").find((c) => attr(c, W, "id") === root.comment_id), W, "p").at(-1), W14, "paraId");
      let e = kids(ex.documentElement, W15, "commentEx").find((x) => attr(x, W15, "paraId") === pid);
      if (!e) { e = ex.createElementNS(W15, "w15:commentEx"); e.setAttributeNS(W15, "w15:paraId", pid); ex.documentElement.appendChild(e); }
      e.setAttributeNS(W15, "w15:done", "1"); d.pkg.markDirty("word/commentsExtended.xml");
    }
  }
  const cd = d.pkg.xml("word/comments.xml");
  const cs = kids(cd.documentElement, W, "comment"); const idRows = [];
  for (const r of rows) {
    const c = cs.find((x) => attr(x, W, "id") === r.id);
    c.setAttributeNS(W, "w:author", r.author); c.setAttributeNS(W, "w:date", r.date);
    const pid = attr(kids(c, W, "p").at(-1), W14, "paraId");
    if (r.durableId) idRows.push(`<w16cid:commentId w16cid:paraId="${pid}" w16cid:durableId="${r.durableId}"/>`);
  }
  d.pkg.markDirty("word/comments.xml");
  if (idRows.length) {
    const p = "word/commentsIds.xml";
    d.pkg.setXml(p, parseXml(`${DECL}<w16cid:commentsIds xmlns:w16cid="${NS.w16cid}">${idRows.join("")}</w16cid:commentsIds>`, p));
    addRel(d.pkg, d.part, REL.commentsIds, "commentsIds.xml"); setOverride(d.pkg, p, `${CT}.commentsIds+xml`);
  }
  if (people) {
    const p = "word/people.xml";
    const ppl = Object.entries(people).map(([a, u]) => `<w15:person w15:author="${esc(a)}"><w15:presenceInfo w15:providerId="None" w15:userId="${esc(u)}"/></w15:person>`).join("");
    d.pkg.setXml(p, parseXml(`${DECL}<w15:people xmlns:w15="${W15}">${ppl}</w15:people>`, p));
    addRel(d.pkg, d.part, REL.people, "people.xml"); setOverride(d.pkg, p, `${CT}.people+xml`);
  }
  return Buffer.from(d.pkg.save());
}
