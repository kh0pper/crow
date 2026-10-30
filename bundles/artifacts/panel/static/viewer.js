/*
 * Crow Artifacts — the trusted viewer (dashboard origin). Classic script; it
 * assigns window.CrowArtifactViewer.
 *
 * Spec §5.1/§5.3:
 *  - frames https://<artifact-host>/v/<token>/ with the type's sandbox (never
 *    allow-same-origin / top-navigation / popups / forms), referrerpolicy
 *    no-referrer and no permissions;
 *  - NAVIGATION TRIPWIRE: counts the iframe's load events and, for scripted
 *    types, expects one hello carrying this load's nonce. A second load, a
 *    missing hello or a wrong nonce means the frame navigated: tear it down,
 *    report it (the server flags the version, audits, notifies). Post-hoc by
 *    design: the first request has already left when this fires;
 *  - every frame message is an untrusted PROPOSAL: source, origin, shape,
 *    size, rate and nonce checked; nothing acts without a user gesture in the
 *    rail. The kinds: hello, anchor (a proposal), anchor-rect (pin rects),
 *    selection-cleared (S6: hides the trusted "Comment on …" button, nothing
 *    else) and open-link (2026-10-30: the helper proposes an http(s) link
 *    after the owner's click; this file validates it and asks in a TRUSTED
 *    sheet before anything leaves the viewer). All but hello are ignored
 *    before the hello; an open-link is never navigated to automatically.
 *  - the parent never posts anything sensitive in: only {kind:"comment-mode"}
 *    and {kind:"pins"} — the numbered anchors of the OWNER's threads on this
 *    version (element selectors / text quotes the content itself proposed;
 *    document block ids, with the server-rendered words a block anchor's span
 *    covers — S1; never comment text, authors, contact anchors or ids). The
 *    helper answers {kind:"anchor-rect", rects:[{i,x,y,w,h,bx?}]} (the first
 *    line box and the block's left edge): untrusted, validated and clamped to
 *    the frame box, used only to draw cosmetic numbered pins.
 *
 * FAIL CLOSED (scratch-run security review, 2026-10-08):
 *  - a trip is TERMINAL for this mount: load()/reload() refuse afterwards; the
 *    panel must re-check the version's flag with the server and create a new
 *    mount only on an explicit owner action;
 *  - the grant from mint() is not trusted: sandbox must be exactly "" or
 *    "allow-scripts" (and agree with `scripted`), the URL must be http(s),
 *    /v/<43-char token>/ and NOT the dashboard's own origin. A grant that
 *    fails is refused LOCALLY ("bad-grant" via opts.onRefuse; D28): nothing
 *    is framed, it is NOT a trip (no flag, no report, the mount stays usable)
 *    because a malformed grant is our own route/policy skew, not content
 *    escaping. Its minted token is handed to opts.revoke so it never outlives
 *    the refusal;
 *  - a fragment jump (showBlock) mounts a FRESH frame (new token, first load)
 *    instead of changing src, so no "expected load" flag exists that a later
 *    real navigation could hide behind;
 *  - from a scripted frame: a wrong nonce, an oversized crow-artifact message
 *    or a flood trips the wire (they are never just dropped); proposals before
 *    the hello are ignored.
 *
 * D24 (spec v1.6) — "couldn't load — retry" instead of a flag, decided on
 * SERVER evidence only (opts.loadEvidence → the owner's load-evidence route):
 * when a scripted frame says no hello in time, the frame is torn down FIRST
 * (synchronously, exactly like a trip), then the viewer asks whether the
 * origin served this token's document and its parser-blocking helper. While
 * the answer is pending the mount refuses load/reload/showBlock; the answer
 * is bound to the load generation. "flag" trips as before; "retry", an
 * unknown token, an error or an unreachable route → opts.onRetry (no flag, no
 * report). Content cannot steer this: browsers fire `load` for a failed
 * navigation too, so nothing the frame does or withholds is evidence here.
 * A scripted frame that fires no `load` at all within LOAD_MS (a connection
 * that died mid-response can hang the frame forever) takes the same path —
 * with D24 only; the helper's hello normally arrives long before `load`.
 * Without opts.loadEvidence, a missing hello trips as before D24.
 * Every load after the first passes the previous grant's tokenId as
 * `replaces`, so the server revokes the token the gone frame held.
 */
