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
  function anchorText(a) { return (a && (a.text || a.quote || a.selector || a.id || a.kind)) || ""; }
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
  var threadList = el("ol", { class: "cv-threads" });
  var side = el("aside", { class: "cv-side" }, [el("div", { class: "cv-side-head" }, [handle, sendBtn]), el("div", { class: "cv-side-body" }, [composeSlot, sectionList, threadList])]);
  // A way out when the viewer has the whole tab (opened from the Library or
  // "Open in new window"). Inside the hub pane the pane has its own close.
  if (window.top === window) {
    root.appendChild(el("nav", { class: "cv-nav", "aria-label": T.nav }, [
      el("a", { href: "/dashboard/artifacts", text: "\u2190 " + T.library }),
      el("a", { href: "/dashboard/nest", text: T.nest }),
    ]));
  }
  root.appendChild(head);
  root.appendChild(banners);
  root.appendChild(trust);
  root.appendChild(el("div", { class: "cv-body" }, [stage, side]));
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
  versionSel.addEventListener("change", function () { S.n = Number(versionSel.value); renderThreads(); renderSections(); mountFrame(); });

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
    sendBtn.textContent = k === 0 ? T.send_none : k === 1 ? T.send_1 : fmt(T.send_n, { n: k });
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
    api("DELETE", BASE + "/comments/" + encodeURIComponent(c.id)).then(function () {
      // The thread's last comment gone: resolve it, so an empty thread never
      // lingers as something to send.
      var rest = (t.comments || []).filter(function (x) { return Number(x.id) !== Number(c.id); });
      return rest.length ? null : api("POST", BASE + "/threads/" + encodeURIComponent(t.id) + "/status", { status: "resolved" });
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
  function drawPins(list) {
    pinLayer.textContent = "";
    list.forEach(function (p) {
      var b = el("button", { type: "button", class: "cv-pin", "aria-label": fmt(T.pin, { n: p.i }), text: String(p.i), onclick: function () { focusThread(p.i); } });
      b.style.left = Math.round(p.x) + "px";
      b.style.top = Math.round(p.y) + "px";
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
      S.viewer.setPins(shown().map(function (t, k) { return t.author_kind === "owner" && t.status !== "resolved" ? { i: k + 1, anchor: t.anchor } : null; }).filter(Boolean));
    }
  }
  window.addEventListener("resize", function () { if (S.art && S.art.type === "diagram") pushPins(); });

  // ── sections (script-free documents) ────────────────────────────────────
  function renderSections() {
    sectionList.textContent = "";
    moreMenu.textContent = "";
    moreMenu.appendChild(button(T.reload, function () { more.removeAttribute("open"); if (S.viewer) S.viewer.reload().catch(function () {}); }));
    moreMenu.lastChild.setAttribute("title", T.reload_note);
    var v = version(S.n);
    if (!v || !v.anchor_map || v.anchor_map.kind !== "blocks") return;
    var byBlock = {};
    shown().forEach(function (t, k) { if (t.anchor && t.anchor.kind === "block") (byBlock[t.anchor.id] = byBlock[t.anchor.id] || []).push(k + 1); });
    v.anchor_map.blocks.forEach(function (b) {
      var nums = byBlock[b.id] ? " (" + byBlock[b.id].join(", ") + ")" : "";
      sectionList.appendChild(el("li", {}, [button((b.text.slice(0, 80) || b.id) + nums, function () {
        if (S.viewer) S.viewer.showBlock(b.id).catch(function () {});
        compose({ kind: "block", id: b.id, text: b.text });
      })]));
    });
  }

  // ── compose ─────────────────────────────────────────────────────────────
  function compose(anchor) {
    S.pending = anchor;
    composeSlot.textContent = "";
    var ta = el("textarea", { maxlength: "4000", rows: "3", "aria-label": T.add_comment });
    var q = anchor.kind === "block" ? el("input", { type: "text", class: "cv-quote", placeholder: T.quote, maxlength: "1000" }) : null;
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
    if (S.viewer) S.viewer.setCommentMode(S.commentOn);
    var type = S.art && S.art.type;
    if (type === "diagram") { if (S.commentOn) region.removeAttribute("hidden"); else region.setAttribute("hidden", ""); }
    // Script-free documents cannot propose from inside the frame: pick a section.
    if (sectionList.childNodes.length) { if (S.commentOn) { sectionList.removeAttribute("hidden"); setSheet(true); } else sectionList.setAttribute("hidden", ""); }
    if (S.commentOn) status.textContent = T.commenting; else renderStatus();
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
    if (S.viewer) { S.viewer.destroy(); S.viewer = null; }
    frameBox.textContent = ""; pinLayer.textContent = "";
    runBtn.setAttribute("hidden", "");
    var v = version(S.n), n = S.n;
    if (!v) return;
    if (v.flagged_reason) { showFlagged(); return; }
    var viewer = S.viewer = window.CrowArtifactViewer.mount({
      container: frameBox,
      mint: function (fragment, x) { return api("POST", BASE + "/versions/" + n + "/view", { fragment: fragment || null, replaces: (x && x.replaces) || null }); },
      loadEvidence: function (tokenId) { return api("GET", BASE + "/versions/" + n + "/load-evidence?tokenId=" + encodeURIComponent(tokenId)); },
      onProposal: function (a) { compose(a); },
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
      onRefuse: function () {
        banner(T.csp_missing, "danger");
        if (!/[?&]reloaded=1/.test(location.search)) location.replace(location.pathname + location.search + (location.search ? "&" : "?") + "reloaded=1");
      },
    });
    viewer.load().then(function (g) {
      if (!g) return;
      isolationNote(g.isolation);
      if (g.scriptsOff) runBtn.removeAttribute("hidden");   // D20
      if (S.commentOn) viewer.setCommentMode(true);
    }, function (e) {
      if (e.code === "flagged") showFlagged();
      else if (e.code === "origin_unavailable") isolationNote("unavailable");
      else if (e.message !== "csp-not-in-force" && e.message !== "stale") banner(e.message, "warn");
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
    if (S.commentOn) { if (S.activeRound) S.lastRound = S.activeRound; poll(); return; }
    if (S.activeRound) status.textContent = fmt(T.revising, { bot: S.art.created_by_bot || T.bot });
    else status.textContent = "";
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

  // ── Send N comments to chat (interim: the round preview + D4 delivery) ──
  function delivered(r) {
    var d = r.delivery || {};
    clearBanners("cv-delivery");
    var b;
    if (d.needsChoice) {
      var go = function (choice) { return function () { b.remove(); api("POST", BASE + "/rounds/" + r.round.id + "/deliver", { choice: choice }).then(delivered, function (e) { banner(e.message, "warn"); }); }; };
      b = banner(T.no_session, "info", [button(T.new_session, go("new-session"))].concat(d.offerBoard ? [button(T.board_card, go("board-card"))] : []));
    } else if (d.status === "queued") b = banner(T.queued, "info");
    else if (d.error || d.status === "failed") b = banner(fmt(T.delivery_failed, { e: d.error || d.status }), "warn");   // never a false "working"
    if (b) b.classList.add("cv-delivery");
    return refresh();
  }
  sendBtn.addEventListener("click", function () {
    api("GET", BASE + "/round-preview").then(function (pv) {
      if (pv.activeRound) { banner(T.round_running, "warn"); return; }
      var dlg = el("dialog", { class: "cv-preview" });
      dlg.appendChild(el("h2", { text: T.preview_title }));
      pv.threads.forEach(function (t) {
        var cb = el("input", { type: "checkbox", value: String(t.id) });
        cb.checked = !!t.includedByDefault;
        var body = el("div", {}, t.comments.map(function (c) { return el("p", {}, [el("b", { text: authorName(c) + ": " }), el("span", { text: c.text })]); }));
        if (t.untrusted) body.insertBefore(el("em", { text: T.contact_thread }), body.firstChild);
        dlg.appendChild(el("div", { class: "cv-pv" + (t.untrusted ? " cv-untrusted" : "") }, [el("label", {}, [cb, el("span", { text: " " + T.include })]), body]));
      });
      var close = function () { dlg.close(); dlg.remove(); };
      dlg.appendChild(el("div", { class: "cv-row" }, [
        button(T.send_go, function () {
          var ids = Array.prototype.map.call(dlg.querySelectorAll("input:checked"), function (x) { return Number(x.value); });
          close();
          if (!ids.length) return;
          api("POST", BASE + "/rounds", { include: ids, kind: "round" }).then(delivered, function (e) { banner(e.code === "round_running" ? T.round_running : e.message, "warn"); });
        }, "cv-primary"),
        button(T.cancel, close),
      ]));
      root.appendChild(dlg);
      dlg.showModal();
    }, function (e) { banner(e.message, "warn"); });
  });

  refresh().then(mountFrame, function (e) {
    showPanel("cv-gone", e.status === 404 ? T.gone : e.message);
  });
})();
