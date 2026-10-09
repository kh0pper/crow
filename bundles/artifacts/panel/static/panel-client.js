/*
 * Crow Artifacts — panel client (dashboard origin, trusted). Classic script.
 * Every piece of user-, bot- or contact-authored text is placed with
 * textContent. Nothing from the artifact frame acts without a click here.
 */
(function () {
  "use strict";
  var root = document.getElementById("crow-artifacts");
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = "1";
  var T = JSON.parse(root.dataset.strings || "{}");
  var fmt = function (s, o) { return String(s || "").replace(/\{(\w+)\}/g, function (_, k) { return o && o[k] != null ? String(o[k]) : ""; }); };
  var csrf = function () { var m = /(?:^|;\s*)crow_csrf=([^;]+)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : ""; };
  function api(method, path, body) {
    return fetch(path, { method: method, credentials: "same-origin", headers: { "content-type": "application/json", "x-crow-csrf": csrf() }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.message || j.error || r.status); e.code = j.error; e.body = j; throw e; } return j; }); });
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") n.textContent = attrs[k]; else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]); else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function banner(text, kind) { var b = el("div", { class: "ca-banner ca-" + (kind || "info"), role: "status", text: text }); root.prepend(b); return b; }
  // O11: on the loopback fallback the origin is only reachable from this
  // machine — a dashboard opened from another device cannot show artifacts,
  // and the panel must say exactly that (not just "weaker isolation").
  var LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  function isolationBanner(iso) {
    if (iso === "shared-host") banner(LOCAL_HOSTS.test(location.host) ? T.weaker : T.fallback_remote, "warn");
    else if (iso === "unavailable" || !iso) banner(T.unavailable, "warn");
  }

  function showList() {
    api("GET", "/api/artifacts").then(function (j) {
      root.textContent = "";
      root.appendChild(el("h2", { text: T.title }));
      isolationBanner(j.origin && j.origin.isolation);
      if (!j.artifacts.length) { root.appendChild(el("p", { class: "ca-empty", text: T.empty })); return; }
      var ul = el("ul", { class: "ca-list" });
      j.artifacts.forEach(function (a) {
        ul.appendChild(el("li", {}, [el("a", { href: "/dashboard/artifacts?id=" + encodeURIComponent(a.id), text: a.title }), el("span", { class: "ca-type", text: " · " + a.type + " · v" + a.current_version })]));
      });
      root.appendChild(ul);
    });
  }

  function showArtifact(id) {
    api("GET", "/api/artifacts/" + encodeURIComponent(id)).then(function (j) {
      var art = j.artifact, n = art.current_version;
      var v = j.versions.find(function (x) { return x.n === n; }) || j.versions[0];
      root.textContent = "";
      var head = el("div", { class: "ca-head" }, [el("h2", { text: art.title })]);
      var label = el("div", { class: "ca-trust", text: fmt(T.made_by, { bot: art.created_by_bot || "you" }) });
      var frameBox = el("div", { class: "ca-frame", "data-type": art.type });
      var overlay = el("div", { class: "ca-overlay", hidden: "" });
      frameBox.appendChild(overlay);
      var rail = el("aside", { class: "ca-rail" });
      var toggle = el("button", { type: "button", class: "ca-toggle", "aria-pressed": "false", text: T.comment_mode });
      var reload = el("button", { type: "button", text: T.reload, title: T.reload_note });
      var send = el("button", { type: "button", class: "ca-send", text: T.send_feedback });
      head.appendChild(el("div", { class: "ca-tools" }, [toggle, reload, send]));
      root.appendChild(head); root.appendChild(label);
      root.appendChild(el("div", { class: "ca-body" }, [frameBox, rail]));
      root.appendChild(el("p", { class: "ca-note", text: T.never_password }));
      j.versions.filter(function (x) { return x.state === "proposed"; }).forEach(function (p) {
        var b = banner(fmt(T.proposed, { n: p.n }) + (p.change_note ? " — " + p.change_note : ""), "info");
        b.appendChild(el("button", { type: "button", text: T.accept, onclick: function () { api("POST", "/api/artifacts/" + id + "/versions/" + p.n + "/decide", { accept: true }).then(function () { showArtifact(id); }); } }));
        b.appendChild(el("button", { type: "button", text: T.drop, onclick: function () { api("POST", "/api/artifacts/" + id + "/versions/" + p.n + "/decide", { accept: false }).then(function () { showArtifact(id); }); } }));
      });

      var pending = null;   // a proposal from the frame, waiting for the owner's click
      function compose(anchor) {
        pending = anchor;
        var box = rail.querySelector(".ca-compose") || rail.insertBefore(el("div", { class: "ca-compose" }), rail.firstChild);
        box.textContent = "";
        var ta = el("textarea", { maxlength: "4000", rows: "3", "aria-label": T.add_comment });
        box.appendChild(el("div", { class: "ca-anchor", text: anchor.text || anchor.quote || anchor.selector || anchor.id || "" }));
        if (anchor.kind === "block") box.appendChild(el("input", { type: "text", class: "ca-quote", placeholder: T.quote, maxlength: "1000" }));
        box.appendChild(ta);
        box.appendChild(el("button", { type: "button", text: T.add_comment, onclick: function () {
          var q = box.querySelector(".ca-quote");
          var a = Object.assign({}, pending, q && q.value ? { quote: q.value } : {});
          api("POST", "/api/artifacts/" + id + "/threads", { versionN: n, anchor: a, text: ta.value }).then(function () { showArtifact(id); }, function (e) { banner(e.message, "warn"); });
        } }));
        box.appendChild(el("button", { type: "button", text: T.cancel, onclick: function () { pending = null; box.remove(); } }));
        ta.focus();
      }

      var viewer = window.CrowArtifactViewer.mount({
        container: frameBox,
        mint: function (fragment) { return api("POST", "/api/artifacts/" + id + "/versions/" + v.n + "/view", { fragment: fragment || null }); },
        onProposal: function (a) { compose(a); },
        onTrip: function (reason) {
          banner(T.tripped, "danger");
          api("POST", "/api/artifacts/" + id + "/versions/" + v.n + "/tripwire", { reason: reason }).catch(function () {});
        },
        onReady: function () {},
        // The narrowed CSP is not in force (a Turbo body swap kept another
        // page's policy): reload this page for real; never show content.
        onRefuse: function () {
          banner(T.csp_missing, "danger");
          if (!/[?&]reloaded=1/.test(location.search)) location.replace(location.pathname + location.search + (location.search ? "&" : "?") + "reloaded=1");
        },
      });
      viewer.load().then(function (g) {
        if (g) isolationBanner(g.isolation);
        if (g && g.scriptsOff) {   // D20: the owner's press is the approve
          var b = banner(T.scripts_off, "warn");
          b.appendChild(el("button", { type: "button", text: T.run_scripts, onclick: function () {
            api("POST", "/api/artifacts/" + id + "/versions/" + v.n + "/approve", {}).then(function () { showArtifact(id); });
          } }));
        }
      }, function (e) { banner(e.code === "flagged" ? T.tripped : e.message, "warn"); });

      toggle.addEventListener("click", function () {
        var on = toggle.getAttribute("aria-pressed") !== "true";
        toggle.setAttribute("aria-pressed", on ? "true" : "false");
        viewer.setCommentMode(on);
        // Script-free types: region anchors from a transparent overlay (diagram, image).
        if (art.type === "diagram") { if (on) overlay.removeAttribute("hidden"); else overlay.setAttribute("hidden", ""); }
      });
      overlay.addEventListener("click", function (e) {
        var r = overlay.getBoundingClientRect();
        compose({ kind: "region", x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) });
      });
      reload.addEventListener("click", function () { viewer.reload(); });

      // Documents: pick a section (anchor map), jump to it, comment on it.
      if (v.anchor_map && v.anchor_map.kind === "blocks") {
        var list = el("ol", { class: "ca-blocks", "aria-label": T.pick_block });
        v.anchor_map.blocks.forEach(function (b) {
          list.appendChild(el("li", {}, [el("button", { type: "button", text: b.text.slice(0, 80) || b.id, onclick: function () { viewer.showBlock(b.id); compose({ kind: "block", id: b.id, text: b.text }); } })]));
        });
        rail.appendChild(el("details", {}, [el("summary", { text: T.blocks }), list]));
      }

      j.threads.forEach(function (t) {
        var box = el("section", { class: "ca-thread ca-" + t.status });
        box.appendChild(el("div", { class: "ca-anchor", text: (t.anchor.text || t.anchor.quote || t.anchor.selector || t.anchor.kind) + (t.status === "resolved" ? " · " + T.resolved : t.status === "anchor-moved" ? " · " + T.moved : "") }));
        t.comments.forEach(function (c) { box.appendChild(el("p", { class: "ca-c ca-" + c.author_kind }, [el("b", { text: (c.author_kind === "owner" ? "you" : c.author_id || c.author_kind) + ": " }), el("span", { text: c.text })])); });
        if (t.author_kind === "owner" && t.status !== "resolved") box.appendChild(el("button", { type: "button", text: T.ask_now, onclick: function () { startRound([t.id], "ask"); } }));
        rail.appendChild(box);
      });

      function delivered(r) {
        var d = r.delivery || {};
        if (d.needsChoice) {
          var b = banner(T.no_session, "info");
          var go = function (choice) { b.remove(); api("POST", "/api/artifacts/" + id + "/rounds/" + r.round.id + "/deliver", { choice: choice }).then(delivered, function (e) { banner(e.message, "warn"); }); };
          b.appendChild(el("button", { type: "button", text: T.new_session, onclick: function () { go("new-session"); } }));
          if (d.offerBoard) b.appendChild(el("button", { type: "button", text: T.board_card, onclick: function () { go("board-card"); } }));
        } else if (d.status === "queued") banner(T.queued, "info");
        else banner(fmt(T.revising, { bot: art.created_by_bot, n: r.round.id }), "info");
      }
      function startRound(include, kind) {
        api("POST", "/api/artifacts/" + id + "/rounds", { include: include, kind: kind || "round" }).then(delivered,
          function (e) { banner(e.code === "round_running" ? T.round_running : e.message, "warn"); });
      }

      send.addEventListener("click", function () {
        api("GET", "/api/artifacts/" + id + "/round-preview").then(function (pv) {
          if (pv.activeRound) { banner(T.round_running, "warn"); return; }
          var dlg = el("dialog", { class: "ca-preview" });
          dlg.appendChild(el("h3", { text: T.preview_title }));
          pv.threads.forEach(function (t) {
            var cb = el("input", { type: "checkbox", value: String(t.id) });
            cb.checked = !!t.includedByDefault;
            var row = el("label", { class: t.untrusted ? "ca-untrusted" : "" }, [cb, el("span", { text: " " + T.include })]);
            var body = el("div", {}, t.comments.map(function (c) { return el("p", { text: (c.author_kind === "owner" ? "you" : c.author_id || c.author_kind) + ": " + c.text }); }));
            if (t.untrusted) body.prepend(el("em", { text: T.contact_thread }));
            dlg.appendChild(el("div", { class: "ca-pv" }, [row, body]));
          });
          dlg.appendChild(el("button", { type: "button", text: T.send_feedback, onclick: function () {
            var ids = Array.prototype.map.call(dlg.querySelectorAll("input:checked"), function (x) { return Number(x.value); });
            dlg.close(); dlg.remove(); if (ids.length) startRound(ids, "round");
          } }));
          dlg.appendChild(el("button", { type: "button", text: T.cancel, onclick: function () { dlg.close(); dlg.remove(); } }));
          root.appendChild(dlg); dlg.showModal();
        });
      });
    }, function (e) { root.textContent = ""; banner(e.message, "warn"); });
  }

  if (root.dataset.artifact) showArtifact(root.dataset.artifact); else showList();
})();
