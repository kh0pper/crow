/*
 * Crow Artifacts — the viewer page client (dashboard origin, trusted; plan
 * PR-2 Task 2.2). Classic script. Draws the header (title, version switcher,
 * status, Run scripts, More), the frame (through viewer.js), the numbered
 * pins, the threads column (wide) or bottom sheet (phone), the floating
 * Comment toggle and the one primary action, Send N comments to chat.
 *
 * Rules:
 *  - every user-, bot- or contact-authored string is placed with textContent;
 *  - nothing from the artifact frame acts without a click here: proposals open
 *    the compose box, rects only move cosmetic pins;
 *  - F3: a trip or a flagged version replaces the frame immediately (no raw
 *    origin error body is ever visible); D24 "couldn't load" offers Retry;
 *  - D26: there is no "Ask the bot now" here — the owner asks in the chat;
 *  - a 5 s status poll runs only while a round is active and the page is
 *    visible.
 */
(function () {
  "use strict";
  var root = document.getElementById("crow-artifact-viewer");
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = "1";
  var T = JSON.parse(root.dataset.strings || "{}");
  var ID = root.dataset.artifact || "";
  var THREAD = root.dataset.thread || "";
  var WANT_V = Number(root.dataset.version) || null;
  var POLL_MS = 5000, LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  var BASE = "/api/artifacts/" + encodeURIComponent(ID);

  var fmt = function (s, o) { return String(s || "").replace(/\{(\w+)\}/g, function (_, k) { return o && o[k] != null ? String(o[k]) : ""; }); };
  var csrf = function () { var m = /(?:^|;\s*)crow_csrf=([^;]+)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : ""; };
  function api(method, path, body) {
    return fetch(path, { method: method, credentials: "same-origin", headers: { "content-type": "application/json", "x-crow-csrf": csrf() }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.message || j.error || String(r.status)); e.code = j.error; e.status = r.status; throw e; } return j; }); });
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  // D28 (review M2): a quote is what the owner picked, so it leads.
  function anchorText(a) { return a && a.quote ? "\u201c" + a.quote + "\u201d" : (a && (a.text || a.selector || a.id || a.kind)) || ""; }
  function isDoc() { return !!(S.art && S.art.type === "document"); }
  function authorName(c) { return c.author_kind === "owner" ? T.you : c.author_kind === "bot" ? (c.author_id || T.bot) : (c.author_id || c.author_kind); }

  var S = { art: null, versions: [], threads: [], activeRound: null, n: null, viewer: null, poll: null, sheetOpen: false, commentOn: false, pending: null, lastRound: null, locked: [], editing: null };

  // ── skeleton ────────────────────────────────────────────────────────────
  var title = el("h1", { class: "cv-title" });
  var versionSel = el("select", { class: "cv-version", "aria-label": T.version });
  var status = el("span", { class: "cv-status", role: "status", "aria-live": "polite" });
  var runBtn = el("button", { type: "button", class: "cv-run", hidden: "", text: T.run_scripts });
  var openChat = el("a", { class: "cv-openchat", hidden: "", text: T.open_chat });
  var moreMenu = el("div", { class: "cv-menu" });
  var more = el("details", { class: "cv-more" }, [el("summary", { "aria-label": T.more, text: "⋯" }), moreMenu]);
  var head = el("header", { class: "cv-head" }, [title, el("div", { class: "cv-headtools" }, [versionSel, runBtn, openChat, more]), status]);
  var banners = el("div", { class: "cv-banners" });
  var trust = el("div", { class: "cv-trust" });
  var frameBox = el("div", { class: "cv-frame" });
  var pinLayer = el("div", { class: "cv-pins", "aria-hidden": "false" });
  var region = el("div", { class: "cv-region", hidden: "" });
  var stage = el("div", { class: "cv-stage" }, [frameBox, pinLayer, region]);
  var commentBtn = el("button", { type: "button", class: "cv-comment", "aria-pressed": "false", text: T.comment });
  var handle = el("button", { type: "button", class: "cv-handle", "aria-expanded": "false" });
  var sendBtn = el("button", { type: "button", class: "cv-send" });
  var composeSlot = el("div", { class: "cv-compose-slot" });
  var sectionList = el("ol", { class: "cv-sections", hidden: "", "aria-label": T.pick_section });
  // D28 (review H1): a selection in the frame is only a PROPOSAL; this
  // trusted button turns it into a comment on the owner's tap.
  var selBar = el("div", { class: "cv-selbar", hidden: "" });
  var threadList = el("ol", { class: "cv-threads" });
  var side = el("aside", { class: "cv-side" }, [el("div", { class: "cv-side-head" }, [handle, sendBtn]), el("div", { class: "cv-side-body" }, [composeSlot, sectionList, threadList])]);
  // A way out when the viewer has the whole tab (opened from the Library or
  // "Open in new window"). Inside the hub pane the pane has its own close.
  if (window.top === window) {
    // A slim header-like bar (QW4 B2). The title is plain text, not a link:
    // the bar has exactly two ways out.
    root.appendChild(el("nav", { class: "cv-nav", "aria-label": T.nav }, [
      el("a", { class: "cv-nav-back", href: "/dashboard/artifacts", text: "\u2190 " + T.library }),
      el("span", { class: "cv-nav-title", text: T.library_title }),
      el("a", { class: "cv-nav-nest", href: "/dashboard/nest", text: T.nest }),
    ]));
  }
  root.appendChild(head);
  root.appendChild(banners);
  root.appendChild(trust);
  root.appendChild(el("div", { class: "cv-body" }, [stage, side]));
  root.appendChild(selBar);
  root.appendChild(commentBtn);
  root.appendChild(el("p", { class: "cv-note", text: T.never_password }));

  function banner(text, kind, buttons) {
    var b = el("div", { class: "cv-banner cv-" + (kind || "info"), role: "status" }, [el("span", { text: text })]);
    (buttons || []).forEach(function (x) { b.appendChild(x); });
    banners.appendChild(b);
    return b;
  }
  function clearBanners(cls) { Array.prototype.slice.call(banners.querySelectorAll(cls ? "." + cls : ".cv-banner")).forEach(function (b) { b.remove(); }); }
  function button(text, onclick, cls) { return el("button", { type: "button", class: cls || "", text: text, onclick: onclick }); }

  function setSheet(open) {
    S.sheetOpen = !!open;
    side.classList.toggle("cv-open", S.sheetOpen);
    handle.setAttribute("aria-expanded", S.sheetOpen ? "true" : "false");
  }
  handle.addEventListener("click", function () { setSheet(!S.sheetOpen); });

  // Open chat: only in a window of its own (inside the hub the chat is right there).
  if (/^perchlive-[0-9a-f]{8}$/.test(THREAD) && window.top === window) {
    openChat.setAttribute("href", "/dashboard/perch#" + THREAD);
    openChat.removeAttribute("hidden");
  }

  // ── data ────────────────────────────────────────────────────────────────
  function refresh() {
    return api("GET", BASE).then(function (j) {
      S.art = j.artifact; S.versions = j.versions || []; S.threads = j.threads || []; S.activeRound = j.activeRound || null; S.locked = (j.lockedThreads || []).map(Number);
      if (S.n == null) S.n = (WANT_V && S.versions.some(function (v) { return Number(v.n) === WANT_V; })) ? WANT_V : Number(S.art.current_version);
      document.title = S.art.title;
      title.textContent = S.art.title;
      trust.textContent = fmt(T.made_by, { bot: S.art.created_by_bot || T.you });
      renderVersions(); renderThreads(); renderStatus(); renderSections();
      return j;
    });
  }
  function version(n) { return S.versions.find(function (v) { return Number(v.n) === Number(n); }) || null; }

  function renderVersions() {
    versionSel.textContent = "";
    S.versions.forEach(function (v) {
      var tag = v.flagged_reason ? T.flagged_v : Number(v.n) === Number(S.art.current_version) ? T.current : v.state === "proposed" ? T.proposed : "";
      var o = el("option", { value: String(v.n), text: "v" + v.n + (tag ? " · " + tag : "") });
      if (Number(v.n) === Number(S.n)) o.selected = true;
      versionSel.appendChild(o);
    });
    if (S.versions.length < 2) versionSel.setAttribute("hidden", ""); else versionSel.removeAttribute("hidden");
  }
  versionSel.addEventListener("change", function () { S.n = Number(versionSel.value); S.editing = null; hideSelBar(); renderThreads(); renderSections(); mountFrame(); });

  /** The threads the owner would send by default: open, owner-authored. */
  function sendable() { return S.threads.filter(function (t) { return t.author_kind === "owner" && t.status !== "resolved"; }); }

  /** The threads anchored on the MOUNTED version (carry-forward moves open
   *  threads onto each new version), numbered in that list's order — so a
   *  pin number always means a thread on the version you are looking at. */
  function shown() { return S.threads.filter(function (t) { return Number(t.version_n) === Number(S.n); }); }

  function renderThreads() {
    if (S.editing != null) return;   // a poll never wipes a half-typed edit; Save/Cancel redraws
    threadList.textContent = "";
    shown().forEach(function (t, k) {
      var num = k + 1;
      var st = t.status === "resolved" ? " · " + T.resolved : t.status === "anchor-moved" ? " · " + T.moved : "";
      var li = el("li", { class: "cv-thread cv-" + t.status, id: "cv-t" + num, tabindex: "-1" }, [
        el("div", { class: "cv-thread-head" }, [el("span", { class: "cv-num", text: String(num) }), el("span", { class: "cv-anchor", text: anchorText(t.anchor) + st })]),
      ]);
      (t.comments || []).forEach(function (c) { li.appendChild(commentNode(t, c)); });
      threadList.appendChild(li);
    });
    if (!shown().length) threadList.appendChild(el("li", { class: "cv-empty", text: T.no_comments }));
    var n = shown().length;
    handle.textContent = n === 1 ? T.comments_1 : fmt(T.comments_n, { n: n });
    var k = sendable().length;
    // S5: while a round runs, the disabled Send says why.
    sendBtn.textContent = S.activeRound ? fmt(T.revising, { bot: (S.art && S.art.created_by_bot) || T.bot }) : k === 0 ? T.send_none : k === 1 ? T.send_1 : fmt(T.send_n, { n: k });
    if (k === 0 || S.activeRound) sendBtn.setAttribute("disabled", ""); else sendBtn.removeAttribute("disabled");
    pushPins();
  }

  /** One comment. The owner's OWN comments get Edit/Delete — hidden while a
   *  round or ask holds the thread (the server refuses then too). */
  function commentNode(t, c) {
    var p = el("p", { class: "cv-c cv-" + c.author_kind }, [el("b", { class: "cv-chip", text: authorName(c) }), el("span", { text: " " + c.text }),
      c.edited_at ? el("span", { class: "cv-edited", text: " \u00b7 " + T.edited }) : null]);
    if (c.author_kind === "owner" && S.locked.indexOf(Number(t.id)) < 0) {
      p.appendChild(el("span", { class: "cv-cacts" }, [
        button(T.edit, function () { startEdit(p, c); }, "cv-link"),
        button(T.delete, function () { removeComment(t, c); }, "cv-link"),
      ]));
    }
    return p;
  }
  function changeFailed(e) { return e && e.code === "comment_locked" ? T.locked_note : (e && e.message) || "error"; }
  function startEdit(p, c) {
    S.editing = Number(c.id);
    // One edit at a time (review L2): the other comments' actions wait.
    Array.prototype.forEach.call(threadList.querySelectorAll(".cv-cacts button"), function (b) { b.setAttribute("disabled", ""); });
    var ta = el("textarea", { class: "cv-edit-text", rows: "3", "aria-label": T.edit });
    ta.value = c.text;
    var msg = el("p", { class: "cv-err", role: "alert" });
    var done = function () { S.editing = null; renderThreads(); };
    var save = function () {
      api("PATCH", BASE + "/comments/" + encodeURIComponent(c.id), { text: ta.value })
        .then(function () { S.editing = null; return refresh(); }, function (e) { msg.textContent = changeFailed(e); });
    };
    p.replaceWith(el("div", { class: "cv-editbox" }, [ta, msg, el("div", { class: "cv-row" }, [button(T.save, save, "cv-primary"), button(T.cancel, done)])]));
    ta.focus();
  }
  function removeComment(t, c) {
    if (!window.confirm(T.delete_confirm)) return;
    api("DELETE", BASE + "/comments/" + encodeURIComponent(c.id)).then(function (j) {
      // The thread's last comment gone (the SERVER's count — a reply that
      // arrived since the last poll keeps it open): resolve it, so an empty
      // thread never lingers as something to send.
      return j && j.remaining === 0 ? api("POST", BASE + "/threads/" + encodeURIComponent(t.id) + "/status", { status: "resolved" }) : null;
    }).then(refresh, function (e) { banner(changeFailed(e), "warn"); });
  }

  function focusThread(num) {
    var li = document.getElementById("cv-t" + num);
    if (!li) return;
    setSheet(true);
    li.classList.add("cv-focus");
    setTimeout(function () { li.classList.remove("cv-focus"); }, 1600);
    li.scrollIntoView({ block: "nearest" });
    li.focus({ preventScroll: true });
  }

  // ── pins (cosmetic; click = focus that thread) ──────────────────────────
  // S1 (plan Rev 3 L6): a pin sits in the LEFT GUTTER of its anchor's block
  // (x = the block's left edge minus the pin), on the quote's first line
  // (y = that line's centre), so it never covers the words. Pins closer than
  // one pin height step sideways in the gutter; none is hidden. A diagram's
  // region pins (no h, no bx) sit exactly on their point.
  var PIN_R = 14;
  function drawPins(list) {
    pinLayer.textContent = "";
    var placed = [];
    list.slice().sort(function (a, b) { return a.y - b.y || a.i - b.i; }).forEach(function (p) {
      var x = p.x, y = p.y;
      if (p.h !== undefined || p.bx !== undefined) {
        x = Math.max(PIN_R + 2, (p.bx !== undefined ? p.bx : p.x) - PIN_R - 4);
        y = p.y + (p.h || 0) / 2;
        var base = x;
        for (var k = 0; k < placed.length; k++) {
          if (Math.abs(placed[k].y - y) < 2 * PIN_R && Math.abs(placed[k].x - x) < 2 * PIN_R) { x = placed[k].x + 2 * PIN_R + 2; k = -1; }
          if (x - base > 20 * PIN_R) break;
        }
      }
      placed.push({ x: x, y: y });
      var b = el("button", { type: "button", class: "cv-pin", "aria-label": fmt(T.pin, { n: p.i }), text: String(p.i), onclick: function () { focusThread(p.i); } });
      b.style.left = Math.round(x) + "px";
      b.style.top = Math.round(y) + "px";
      pinLayer.appendChild(b);
    });
  }
  function pushPins() {
    if (!S.art) return;
    if (S.art.type === "diagram") {
      // Script-free region anchors: the trusted side places these itself.
      var w = frameBox.clientWidth, h = frameBox.clientHeight;
      drawPins(shown().map(function (t, k) { return t.status !== "resolved" && t.anchor && t.anchor.kind === "region" ? { i: k + 1, x: t.anchor.x * w, y: t.anchor.y * h } : null; }).filter(Boolean));
    } else if (S.viewer) {
      // Scripted types: the OWNER's element/text anchors only (viewer.js
      // re-validates); the helper reports where they are.
      // S1: the MOUNTED version's anchor map lets a document block anchor
      // cross as that version's own rendered words (viewer.js pinOut).
      var mv = version(S.n);
      S.viewer.setPins(shown().map(function (t, k) { return t.author_kind === "owner" && t.status !== "resolved" ? { i: k + 1, anchor: t.anchor } : null; }).filter(Boolean), mv && mv.anchor_map);
    }
  }
  window.addEventListener("resize", function () { if (S.art && S.art.type === "diagram") pushPins(); });

  // ── sections (script-free documents) ────────────────────────────────────
  function renderSections() {
    sectionList.textContent = "";
    moreMenu.textContent = "";
    moreMenu.appendChild(button(T.reload, function () { more.removeAttribute("open"); if (S.viewer) S.viewer.reload().catch(function () {}); }));
    moreMenu.lastChild.setAttribute("title", T.reload_note);
    if (S.art && S.art.created_by_bot) moreMenu.appendChild(button(T.let_bot, function () { more.removeAttribute("open"); openGrants(); }, "cv-grant"));
    var v = version(S.n);
    if (!v || !v.anchor_map || v.anchor_map.kind !== "blocks") return;
    // Review M6: the keyboard / screen-reader way to comment on a section.
    // Opened on demand from the menu; never auto-opened over the document.
    moreMenu.appendChild(button(T.pick_section, function () { more.removeAttribute("open"); sectionList.removeAttribute("hidden"); setSheet(true); }, "cv-pick-section"));
    var byBlock = {};
    shown().forEach(function (t, k) { if (t.anchor && t.anchor.kind === "block") (byBlock[t.anchor.id] = byBlock[t.anchor.id] || []).push(k + 1); });
    v.anchor_map.blocks.forEach(function (b) {
      var nums = byBlock[b.id] ? " (" + byBlock[b.id].join(", ") + ")" : "";
      sectionList.appendChild(el("li", {}, [button(((b.plain || b.text).slice(0, 80) || b.id) + nums, function () {
        if (S.viewer) S.viewer.showBlock(b.id).catch(function () {});
        compose({ kind: "block", id: b.id, text: b.text, fromList: true });
      })]));
    });
  }

  // ── selections (D28) ────────────────────────────────────────────────────
  function hideSelBar() { selBar.textContent = ""; selBar.setAttribute("hidden", ""); }
  function offerSelection(a) {
    var q = a.quote.length > 60 ? a.quote.slice(0, 57) + "\u2026" : a.quote;
    // Documents: name the block; the server resolves it against the stored
    // anchor map (block text from the map, quote checked) or falls back to a
    // text anchor. Pages: the text anchor as proposed.
    var anchor = isDoc() && a.block ? { kind: "block", id: a.block, quote: a.quote, prefix: a.prefix, suffix: a.suffix } : { kind: "text", quote: a.quote, prefix: a.prefix, suffix: a.suffix };
    selBar.textContent = "";
    selBar.appendChild(button(fmt(T.comment_selection, { q: q }), function () { hideSelBar(); compose(anchor); }, "cv-primary"));
    selBar.removeAttribute("hidden");
  }

  // ── compose ─────────────────────────────────────────────────────────────
  function compose(anchor) {
    S.pending = anchor;
    composeSlot.textContent = "";
    var ta = el("textarea", { maxlength: "4000", rows: "3", "aria-label": T.add_comment });
    var q = anchor.kind === "block" && !anchor.quote ? el("input", { type: "text", class: "cv-quote", placeholder: T.quote, maxlength: "1000" }) : null;
    var box = el("div", { class: "cv-compose" }, [el("div", { class: "cv-anchor", text: anchorText(anchor) }), q, ta,
      el("div", { class: "cv-row" }, [
        button(T.add_comment, function () {
          var a = Object.assign({}, S.pending, q && q.value ? { quote: q.value } : {});
          api("POST", BASE + "/threads", { versionN: S.n, anchor: a, text: ta.value }).then(function () {
            S.pending = null; composeSlot.textContent = ""; return refresh();
          }, function (e) { banner(e.message, "warn"); });
        }, "cv-primary"),
        button(T.cancel, function () { S.pending = null; composeSlot.textContent = ""; }),
      ])]);
    composeSlot.appendChild(box);
    setSheet(true);
    ta.focus();
  }

  function setComment(on) {
    S.commentOn = !!on;
    commentBtn.setAttribute("aria-pressed", S.commentOn ? "true" : "false");
    if (S.viewer) S.viewer.setCommentMode(S.commentOn, { selectOnly: isDoc() });
    if (!S.commentOn) hideSelBar();
    var type = S.art && S.art.type;
    if (type === "diagram") { if (S.commentOn) region.removeAttribute("hidden"); else region.setAttribute("hidden", ""); }
    // Script-free documents cannot propose from inside the frame: pick a section.
    // D28: no list, no sheet over the document — select text instead.
    if (!S.commentOn) sectionList.setAttribute("hidden", "");
    renderStatus();
  }
  commentBtn.addEventListener("click", function () { setComment(!S.commentOn); });
  region.addEventListener("click", function (e) {
    var r = region.getBoundingClientRect();
    compose({ kind: "region", x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) });
  });

  // ── the frame ───────────────────────────────────────────────────────────
  function showPanel(cls, text, sub, btns) {
    frameBox.textContent = "";
    pinLayer.textContent = "";
    var p = el("div", { class: "cv-panel " + cls, role: "alert" }, [el("p", { class: "cv-panel-title", text: text })]);
    if (sub) p.appendChild(el("p", { text: sub }));
    (btns || []).forEach(function (b) { p.appendChild(b); });
    frameBox.appendChild(p);
  }
  function showFlagged() { showPanel("cv-flagged", T.tripped, T.flagged_note); }

  function isolationNote(iso) {
    clearBanners("cv-iso");
    if (iso === "shared-host") banner(LOCAL_HOSTS.test(location.host) ? T.weaker : T.fallback_remote, "warn").classList.add("cv-iso");
    else if (iso === "unavailable" || !iso) banner(T.unavailable, "warn").classList.add("cv-iso");
  }

  function mountFrame() {
    hideSelBar();
    if (S.viewer) { S.viewer.destroy(); S.viewer = null; }
    frameBox.textContent = ""; pinLayer.textContent = "";
    runBtn.setAttribute("hidden", "");
    var v = version(S.n), n = S.n;
    if (!v) return;
    if (v.flagged_reason) { showFlagged(); return; }
    var viewer = S.viewer = window.CrowArtifactViewer.mount({
      container: frameBox,
      mint: function (fragment, x) { return api("POST", BASE + "/versions/" + n + "/view", { fragment: fragment || null, replaces: (x && x.replaces) || null }); },
      revoke: function (tokenId) { return api("POST", BASE + "/view-tokens/revoke", { tokenId: tokenId }); },
      loadEvidence: function (tokenId) { return api("GET", BASE + "/versions/" + n + "/load-evidence?tokenId=" + encodeURIComponent(tokenId)); },
      // A tap (pages) composes at once; a SELECTION waits for the owner's tap
      // on the trusted "Comment on …" button (review H1).
      onProposal: function (a) { if (!S.commentOn) return; if (a.kind === "text") offerSelection(a); else compose(a); },
      onTrip: function (reason) {
        showFlagged();   // F3: replaced at once, before the server answers
        api("POST", BASE + "/versions/" + n + "/tripwire", { reason: reason }).then(refresh, function () {});
      },
      onRetry: function () {
        showPanel("cv-retry", T.retry_title, "", [button(T.retry, function () {
          frameBox.textContent = "";
          viewer.reload().catch(function () {});
        }, "cv-primary")]);
      },
      onReady: function () { pushPins(); },
      onRects: function (rects) { drawPins(rects); },
      // The narrowed CSP is not in force: reload for real; never show content.
      onRefuse: function (reason) {
        if (reason === "bad-grant") { showPanel("cv-gone", T.cant_show); return; }   // review H2: local, never a flag
        banner(T.csp_missing, "danger");
        if (!/[?&]reloaded=1/.test(location.search)) location.replace(location.pathname + location.search + (location.search ? "&" : "?") + "reloaded=1");
      },
    });
    viewer.load().then(function (g) {
      if (!g) return;
      isolationNote(g.isolation);
      if (g.scriptsOff) runBtn.removeAttribute("hidden");   // D20
      if (S.commentOn) viewer.setCommentMode(true, { selectOnly: isDoc() });
    }, function (e) {
      if (e.code === "flagged") showFlagged();
      else if (e.code === "origin_unavailable") isolationNote("unavailable");
      else if (e.message !== "csp-not-in-force" && e.message !== "stale" && e.message !== "bad-grant") banner(e.message, "warn");   // bad-grant: onRefuse already showed the panel
    });
  }
  runBtn.addEventListener("click", function () {   // D20: the owner's press is the approve (audited)
    api("POST", BASE + "/versions/" + S.n + "/approve", {}).then(function () { return refresh(); }).then(mountFrame, function (e) { banner(e.message, "warn"); });
  });

  // ── status, proposed versions, polling ──────────────────────────────────
  function renderStatus() {
    clearBanners("cv-proposed");
    S.versions.filter(function (x) { return x.state === "proposed" && !x.flagged_reason; }).forEach(function (p) {
      var decide = function (accept) { return function () { api("POST", BASE + "/versions/" + p.n + "/decide", { accept: accept }).then(refresh).then(mountFrame, function (e) { banner(e.message, "warn"); }); }; };
      banner(fmt(T.proposed_note, { n: p.n }) + (p.change_note ? " — " + p.change_note : ""), "info",
        [button(T.accept, decide(true)), button(T.drop, decide(false))]).classList.add("cv-proposed");
    });
    // S5: the banners always run; only the idle status line yields to the
    // comment-mode hint.
    if (S.activeRound) status.textContent = fmt(T.revising, { bot: S.art.created_by_bot || T.bot });
    else status.textContent = S.commentOn ? (isDoc() ? T.commenting_doc : T.commenting) : "";
    // A round just finished with a new current version: say so, offer it.
    if (S.lastRound && !S.activeRound) {
      S.lastRound = null;
      var cur = Number(S.art.current_version);
      if (cur !== Number(S.n)) {
        clearBanners("cv-ready");
        banner(fmt(T.ready, { n: cur }), "ok", [button(fmt(T.show_v, { n: cur }), function () { clearBanners("cv-ready"); S.n = cur; renderVersions(); renderThreads(); renderSections(); mountFrame(); })]).classList.add("cv-ready");
      }
    }
    if (S.activeRound) S.lastRound = S.activeRound;
    poll();
  }
  function poll() {
    if (S.poll || !S.activeRound || document.visibilityState === "hidden") return;
    S.poll = setTimeout(function () { S.poll = null; refresh().catch(function () {}); }, POLL_MS);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { clearTimeout(S.poll); S.poll = null; }
    else if (S.activeRound) refresh().catch(function () {});
  });

  // ── Send N comments to chat: the send sheet (plan PR-3 Task 3.4) ───────
  // What to include (owner threads on, contact threads off unless ticked),
  // then WHERE: the artifact's linked chats (most recent first; ones a Send
  // cannot reach shown disabled), "New chat with <bot>", and "Board card"
  // when this instance has a board. The chat this viewer was opened from is
  // preselected. The server verifies the choice again; there is no banner
  // path — a needsChoice answer reopens the sheet on its where-step.
  function whyText(code) { return T["why_" + code] || fmt(T.delivery_failed, { e: code }); }
  function delivered(r) {
    var d = r.delivery || {};
    clearBanners("cv-delivery");
    var b;
    if (d.needsChoice) { openSheet({ roundId: r.round.id }); return refresh(); }
    if (d.status === "queued") b = banner(T.queued, "info");
    else if (d.error || d.status === "failed") b = banner(whyText(d.error || d.status), "warn");   // never a false "working"
    if (b) b.classList.add("cv-delivery");
    return refresh();
  }
  function failed(e) { banner(e.code === "round_running" ? T.round_running : T["why_" + e.code] ? whyText(e.code) : e.message, "warn"); }
  function chatName(l) { return l.threadId === THREAD ? T.this_chat : (l.label || fmt(T.a_chat, { id: String(l.threadId).slice(-8) })); }

  function whereStep(dlg, info, roundId) {
    var box = el("fieldset", { class: "cv-where" }, [el("legend", { text: roundId ? T.pick_where : T.send_to })]);
    var options = [];
    if (!roundId) (info.links || []).forEach(function (l) { options.push({ choice: "chat", thread: l.threadId, text: chatName(l) + (l.state === "stopped" ? " (" + T.asleep_note + ")" : ""), disabled: !l.sendable }); });
    options.push({ choice: "new-session", text: fmt(T.new_chat, { bot: info.bot || T.bot }) });
    if (info.offerBoard) options.push({ choice: "board-card", text: T.board_card });
    // Review M2: opened from a chat, Send means THAT chat — never quietly
    // another one. If it cannot take the round, nothing is preselected and
    // the sheet says why; the owner picks. Opened from the Library (no
    // chat), the first option that can take it is the default.
    var pick = null;
    if (THREAD && !roundId) {
      var mine = (info.links || []).filter(function (l) { return l.threadId === THREAD; })[0];
      pick = options.filter(function (o) { return !o.disabled && o.thread === THREAD; })[0] || null;
      if (!pick) box.appendChild(el("p", { class: "cv-err", role: "alert", text: whyText((mine && mine.why) || "target_unlinked") }));
    } else pick = options.filter(function (o) { return !o.disabled; })[0];
    options.forEach(function (o, i) {
      var rb = el("input", { type: "radio", name: "cv-where", value: String(i) });
      if (o.disabled) rb.setAttribute("disabled", "");
      if (o === pick) rb.checked = true;
      box.appendChild(el("label", { class: "cv-where-opt" + (o.disabled ? " cv-disabled" : "") }, [rb, el("span", { text: " " + o.text })]));
    });
    dlg.appendChild(box);
    return function () { var c = dlg.querySelector('input[name="cv-where"]:checked'); return c ? options[Number(c.value)] : null; };
  }

  function openSheet(opts) {
    var roundId = opts && opts.roundId;
    Promise.all([roundId ? Promise.resolve(null) : api("GET", BASE + "/round-preview"), api("GET", BASE + "/links")]).then(function (got) {
      var pv = got[0], info = got[1];
      if (pv && pv.activeRound) { banner(T.round_running, "warn"); return; }
      var dlg = el("dialog", { class: "cv-preview" });
      if (pv) {
        dlg.appendChild(el("h2", { text: T.preview_title }));
        pv.threads.forEach(function (t) {
          var cb = el("input", { type: "checkbox", value: String(t.id), class: "cv-include" });
          cb.checked = !!t.includedByDefault;
          var body = el("div", {}, t.comments.map(function (c) { return el("p", {}, [el("b", { text: authorName(c) + ": " }), el("span", { text: c.text })]); }));
          if (t.untrusted) body.insertBefore(el("em", { text: T.contact_thread }), body.firstChild);
          dlg.appendChild(el("div", { class: "cv-pv" + (t.untrusted ? " cv-untrusted" : "") }, [el("label", {}, [cb, el("span", { text: " " + T.include })]), body]));
        });
      }
      // Review L7: words from outside the owner's Crow (a ticked contact
      // thread, or a base version shaped by one) make the server send the
      // round to a NEW, LOCKED chat whatever is picked below — say so.
      var lockedNote = null;
      if (pv) {
        lockedNote = el("p", { class: "cv-note cv-outside-note", role: "status", text: fmt(T.outside_note, { bot: info.bot || T.bot }) });
        var syncLocked = function () {
          var outside = !!pv.baseTainted || Array.prototype.some.call(dlg.querySelectorAll("input.cv-include:checked"), function (x) {
            return pv.threads.some(function (t) { return String(t.id) === x.value && t.untrusted; });
          });
          lockedNote.hidden = !outside;
        };
        Array.prototype.forEach.call(dlg.querySelectorAll("input.cv-include"), function (x) { x.addEventListener("change", syncLocked); });
        syncLocked();
        dlg.appendChild(lockedNote);
      }
      var where = whereStep(dlg, info, roundId);
      var close = function () { dlg.close(); dlg.remove(); };
      dlg.appendChild(el("div", { class: "cv-row" }, [
        button(T.send_go, function () {
          var w = where();
          if (!w) return;
          var body = { choice: w.choice };
          if (w.thread) body.thread = w.thread;
          if (roundId) { close(); api("POST", BASE + "/rounds/" + roundId + "/deliver", body).then(delivered, failed); return; }
          var ids = Array.prototype.map.call(dlg.querySelectorAll("input.cv-include:checked"), function (x) { return Number(x.value); });
          close();
          if (!ids.length) return;
          body.include = ids; body.kind = "round";
          api("POST", BASE + "/rounds", body).then(delivered, failed);
        }, "cv-primary"),
        button(T.cancel, close),
      ]));
      root.appendChild(dlg);
      dlg.showModal();
    }, function (e) { banner(e.message, "warn"); });
  }
  sendBtn.addEventListener("click", function () { openSheet(null); });

  // ── "Let a bot work on this" (plan PR-3 Task 3.7): owner routes only ─────
  function openGrants() {
    Promise.all([api("GET", "/api/artifacts/bots"), api("GET", BASE + "/access")]).then(function (got) {
      var others = (got[0].bots || []).filter(function (b) { return b.id !== S.art.created_by_bot; });
      var granted = {};
      (got[1].grants || []).forEach(function (g) { granted[g.botId] = true; });
      var dlg = el("dialog", { class: "cv-grants" }, [el("h2", { text: T.grant_title })]);
      var msg = el("p", { class: "cv-err", role: "alert" });
      if (!others.length) dlg.appendChild(el("p", { text: T.grant_none }));
      else dlg.appendChild(el("p", { class: "cv-note", text: T.grant_note }));
      others.forEach(function (b) {
        var cb = el("input", { type: "checkbox", value: b.id });
        cb.checked = !!granted[b.id];
        cb.addEventListener("change", function () {
          cb.disabled = true; msg.textContent = "";
          var p = cb.checked ? api("POST", BASE + "/access", { botId: b.id }) : api("DELETE", BASE + "/access/" + encodeURIComponent(b.id));
          p.then(function () { cb.disabled = false; }, function (e) { cb.checked = !cb.checked; cb.disabled = false; msg.textContent = e.message; });
        });
        dlg.appendChild(el("label", { class: "cv-where-opt" }, [cb, el("span", { text: " " + b.name })]));
      });
      dlg.appendChild(msg);
      dlg.appendChild(el("div", { class: "cv-row" }, [button(T.done, function () { dlg.close(); dlg.remove(); }, "cv-primary")]));
      root.appendChild(dlg);
      dlg.showModal();
    }, function (e) { banner(e.message, "warn"); });
  }

  refresh().then(mountFrame, function (e) {
    showPanel("cv-gone", e.status === 404 ? T.gone : e.message);
  });
})();
