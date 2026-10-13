/*
 * Crow Artifacts — the Library client (dashboard origin, trusted). Classic
 * script. Lists artifacts; each opens the viewer page. Every authored string
 * is placed with textContent. No frame, no rail, no Ask-now here (D26: the
 * owner asks in the chat; the viewer page owns comments and rounds).
 */
(function () {
  "use strict";
  var root = document.getElementById("crow-artifacts");
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = "1";
  var T = JSON.parse(root.dataset.strings || "{}");
  var fmt = function (s, o) { return String(s || "").replace(/\{(\w+)\}/g, function (_, k) { return o && o[k] != null ? String(o[k]) : ""; }); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function banner(text, kind) { root.appendChild(el("div", { class: "ca-banner ca-" + (kind || "info"), role: "status", text: text })); }
  // O11: on the loopback fallback the origin is only reachable from this machine.
  var LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

  fetch("/api/artifacts", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) {
    root.textContent = "";
    root.appendChild(el("h2", { text: T.title }));
    var iso = j.origin && j.origin.isolation;
    if (iso === "shared-host") banner(LOCAL_HOSTS.test(location.host) ? T.weaker : T.fallback_remote, "warn");
    else if (iso === "unavailable" || !iso) banner(T.unavailable, "warn");
    if (!j.artifacts || !j.artifacts.length) { root.appendChild(el("p", { class: "ca-empty", text: T.empty })); return; }
    var ul = el("ul", { class: "ca-list" });
    j.artifacts.forEach(function (a) {
      ul.appendChild(el("li", {}, [
        el("a", { href: "/dashboard/artifacts/view/" + encodeURIComponent(a.id), "data-turbo": "false", text: a.title }),
        el("span", { class: "ca-type", text: " · " + a.type + " · v" + a.current_version + (a.created_by_bot ? " · " + fmt(T.made_by, { bot: a.created_by_bot }) : "") }),
      ]));
    });
    root.appendChild(ul);
  }, function (e) { root.textContent = ""; banner(String(e && e.message || e), "warn"); });
})();
