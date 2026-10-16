/*
 * Crow Artifacts — the Library client (dashboard origin, trusted). Classic
 * script. Lists artifacts with server-derived badges, search and filters;
 * each opens the viewer page, and a detail drawer shows Versions, Linked
 * chats, Projects and Sharing (honest "coming soon" stubs) and Audit (plan
 * PR-3 Task 3.9, spec D27). Every authored string is placed with
 * textContent. No frame, no rail, no Ask-now here (D26: the owner asks in
 * the chat; the viewer page owns comments and rounds).
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
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.message || j.error || String(r.status)); e.code = j.error; throw e; } return j; }); });
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
  function banner(text, kind) { root.appendChild(el("div", { class: "ca-banner ca-" + (kind || "info"), role: "status", text: text })); }
  // O11: on the loopback fallback the origin is only reachable from this machine.
  var LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  var TYPES = { page: T.t_page, document: T.t_document, diagram: T.t_diagram };
  var base = function (id) { return "/api/artifacts/" + encodeURIComponent(id); };

  var all = [];
  var search = el("input", { type: "search", class: "ca-search", "aria-label": T.search, placeholder: T.search });
  var typeSel = el("select", { class: "ca-filter", "aria-label": T.all_types });
  var stateSel = el("select", { class: "ca-filter", "aria-label": T.all_states });
  [["", T.all_types], ["page", T.t_page], ["document", T.t_document], ["diagram", T.t_diagram]].forEach(function (o) { typeSel.appendChild(el("option", { value: o[0], text: o[1] })); });
  [["", T.all_states], ["scripts-off", T.st_scripts_off], ["contact", T.st_contact], ["linked", T.st_linked]].forEach(function (o) { stateSel.appendChild(el("option", { value: o[0], text: o[1] })); });
  var list = el("ul", { class: "ca-list" });

  function matches(a) {
    var q = search.value.trim().toLowerCase();
    if (q && String(a.title || "").toLowerCase().indexOf(q) < 0) return false;
    if (typeSel.value && a.type !== typeSel.value) return false;
    var b = a.badges || {};
    if (stateSel.value === "scripts-off" && !b.scriptsOff) return false;
    if (stateSel.value === "contact" && !(b.contactComments > 0)) return false;
    if (stateSel.value === "linked" && !(b.links > 0)) return false;
    return true;
  }

  function renderList() {
    list.textContent = "";
    var shown = all.filter(matches);
    if (!shown.length) { list.appendChild(el("li", { class: "ca-empty", text: all.length ? T.no_match : T.empty })); return; }
    shown.forEach(function (a) {
      var b = a.badges || {};
      var badges = el("span", { class: "ca-badges" }, [
        el("span", { class: "ca-badge", text: TYPES[a.type] || a.type }),
        el("span", { class: "ca-badge", text: "v" + a.current_version }),
        b.scriptsOff ? el("span", { class: "ca-badge ca-warnb", text: T.scripts_off }) : null,
        b.contactComments > 0 ? el("span", { class: "ca-badge ca-warnb", text: b.contactComments === 1 ? T.contact_1 : fmt(T.contact_n, { n: b.contactComments }) }) : null,
        b.links > 0 ? el("span", { class: "ca-badge", text: b.links === 1 ? T.links_1 : fmt(T.links_n, { n: b.links }) }) : null,
      ]);
      var drawer = el("div", { class: "ca-drawer", hidden: "" });
      var toggle = el("button", { type: "button", class: "btn btn-secondary btn-sm ca-details", "aria-expanded": "false", text: T.details });
      toggle.addEventListener("click", function () {
        var open = drawer.hasAttribute("hidden");
        if (open) { drawer.removeAttribute("hidden"); fillDrawer(drawer, a, "versions"); } else drawer.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.textContent = open ? T.close : T.details;
      });
      list.appendChild(el("li", { class: "ca-item" }, [
        el("div", { class: "ca-row" }, [
          el("a", { class: "ca-open", href: "/dashboard/artifacts/view/" + encodeURIComponent(a.id), "data-turbo": "false", text: a.title }),
          toggle,
        ]),
        el("div", { class: "ca-meta" }, [badges, a.created_by_bot ? el("span", { class: "ca-by", text: fmt(T.made_by, { bot: a.created_by_bot }) }) : null]),
        drawer,
      ]));
    });
  }

  // ── the detail drawer ───────────────────────────────────────────────────
  var TABS = [["versions", T.tab_versions], ["links", T.tab_links], ["projects", T.tab_projects], ["sharing", T.tab_sharing], ["audit", T.tab_audit]];
  function fillDrawer(drawer, a, tab) {
    drawer.textContent = "";
    var bar = el("div", { class: "ca-tabs", role: "tablist" });
    var panel = el("div", { class: "ca-tabpanel", role: "tabpanel" });
    TABS.forEach(function (t) {
      bar.appendChild(el("button", { type: "button", role: "tab", class: "btn btn-secondary btn-sm ca-tab", "aria-selected": t[0] === tab ? "true" : "false", "data-tab": t[0], text: t[1],
        onclick: function () { fillDrawer(drawer, a, t[0]); } }));
    });
    drawer.appendChild(bar);
    drawer.appendChild(panel);
    var fail = function (e) { panel.appendChild(el("p", { class: "ca-err", role: "alert", text: (e && e.message) || T.failed })); };
    if (tab === "versions") {
      api("GET", base(a.id)).then(function (j) {
        var ul = el("ul", { class: "ca-sub" });
        (j.versions || []).forEach(function (v) {
          var tainted = (v.untrusted_input == null || Number(v.untrusted_input) !== 0) && !v.trust_cleared_at;
          var tags = [Number(v.n) === Number(j.artifact.current_version) ? T.v_current : v.state === "proposed" ? T.v_proposed : T.v_past];
          if (v.flagged_reason) tags.push(T.v_flagged);
          if (tainted) tags.push(T.v_tainted);
          var li = el("li", {}, [el("span", { text: "v" + v.n + " · " + tags.join(" · ") }), v.change_note ? el("span", { class: "ca-note", text: " — " + v.change_note }) : null]);
          if (tainted && !v.flagged_reason) li.appendChild(el("button", { type: "button", class: "btn btn-secondary btn-sm ca-approve", text: T.approve, onclick: function () {
            api("POST", base(a.id) + "/versions/" + encodeURIComponent(v.n) + "/approve", {}).then(function () { fillDrawer(drawer, a, "versions"); }, fail);
          } }));
          ul.appendChild(li);
        });
        panel.appendChild(ul);
      }, fail);
    } else if (tab === "links") {
      api("GET", base(a.id) + "/links").then(function (j) {
        if (!(j.links || []).length) { panel.appendChild(el("p", { text: T.no_links })); return; }
        var ul = el("ul", { class: "ca-sub" });
        j.links.forEach(function (l) {
          var name = (l.label || l.threadId) + " · " + l.botId + (l.state === "stopped" ? " (" + T.asleep + ")" : "");
          ul.appendChild(el("li", {}, [
            el("span", { text: name }),
            el("a", { class: "btn btn-secondary btn-sm ca-openchat", href: "/dashboard/perch#" + encodeURIComponent(l.threadId), text: T.open_chat }),
            el("button", { type: "button", class: "btn btn-secondary btn-sm ca-unlink", text: T.unlink, onclick: function () {
              api("POST", base(a.id) + "/links/" + encodeURIComponent(l.id) + "/unlink", {}).then(function () { a.badges.links = Math.max(0, (a.badges.links || 1) - 1); fillDrawer(drawer, a, "links"); }, fail);
            } }),
          ]));
        });
        panel.appendChild(ul);
      }, fail);
    } else if (tab === "projects") {
      panel.appendChild(el("p", { class: "ca-soon", text: T.soon_projects }));
    } else if (tab === "sharing") {
      panel.appendChild(el("p", { class: "ca-soon", text: T.soon_sharing }));
    } else if (tab === "audit") {
      api("GET", base(a.id) + "/audit").then(function (j) {
        if (!(j.rows || []).length) { panel.appendChild(el("p", { text: T.no_audit })); return; }
        var ul = el("ul", { class: "ca-sub ca-audit" });
        j.rows.forEach(function (r) { ul.appendChild(el("li", { text: r.ts + " · " + r.action + " · " + r.actor + (r.target ? " · " + r.target : "") })); });
        panel.appendChild(ul);
      }, fail);
    }
  }

  [search, typeSel, stateSel].forEach(function (c) { c.addEventListener("input", renderList); c.addEventListener("change", renderList); });

  // House style (design kit spec §4.4, D4): the owner picks a theme per
  // project and a default per bot. Off unless set: "No house style" is the
  // first option. Every authored string goes in with textContent; colours
  // arrive server-checked as #hex and are set as style properties.
  var hsBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm ca-hs-open", "aria-expanded": "false", text: T.hs_button });
  var hsBox = el("section", { class: "ca-hs", hidden: "" });
  function hsSwatches(holder, themes, id) {
    holder.textContent = "";
    var t = null;
    themes.forEach(function (x) { if (x.id === id) t = x; });
    (t ? t.colors || [] : []).forEach(function (c) { var sw = el("span", { class: "ca-hs-sw" }); sw.style.background = c; holder.appendChild(sw); });
  }
  function hsRow(scope, item, themes) {
    var sel = el("select", { "aria-label": fmt(T.hs_for, { name: item.name }) });
    sel.appendChild(el("option", { value: "", text: T.hs_none }));
    themes.forEach(function (t) { var o = el("option", { value: t.id, text: t.name }); if (item.theme === t.id) o.selected = true; sel.appendChild(o); });
    var known = !item.theme || themes.some(function (t) { return t.id === item.theme; });
    var sw = el("span", { class: "ca-hs-sws", "aria-hidden": "true" });
    hsSwatches(sw, themes, item.theme);
    sel.addEventListener("change", function () {
      var want = sel.value || null;
      sel.disabled = true;
      api("POST", "/api/artifacts/house-style", { scope: scope, id: item.id, theme: want }).then(function () {
        sel.disabled = false; item.theme = want; hsSwatches(sw, themes, want);
        if (warn && warn.parentNode) warn.parentNode.removeChild(warn);
      }, function (e) {
        sel.disabled = false;
        sel.value = item.theme && known ? item.theme : "";
        banner(e && e.code === "stale" ? T.hs_stale : T.failed, "warn");
      });
    });
    var warn = known ? null : el("span", { class: "ca-hs-warn", text: T.hs_missing });
    return el("li", { class: "ca-hs-row" }, [el("span", { class: "ca-hs-name", text: item.name }), sel, sw, warn]);
  }
  function renderHouseStyle() {
    hsBox.textContent = "";
    hsBox.appendChild(el("h3", { text: T.hs_title }));
    hsBox.appendChild(el("p", { class: "ca-hs-help", text: T.hs_help }));
    api("GET", "/api/artifacts/house-style").then(function (j) {
      if (!j.kit) { hsBox.appendChild(el("p", { text: T.hs_no_kit })); return; }
      [["project", T.hs_projects, j.projects || [], T.hs_no_projects], ["bot", T.hs_bots, j.bots || [], T.hs_no_bots]].forEach(function (g) {
        hsBox.appendChild(el("h4", { text: g[1] }));
        var ul = el("ul", { class: "ca-sub ca-hs-list" });
        if (!g[2].length) ul.appendChild(el("li", { text: g[3] }));
        g[2].forEach(function (item) { ul.appendChild(hsRow(g[0], item, j.themes || [])); });
        hsBox.appendChild(ul);
      });
    }, function () { hsBox.appendChild(el("p", { text: T.failed })); });
  }
  hsBtn.addEventListener("click", function () {
    var open = hsBox.hasAttribute("hidden");
    if (open) { hsBox.removeAttribute("hidden"); renderHouseStyle(); } else hsBox.setAttribute("hidden", "");
    hsBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  fetch("/api/artifacts", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) {
    root.textContent = "";
    root.appendChild(el("h2", { text: T.title }));
    root.appendChild(hsBtn); root.appendChild(hsBox);
    var iso = j.origin && j.origin.isolation;
    if (iso === "shared-host") banner(LOCAL_HOSTS.test(location.host) ? T.weaker : T.fallback_remote, "warn");
    else if (iso === "unavailable" || !iso) banner(T.unavailable, "warn");
    all = j.artifacts || [];
    if (all.length) root.appendChild(el("div", { class: "ca-tools" }, [search, typeSel, stateSel]));
    root.appendChild(list);
    renderList();
  }, function (e) { root.textContent = ""; banner(String(e && e.message || e), "warn"); });
})();
