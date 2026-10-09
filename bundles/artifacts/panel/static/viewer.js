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
 *    rail;
 *  - the parent never posts anything sensitive in: only {kind:"comment-mode"}.
 *
 * FAIL CLOSED (scratch-run security review, 2026-10-08):
 *  - a trip is TERMINAL for this mount: load()/reload() refuse afterwards; the
 *    panel must re-check the version's flag with the server and create a new
 *    mount only on an explicit owner action;
 *  - the grant from mint() is not trusted: sandbox must be exactly "" or
 *    "allow-scripts" (and agree with `scripted`), the URL must be http(s),
 *    /v/<43-char token>/ and NOT the dashboard's own origin — else bad-grant;
 *  - a fragment jump (showBlock) mounts a FRESH frame (new token, first load)
 *    instead of changing src, so no "expected load" flag exists that a later
 *    real navigation could hide behind;
 *  - from a scripted frame: a wrong nonce, an oversized crow-artifact message
 *    or a flood trips the wire (they are never just dropped); proposals before
 *    the hello are ignored.
 */
(function () {
  "use strict";
  var MAX_MSG = 8192, MAX_ANCHOR = 4096, RATE_N = 20, RATE_MS = 1000, HELLO_MS = 6000;
  var URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/v\/[A-Za-z0-9_-]{43}\/$/;

  function validAnchor(a) {
    if (!a || typeof a !== "object") return null;
    var s; try { s = JSON.stringify(a); } catch (e) { return null; }
    if (s.length > MAX_ANCHOR) return null;
    var str = function (v, n) { return typeof v === "string" && v.length <= n; };
    if (a.kind === "element" && str(a.selector, 1024) && str(a.text, 400)) return { kind: "element", selector: a.selector, text: a.text };
    if (a.kind === "text" && str(a.quote, 1000) && a.quote.trim() && str(a.prefix || "", 200) && str(a.suffix || "", 200)) return { kind: "text", quote: a.quote, prefix: a.prefix || "", suffix: a.suffix || "" };
    if (a.kind === "region" && typeof a.x === "number" && typeof a.y === "number" && a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1) return { kind: "region", x: a.x, y: a.y };
    if (a.kind === "block" && str(a.id, 64) && /^b\d{1,6}$/.test(a.id) && str(a.text || "", 400)) return { kind: "block", id: a.id, text: a.text || "", quote: str(a.quote || "", 1000) ? (a.quote || "") : "" };
    return null;
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
    var state = { iframe: null, loads: 0, hello: false, tripped: false, grant: null, helloTimer: null, stamps: [], commentMode: false, gen: 0 };

    function trip(reason) {
      if (state.tripped) return;
      state.tripped = true;
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
        return;
      }
      if (d.kind === "anchor" && state.hello) {
        var a = validAnchor(d.anchor);
        if (a) try { opts.onProposal && opts.onProposal(a); } catch (x) {}
      }
    }

    function postMode() {
      if (state.iframe && state.grant && state.grant.scripted && state.hello && !state.tripped) {
        state.iframe.contentWindow.postMessage({ t: "crow-viewer", kind: "comment-mode", on: state.commentMode }, "*");
      }
    }

    function load(fragment) {
      if (state.tripped) return Promise.reject(new Error("tripped"));
      var gen = ++state.gen;
      return proveCsp(opts.cspProofMs).then(function (inForce) {
        if (!inForce) { try { opts.onRefuse && opts.onRefuse("csp-not-in-force"); } catch (x) {} throw new Error("csp-not-in-force"); }
        return opts.mint(fragment || null);
      }).then(function (g) {
        if (state.tripped || gen !== state.gen) throw new Error("stale");
        if (!validGrant(g)) { trip("bad-grant"); throw new Error("bad-grant"); }
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
          if (g.scripted) {
            state.helloTimer = setTimeout(function () { if (!state.hello) trip("no-hello"); }, HELLO_MS);
          } else {
            try { opts.onReady && opts.onReady(); } catch (x) {}
          }
        });
        f.src = g.url + (fragment && /^b\d{1,6}$/.test(fragment) ? "#" + fragment : "");
        state.iframe = f;
        opts.container.appendChild(f);
        return g;
      });
    }

    window.addEventListener("message", onMessage);
    return {
      load: function () { return load(null); },
      reload: function () { return load(null); },          // a refresh is a new token + a new frame load
      setCommentMode: function (on) { state.commentMode = !!on; postMode(); },
      /** Script-free types: show a block by mounting a fresh frame at its fragment. */
      showBlock: function (id) {
        if (!state.grant || state.grant.scripted || !/^b\d{1,6}$/.test(id)) return Promise.resolve(null);
        return load(id);
      },
      state: function () { return { loads: state.loads, hello: state.hello, tripped: state.tripped, framed: !!state.iframe }; },
      destroy: function () { window.removeEventListener("message", onMessage); clearTimeout(state.helloTimer); if (state.iframe) state.iframe.remove(); state.iframe = null; state.tripped = true; },
    };
  }

  window.CrowArtifactViewer = { mount: mount, validAnchor: validAnchor, validGrant: validGrant };
})();
