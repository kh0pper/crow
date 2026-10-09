/*
 * Crow Artifacts — panel client (dashboard origin, trusted). Classic script.
 * Every piece of user-, bot- or contact-authored text is placed with
 * textContent. Nothing from the artifact frame acts without a click here.
 *
 * Step 2 is VIEW-ONLY: the list, the sealed frame (via viewer.js), the
 * document's section rail (jumping is viewing), proposed-version accept/drop,
 * the tripwire report and the owner's D20 "Run this version's scripts"
 * approval. The comment rail, round preview and delivery banners arrive with
 * step 3.
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
      var rail = el("aside", { class: "ca-rail" });
      var reload = el("button", { type: "button", text: T.reload, title: T.reload_note });
      head.appendChild(el("div", { class: "ca-tools" }, [reload]));
      root.appendChild(head); root.appendChild(label);
      root.appendChild(el("div", { class: "ca-body" }, [frameBox, rail]));
      root.appendChild(el("p", { class: "ca-note", text: T.never_password }));
      j.versions.filter(function (x) { return x.state === "proposed"; }).forEach(function (p) {
        var b = banner(fmt(T.proposed, { n: p.n }) + (p.change_note ? " — " + p.change_note : ""), "info");
        b.appendChild(el("button", { type: "button", text: T.accept, onclick: function () { api("POST", "/api/artifacts/" + id + "/versions/" + p.n + "/decide", { accept: true }).then(function () { showArtifact(id); }); } }));
        b.appendChild(el("button", { type: "button", text: T.drop, onclick: function () { api("POST", "/api/artifacts/" + id + "/versions/" + p.n + "/decide", { accept: false }).then(function () { showArtifact(id); }); } }));
      });

      var viewer = window.CrowArtifactViewer.mount({
        container: frameBox,
        mint: function (fragment) { return api("POST", "/api/artifacts/" + id + "/versions/" + v.n + "/view", { fragment: fragment || null }); },
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

      reload.addEventListener("click", function () { viewer.reload(); });

      // Documents: the section list (anchor map). Jumping to a section is
      // viewing — it mounts a fresh frame at the block (step 3 adds the
      // compose box beside it).
      if (v.anchor_map && v.anchor_map.kind === "blocks") {
        var list = el("ol", { class: "ca-blocks", "aria-label": T.pick_block });
        v.anchor_map.blocks.forEach(function (b) {
          list.appendChild(el("li", {}, [el("button", { type: "button", text: b.text.slice(0, 80) || b.id, onclick: function () { viewer.showBlock(b.id); } })]));
        });
        rail.appendChild(el("details", { open: "" }, [el("summary", { text: T.blocks }), list]));
      }
    }, function (e) { root.textContent = ""; banner(e.message, "warn"); });
  }

  if (root.dataset.artifact) showArtifact(root.dataset.artifact); else showList();
})();