(function () {
  "use strict";
  var MAX_MSG = 8192, MAX_ANCHOR = 4096, RATE_N = 20, RATE_MS = 1000, HELLO_MS = 6000, LOAD_MS = 20000;
  var MAX_LINK = 2048, LINK_GAP_MS = 1500;
  var URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/v\/[A-Za-z0-9_-]{43}\/$/;

  function validAnchor(a) {
    if (!a || typeof a !== "object") return null;
    var s; try { s = JSON.stringify(a); } catch (e) { return null; }
    if (s.length > MAX_ANCHOR) return null;
    var str = function (v, n) { return typeof v === "string" && v.length <= n; };
    if (a.kind === "element" && str(a.selector, 1024) && str(a.text, 400)) return { kind: "element", selector: a.selector, text: a.text };
    if (a.kind === "text" && str(a.quote, 1000) && a.quote.trim() && str(a.prefix || "", 200) && str(a.suffix || "", 200)) {
      var t = { kind: "text", quote: a.quote, prefix: a.prefix || "", suffix: a.suffix || "" };
      // D28: the enclosing renderer block, if the frame named a well-formed one.
      if (typeof a.block === "string" && /^b\d{1,6}$/.test(a.block)) t.block = a.block;
      return t;
    }
    if (a.kind === "region" && typeof a.x === "number" && typeof a.y === "number" && a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1) return { kind: "region", x: a.x, y: a.y };
    if (a.kind === "block" && str(a.id, 64) && /^b\d{1,6}$/.test(a.id) && str(a.text || "", 400)) {
      var b = { kind: "block", id: a.id, text: a.text || "", quote: str(a.quote || "", 1000) ? (a.quote || "") : "" };
      // S1: the SERVER's record of where the quote sits in the block's plain.
      if (validSpan(a.span)) b.span = { start: a.span.start, end: a.span.end, nth: a.span.nth };
      return b;
    }
    return null;
  }
  function validSpan(sp) {
    var int = function (v, max) { return typeof v === "number" && v >= 0 && v <= max && v === Math.floor(v); };
    return !!sp && typeof sp === "object" && int(sp.start, 1e6) && int(sp.end, 1e6) && sp.end > sp.start && int(sp.nth, 9999);
  }

  /** Pins posted INTO the frame: owner element/text anchors only (see header).
   *  S1 (plan Rev 3 M1): a document block anchor crosses as its id, plus —
   *  only when the server recorded a span AND the MOUNTED version's anchor
   *  map has that block's rendered `plain` covering it — the words
   *  plain.slice(start, end) and which occurrence (nth). So what crosses is
   *  always a literal substring of the trusted, server-rendered document text,
   *  never the stored quote (which may be text the owner typed). */
  function pinOut(p, anchorMap) {
    if (!p || typeof p !== "object" || !(p.i >= 1 && p.i <= 999 && p.i === Math.floor(p.i))) return null;
    var a = validAnchor(p.anchor);
    if (!a) return null;
    if (a.kind === "element") return { i: p.i, anchor: { kind: "element", selector: a.selector } };
    if (a.kind === "text") return { i: p.i, anchor: { kind: "text", quote: a.quote, prefix: a.prefix, suffix: a.suffix } };
    // D28: document block anchors get pins — the block ID only. A block
    // anchor's quote may be text the owner TYPED (the section list's "exact
    // words"), and owner-typed text never crosses into the frame.
    if (a.kind === "block") {
      var blk = null;
      if (a.span && anchorMap && anchorMap.kind === "blocks" && Array.isArray(anchorMap.blocks)) {
        for (var k = 0; k < anchorMap.blocks.length; k++) if (anchorMap.blocks[k] && anchorMap.blocks[k].id === a.id) { blk = anchorMap.blocks[k]; break; }
      }
      if (blk && typeof blk.plain === "string" && a.span.end <= blk.plain.length) {
        var words = blk.plain.slice(a.span.start, a.span.end);
        if (words.trim()) return { i: p.i, anchor: { kind: "block", id: a.id, quote: words, nth: a.span.nth } };
      }
      return { i: p.i, anchor: { kind: "block", id: a.id } };
    }
    return null;
  }

  /** Rects coming OUT of the frame: shape-checked and clamped to the frame box. */
  function validRects(list, w, h) {
    if (!Array.isArray(list) || list.length > 100) return null;
    var out = [], fin = function (v) { return typeof v === "number" && isFinite(v); };
    for (var k = 0; k < list.length; k++) {
      var r = list[k];
      if (!r || typeof r !== "object" || !(r.i >= 1 && r.i <= 999 && r.i === Math.floor(r.i))) return null;
      if (!fin(r.x) || !fin(r.y) || !fin(r.w) || !fin(r.h)) return null;
      if (r.bx !== undefined && !fin(r.bx)) return null;
      var x = Math.max(0, Math.min(w, r.x)), y = Math.max(0, Math.min(h, r.y));
      // Off-screen anchors (scrolled away) are dropped, not pinned to an edge.
      if (r.x + Math.max(0, r.w) < 0 || r.y + Math.max(0, r.h) < 0 || r.x > w || r.y > h) continue;
      var o = { i: r.i, x: x, y: y, w: Math.max(0, Math.min(w - x, r.w)), h: Math.max(0, Math.min(h - y, r.h)) };
      // S1: the anchor's block's left edge (the pin gutter), clamped like x.
      if (r.bx !== undefined) o.bx = Math.max(0, Math.min(w, r.bx));
      out.push(o);
    }
    return out;
  }

  /** The only link proposals the viewer will offer: http(s), no credentials,
   *  at most 2048 characters. The RAW string is kept (not URL.href) so the
   *  sheet shows exactly what the content proposed, and textContent renders
   *  it literally; URL parsing is what proves the protocol and the host. */
  function validLink(url) {
    if (typeof url !== "string" || url.length > MAX_LINK) return null;
    if (/[\u0000-\u001f\u007f]/.test(url)) return null;          // no controls/newlines in an href
    var u; try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;                  // never a credential-bearing URL
    if (!u.host) return null;
    return { url: url, host: u.host };                          // host: punycode form, look-alike letters visible
  }

  /** The viewer page's own strings (viewer-page.js's table, via data-strings). */
  function pageStrings() {
    try {
      var r = document.getElementById("crow-artifact-viewer");
      return JSON.parse((r && r.getAttribute("data-strings")) || "{}");
    } catch (e) { return {}; }
  }

  function closeLinkSheet(state) {
    if (!state) return;
    if (state.linkSheet && state.linkSheet.parentNode) state.linkSheet.parentNode.removeChild(state.linkSheet);
    state.linkSheet = null;
    if (state.linkKey) { document.removeEventListener("keydown", state.linkKey); state.linkKey = null; }
  }

  /** A TRUSTED sheet in the viewer page, outside the frame: host large, the
   *  full URL small and selectable, and one explicit "Open in your browser".
   *  Every value is placed with textContent / setAttribute: never innerHTML. */
  function openLinkSheet(state, link) {
    var now = Date.now();
    if (state.linkAt && now - state.linkAt < LINK_GAP_MS) return;   // one sheet per 1.5 s; extras are dropped
    state.linkAt = now;
    closeLinkSheet(state);
    var T = pageStrings();
    var titleText = T.open_link || "Open this link?";
    var goText = T.open_link_go || "Open in your browser";
    var cancelText = T.cancel || "Cancel";
    var parent = document.getElementById("crow-artifact-viewer") || document.body || document.documentElement;
    if (!parent) return;
    var sheet = document.createElement("div");
    sheet.className = "cv-linksheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", titleText);
    var card = document.createElement("div");
    card.className = "cv-linksheet-card";
    var title = document.createElement("h2");
    title.className = "cv-linksheet-title";
    title.textContent = titleText;
    var host = document.createElement("p");
    host.className = "cv-linksheet-host";
    host.textContent = link.host;
    var full = document.createElement("p");
    full.className = "cv-linksheet-url";
    full.textContent = link.url;
    var actions = document.createElement("div");
    actions.className = "cv-linksheet-actions";
    var go = document.createElement("a");
    go.className = "cv-linksheet-go";
    go.setAttribute("href", link.url);
    go.setAttribute("target", "_blank");
    go.setAttribute("rel", "noopener noreferrer");
    go.textContent = goText;
    go.addEventListener("click", function () { closeLinkSheet(state); });
    var cancel = document.createElement("button");
    cancel.setAttribute("type", "button");
    cancel.className = "cv-linksheet-cancel";
    cancel.textContent = cancelText;
    cancel.addEventListener("click", function () { closeLinkSheet(state); });
    actions.appendChild(go);
    actions.appendChild(cancel);
    card.appendChild(title);
    card.appendChild(host);
    card.appendChild(full);
    card.appendChild(actions);
    sheet.appendChild(card);
    parent.appendChild(sheet);
    state.linkSheet = sheet;
    state.linkKey = function (e) { if (e.key === "Escape") closeLinkSheet(state); };
    document.addEventListener("keydown", state.linkKey);
    try { if (cancel.focus) cancel.focus(); } catch (e) {}
  }

  /** The only grants the viewer will frame. */
  function validGrant(g) {
    if (!g || typeof g !== "object") return false;
    if (g.sandbox !== "" && g.sandbox !== "allow-scripts") return false;
    if ((g.sandbox === "allow-scripts") !== (g.scripted === true)) return false;
    if (typeof g.url !== "string" || !URL_RE.test(g.url)) return false;
    var u; try { u = new URL(g.url); } catch (e) { return false; }
    if (u.origin === window.location.origin) return false;               // never same-origin with the dashboard
    if (g.scripted && (typeof g.nonce !== "string" || g.nonce.length < 16)) return false;
    return true;
  }

  /**
   * The CSP canary (plan re-check 2): the viewer page's own CSP must narrow
   * frame-src to the artifact origin. A hidden frame to an .invalid https host
   * must raise a securitypolicyviolation; if it does not within the window,
   * the narrowed CSP is not in force (e.g. a Turbo body swap kept another
   * page's policy) and NO content is shown. Fail closed. Cached per document.
   */
  var cspProof = null;
  function proveCsp(timeoutMs) {
    if (cspProof) return cspProof;
    cspProof = new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (done) return; done = true; document.removeEventListener("securitypolicyviolation", onV); if (f.parentNode) f.parentNode.removeChild(f); resolve(v); };
      var onV = function (e) { if (e && e.blockedURI && e.blockedURI.indexOf("csp-canary.invalid") >= 0 && /frame-src|child-src|default-src/.test(e.effectiveDirective || e.violatedDirective || "")) finish(true); };
      document.addEventListener("securitypolicyviolation", onV);
      var f = document.createElement("iframe");
      f.setAttribute("sandbox", ""); f.setAttribute("aria-hidden", "true"); f.style.display = "none";
      f.src = "https://csp-canary.invalid/";
      (document.body || document.documentElement).appendChild(f);
      setTimeout(function () { finish(false); }, timeoutMs || 1500);
    });
    return cspProof;
  }

  /**
   * opts: { container, mint: (fragment) => Promise<grant>, onProposal(anchor), onTrip(reason), onReady(), onRefuse(reason) }
   * grant: { url, nonce, sandbox, scripted, type }
   */
  function mount(opts) {
    var state = { iframe: null, loads: 0, hello: false, tripped: false, pending: false, grant: null, helloTimer: null, stamps: [], commentMode: false, pins: [], gen: 0, linkSheet: null, linkKey: null, linkAt: 0 };
    var helloMs = typeof opts.helloMs === "number" && opts.helloMs > 0 ? opts.helloMs : HELLO_MS;
    var loadMs = typeof opts.loadMs === "number" && opts.loadMs > 0 ? opts.loadMs : LOAD_MS;

    /** D24: no hello in time. Tear down first, then ask the server. */
    function noHello(g, gen) {
      if (!opts.loadEvidence) { trip("no-hello"); return; }
      state.pending = true;
      clearTimeout(state.helloTimer);
      if (state.iframe) { state.iframe.remove(); state.iframe = null; }
      var settle = function (r) {
        if (gen !== state.gen || state.tripped || !state.pending) return;      // stale, destroyed or tripped meanwhile
        state.pending = false;
        if (r && r.decision === "flag") { trip("no-hello"); return; }
        try { opts.onRetry && opts.onRetry((r && r.reason) || "unreachable"); } catch (x) {}
      };
      var p;
      try { p = Promise.resolve(opts.loadEvidence(g.tokenId || "")); } catch (x) { p = Promise.reject(x); }
      p.then(settle, function () { settle(null); });
    }

    function trip(reason) {
      if (state.tripped) return;
      state.tripped = true;
      state.pending = false;
      clearTimeout(state.helloTimer);
      if (state.iframe) { state.iframe.remove(); state.iframe = null; }
      try { opts.onTrip && opts.onTrip(reason); } catch (e) {}
    }

    function onMessage(e) {
      if (state.tripped || !state.iframe || e.source !== state.iframe.contentWindow) return;   // only our live frame
      var g = state.grant, d = e.data, now = Date.now();
      if (e.origin !== "null") { trip("not-opaque"); return; }                                 // a sandboxed frame is always opaque
      state.stamps = state.stamps.filter(function (t) { return now - t < RATE_MS; });
      state.stamps.push(now);
      if (state.stamps.length > RATE_N) { trip("flood"); return; }
      if (!d || typeof d !== "object" || d.t !== "crow-artifact") return;                       // not ours: ignored (but counted)
      if (!g.scripted) { trip("script-free-frame-spoke"); return; }                             // a sealed frame cannot speak
      var size; try { size = JSON.stringify(d).length; } catch (x) { trip("malformed"); return; }
      if (size > MAX_MSG) { trip("oversized"); return; }
      if (d.nonce !== g.nonce) { trip("bad-nonce"); return; }
      if (d.kind === "hello") {
        if (state.hello) return;                                                                 // one per load; repeats ignored
        state.hello = true; clearTimeout(state.helloTimer);
        try { opts.onReady && opts.onReady(); } catch (x) {}
        if (state.commentMode) postMode();
        postPins();
        return;
      }
      if (d.kind === "anchor-rect" && state.hello) {
        var box = state.iframe.getBoundingClientRect();
        var rects = validRects(d.rects, box.width, box.height);
        if (rects) try { opts.onRects && opts.onRects(rects); } catch (x) {}
        return;
      }
      // S6 (plan Rev 3 H2): the helper says a selection went away (posted
      // only on a real selected→collapsed transition, at most 4/s). Effect
      // only: the trusted "Comment on …" button hides. Ignored before hello.
      if (d.kind === "selection-cleared") {
        if (state.hello) try { opts.onSelectionCleared && opts.onSelectionCleared(); } catch (x) {}
        return;
      }
      if (d.kind === "anchor" && state.hello) {
        var a = validAnchor(d.anchor);
        if (a) try { opts.onProposal && opts.onProposal(a); } catch (x) {}
        return;
      }
      // Links (2026-10-30): the helper intercepted a click; this is only a
      // proposal. Validated like every other kind (live frame, opaque origin,
      // nonce, hello, size, rate), then shown in trusted UI. Never navigated
      // automatically. A malformed/unsafe proposal is dropped silently.
      if (d.kind === "open-link") {
        if (!state.hello) return;
        var l = validLink(d.url);
        if (!l) return;
        try { if (opts.onLink) opts.onLink(l); else openLinkSheet(state, l); } catch (x) {}
      }
    }

    function postPins() {
      if (state.iframe && state.grant && state.grant.scripted && state.hello && !state.tripped) {
        state.iframe.contentWindow.postMessage({ t: "crow-viewer", kind: "pins", pins: state.pins }, "*");
      }
    }

    function postMode() {
      if (state.iframe && state.grant && state.grant.scripted && state.hello && !state.tripped) {
        state.iframe.contentWindow.postMessage({ t: "crow-viewer", kind: "comment-mode", on: state.commentMode, selectOnly: !!state.selectOnly }, "*");
      }
    }

    function load(fragment) {
      if (state.tripped) return Promise.reject(new Error("tripped"));
      if (state.pending) return Promise.reject(new Error("pending"));
      var gen = ++state.gen;
      var replaces = state.grant && typeof state.grant.tokenId === "string" ? state.grant.tokenId : null;
      return proveCsp(opts.cspProofMs).then(function (inForce) {
        if (!inForce) { try { opts.onRefuse && opts.onRefuse("csp-not-in-force"); } catch (x) {} throw new Error("csp-not-in-force"); }
        return opts.mint(fragment || null, { replaces: replaces });
      }).then(function (g) {
        if (state.tripped || gen !== state.gen) throw new Error("stale");
        // D28/review H2: a malformed grant is OUR bug (route/policy skew), not
        // an escape attempt — refuse locally, never flag the version.
        if (!validGrant(g)) {
          // The server minted a live token for this grant: hand it back.
          if (g && typeof g.tokenId === "string") { try { opts.revoke && Promise.resolve(opts.revoke(g.tokenId)).catch(function () {}); } catch (x) {} }
          try { opts.onRefuse && opts.onRefuse("bad-grant"); } catch (x) {}
          throw new Error("bad-grant");
        }
        if (state.iframe) { state.iframe.remove(); state.iframe = null; }
        clearTimeout(state.helloTimer);
        state.grant = g; state.loads = 0; state.hello = false; state.stamps = [];
        var f = document.createElement("iframe");
        f.setAttribute("sandbox", g.sandbox);                                 // "" or "allow-scripts", nothing else
        f.setAttribute("referrerpolicy", "no-referrer");
        f.setAttribute("allow", "");
        f.setAttribute("title", "artifact content");
        f.className = "crow-artifact-frame";
        f.addEventListener("load", function () {
          if (f !== state.iframe || state.tripped) return;                     // a replaced frame's late event
          state.loads++;
          if (state.loads > 1) { trip("second-load"); return; }
          clearTimeout(state.helloTimer);                                      // the load timeout, if armed
          if (g.scripted) {
            state.helloTimer = setTimeout(function () { if (!state.hello && f === state.iframe && !state.tripped) noHello(g, gen); }, helloMs);
          } else {
            try { opts.onReady && opts.onReady(); } catch (x) {}
          }
        });
        f.src = g.url + (fragment && /^b\d{1,6}$/.test(fragment) ? "#" + fragment : "");
        state.iframe = f;
        opts.container.appendChild(f);
        if (g.scripted && opts.loadEvidence) {
          state.helloTimer = setTimeout(function () { if (!state.hello && state.loads === 0 && f === state.iframe && !state.tripped) noHello(g, gen); }, loadMs);
        }
        return g;
      });
    }

    window.addEventListener("message", onMessage);
    return {
      load: function () { return load(null); },
      reload: function () { return load(null); },          // a refresh is a new token + a new frame load
      setCommentMode: function (on, o) { state.commentMode = !!on; state.selectOnly = !!(o && o.selectOnly); postMode(); },
      /** Numbered owner anchors for the cosmetic pins (scripted types). */
      setPins: function (list, anchorMap) { state.pins = (Array.isArray(list) ? list : []).slice(0, 100).map(function (p) { return pinOut(p, anchorMap); }).filter(Boolean); postPins(); },
      /** Script-free types: show a block by mounting a fresh frame at its fragment. */
      showBlock: function (id) {
        if (state.pending) return Promise.reject(new Error("pending"));
        // D28: documents speak now; a block jump is still a fresh document load.
        if (!state.grant || state.grant.type !== "document" || !/^b\d{1,6}$/.test(id)) return Promise.resolve(null);
        return load(id);
      },
      state: function () { return { loads: state.loads, hello: state.hello, tripped: state.tripped, pending: state.pending, framed: !!state.iframe }; },
      destroy: function () { window.removeEventListener("message", onMessage); clearTimeout(state.helloTimer); closeLinkSheet(state); if (state.iframe) state.iframe.remove(); state.iframe = null; state.tripped = true; },
    };
  }

  /** Full screen (2026-10-30): a <body> class, not the Fullscreen API — the
   *  Android app's WebView has no meaningful Fullscreen API. The API is only
   *  an optional extra on a real button press, and its failure is ignored.
   *  The server renders both buttons; this moves them into the page's toolbar
   *  (or the root when there is no toolbar) and wires Escape and "#full". */
  function initFullScreen() {
    if (!document || typeof document.getElementById !== "function") return;
    var root = document.getElementById("crow-artifact-viewer");
    var open = document.getElementById("cv-full-screen");
    var exit = document.getElementById("cv-exit-full-screen");
    if (open) {
      var tools = typeof document.querySelector === "function" ? document.querySelector(".cv-headtools") : null;
      if (tools && tools.appendChild) tools.appendChild(open);
      else if (root && root.appendChild) root.appendChild(open);
    }
    if (exit) {
      if (root && root.appendChild) root.appendChild(exit);
      exit.removeAttribute("hidden");
    }
    function isOn() { return !!(document.body && document.body.classList && document.body.classList.contains("cv-fullscreen")); }
    function setFull(on, request) {
      if (!document.body || !document.body.classList) return;
      if (on) document.body.classList.add("cv-fullscreen"); else document.body.classList.remove("cv-fullscreen");
      if (on && request) {
        try {
          if (document.documentElement && typeof document.documentElement.requestFullscreen === "function") {
            var p = document.documentElement.requestFullscreen();
            if (p && p.catch) p.catch(function () {});
          }
        } catch (e) {}
      } else if (!on) {
        try {
          if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
            var x = document.exitFullscreen();
            if (x && x.catch) x.catch(function () {});
          }
        } catch (e) {}
      }
    }
    if (open) open.addEventListener("click", function () { setFull(true, true); });
    if (exit) exit.addEventListener("click", function () { setFull(false, false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOn()) setFull(false, false);
    });
    // The optional Fullscreen API may consume Escape itself: when the browser
    // leaves fullscreen, drop the class too (Android has no API and never
    // fires this; the keydown above is the mechanism there).
    document.addEventListener("fullscreenchange", function () {
      if (!document.fullscreenElement && isOn()) setFull(false, false);
    });
    if (typeof location !== "undefined" && location.hash === "#full") setFull(true, false);
  }
  if (document && typeof document.getElementById === "function") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initFullScreen);
    else initFullScreen();
  }

  window.CrowArtifactViewer = { mount: mount, validAnchor: validAnchor, validGrant: validGrant, validRects: validRects, pinOut: pinOut, validLink: validLink };
})();
