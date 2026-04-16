#!/usr/bin/env node
// Codemod: rewrite `res.redirect(...)` → `res.redirectAfterPost(...)` inside
// POST-like route handlers across the gateway and bundle panels. This flips
// the HTTP status from 302 to 303 so Turbo Drive updates the URL after form
// submission (Turbo treats 302-after-POST as "stay on current URL").
//
// Scope:
//   - servers/gateway/**/*.js
//   - bundles/*/panel/**/*.js
//   - bundles/*/panels/**/*.js
//   - bundles/*/routes/**/*.js
//
// Rules per call site:
//   - `res.redirect(301, url)`  → unchanged (permanent redirect, semantically distinct)
//   - `res.redirect(303, url)`  → unchanged (already 303)
//   - Otherwise, if the call sits inside a POST-like scope → rewrite to
//     `res.redirectAfterPost(url)` (strips any explicit 302 status).
//   - POST-like scope means: a route registered via `.post()/.put()/.patch()/
//     .delete()/.all()/.use()`, OR an `if (req.method === "POST" /* etc */)`
//     block. Innermost scope wins, so a GET check inside an .all() handler is
//     correctly treated as GET.
//   - Calls outside any detectable scope are SKIPPED and logged so the
//     reviewer can decide manually (e.g., middleware like dashboardAuth).
//
// Explicit file skips (OAuth, explicit GET handler):
//   - servers/gateway/auth.js
//   - servers/gateway/setup-page.js
//
// Usage:
//   node scripts/migrate-redirect-303.js            # write changes + print summary
//   node scripts/migrate-redirect-303.js --dry-run  # preview only
//   node scripts/migrate-redirect-303.js --verbose  # include skip reasons

import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

const SKIP_RELPATHS = new Set([
  "servers/gateway/auth.js",
  "servers/gateway/setup-page.js",
]);

const NON_GET_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL", "USE"]);
const HTTP_METHOD_LITERALS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function shouldIncludeFile(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (!rel.endsWith(".js")) return false;
  if (rel.includes("node_modules")) return false;
  if (SKIP_RELPATHS.has(rel)) return false;
  if (rel.startsWith("servers/gateway/")) return true;
  if (rel.startsWith("bundles/")) {
    const parts = rel.split(path.sep);
    // bundles/<id>/<sub>/...
    if (parts.length < 3) return false;
    const sub = parts[2];
    return sub === "panel" || sub === "panels" || sub === "routes";
  }
  return false;
}

function walkDir(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      if (shouldIncludeFile(full)) out.push(full);
    }
  }
  return out;
}

function collectCandidateFiles() {
  const out = [];
  walkDir(path.join(ROOT, "servers", "gateway"), out);
  walkDir(path.join(ROOT, "bundles"), out);
  return out.sort();
}

// Match `req.method` (MemberExpression)
function isReqMethod(node) {
  return node &&
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" && node.object.name === "req" &&
    node.property?.type === "Identifier" && node.property.name === "method";
}

// Extract "GET" | "POST" | ... from a string literal / template literal-no-expr
function methodLiteral(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    const m = node.value.toUpperCase();
    return HTTP_METHOD_LITERALS.has(m) ? m : null;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    const m = node.quasis[0].value.cooked.toUpperCase();
    return HTTP_METHOD_LITERALS.has(m) ? m : null;
  }
  return null;
}

// For an IfStatement test, return { method, truthyIsMethod } or null.
// - `req.method === "POST"` → { method: "POST", truthyIsMethod: true }
// - `req.method !== "POST"` → { method: "POST", truthyIsMethod: false }
// - `req.method === "POST" && whatever` → { method: "POST", truthyIsMethod: true }
// - `["POST","PUT"].includes(req.method)` → null (bail — unusual)
function classifyIfTest(test) {
  if (!test) return null;
  if (test.type === "BinaryExpression" && (test.operator === "===" || test.operator === "==")) {
    if (isReqMethod(test.left)) {
      const m = methodLiteral(test.right);
      if (m) return { method: m, truthyIsMethod: true };
    }
    if (isReqMethod(test.right)) {
      const m = methodLiteral(test.left);
      if (m) return { method: m, truthyIsMethod: true };
    }
  }
  if (test.type === "BinaryExpression" && (test.operator === "!==" || test.operator === "!=")) {
    if (isReqMethod(test.left)) {
      const m = methodLiteral(test.right);
      if (m) return { method: m, truthyIsMethod: false };
    }
    if (isReqMethod(test.right)) {
      const m = methodLiteral(test.left);
      if (m) return { method: m, truthyIsMethod: false };
    }
  }
  // `A && B` — consequent runs only when both A and B are truthy, so if either
  // side establishes the method, we can propagate it.
  if (test.type === "LogicalExpression" && test.operator === "&&") {
    return classifyIfTest(test.left) || classifyIfTest(test.right);
  }
  return null;
}

// Is this CallExpression a route registration like router.post("/p", handler)?
// Returns the method string ("GET"/"POST"/...) or null.
function routeMethodFromCall(node) {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;
  if (callee.property?.type !== "Identifier") return null;
  const name = callee.property.name;
  if (["get", "post", "put", "patch", "delete", "all", "use"].includes(name)) {
    return name.toUpperCase();
  }
  return null;
}

// Is this a res.redirect(...) call?
function isResRedirectCall(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return false;
  if (callee.object?.type !== "Identifier" || callee.object.name !== "res") return false;
  if (callee.property?.type !== "Identifier" || callee.property.name !== "redirect") return false;
  return true;
}

// Given a res.redirect call, return { action, status, urlNode }
//   action: "rewrite" | "skip-permanent" | "skip-already-303" | "skip-unexpected"
function classifyRedirect(node) {
  const args = node.arguments;
  if (args.length === 1) {
    return { action: "rewrite", status: null, urlNode: args[0] };
  }
  if (args.length === 2) {
    const [statusArg, urlArg] = args;
    if (statusArg.type === "Literal" && typeof statusArg.value === "number") {
      if (statusArg.value === 301) return { action: "skip-permanent", status: 301, urlNode: urlArg };
      if (statusArg.value === 303) return { action: "skip-already-303", status: 303, urlNode: urlArg };
      // Anything else (302, 307, 308...) → rewrite (drop status)
      return { action: "rewrite", status: statusArg.value, urlNode: urlArg };
    }
    return { action: "skip-unexpected", status: null, urlNode: null };
  }
  return { action: "skip-unexpected", status: null, urlNode: null };
}

function scopeImpliesPost(scopeStack) {
  for (let i = scopeStack.length - 1; i >= 0; i--) {
    const s = scopeStack[i];
    if (s.kind === "method-check") {
      return NON_GET_METHODS.has(s.method);
    }
    if (s.kind === "route") {
      return NON_GET_METHODS.has(s.method);
    }
  }
  return null; // unknown
}

function describeScope(scopeStack) {
  if (scopeStack.length === 0) return "no-enclosing-scope";
  const s = scopeStack[scopeStack.length - 1];
  return s.kind === "route" ? `route:${s.method}` : `method-check:${s.method}`;
}

function transformFile(src, relPath) {
  let ast;
  try {
    ast = parse(src, {
      sourceType: "module",
      ecmaVersion: "latest",
      locations: false,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch (err) {
    return { edits: [], skips: [], parseError: err.message };
  }

  const edits = []; // {start, end, replacement, line}
  const skips = []; // {line, reason, details}

  function locateLine(start) {
    // 1-indexed line number
    let line = 1;
    for (let i = 0; i < start && i < src.length; i++) {
      if (src.charCodeAt(i) === 10) line++;
    }
    return line;
  }

  function visit(node, scopeStack) {
    if (!node || typeof node !== "object" || !node.type) return;

    // Handle IfStatement specially so the scope applies only to the correct branch.
    if (node.type === "IfStatement") {
      // Visit test without the new scope
      if (node.test) visit(node.test, scopeStack);
      const cls = classifyIfTest(node.test);
      if (cls) {
        const consequentScope = { kind: "method-check", method: cls.method };
        const alternateScope = { kind: "method-check", method: cls.method === "GET" ? "POST" : "GET" };
        // truthy branch: if `req.method === "POST"`, consequent runs iff method === POST
        if (cls.truthyIsMethod) {
          scopeStack.push(consequentScope);
          if (node.consequent) visit(node.consequent, scopeStack);
          scopeStack.pop();
          // Alternate: method is NOT the checked one — ambiguous (could be GET or anything).
          // Don't push a scope; let outer scope apply.
          if (node.alternate) visit(node.alternate, scopeStack);
        } else {
          // `req.method !== "POST"` → consequent runs when NOT that method
          if (node.consequent) visit(node.consequent, scopeStack);
          // Alternate: method IS that one
          scopeStack.push(consequentScope);
          if (node.alternate) visit(node.alternate, scopeStack);
          scopeStack.pop();
        }
        return;
      }
      // Non-method-check if: visit both branches without pushing scope.
      if (node.consequent) visit(node.consequent, scopeStack);
      if (node.alternate) visit(node.alternate, scopeStack);
      return;
    }

    // Route registration: push scope, visit children, pop.
    const routeMethod = routeMethodFromCall(node);
    let pushed = false;
    if (routeMethod) {
      scopeStack.push({ kind: "route", method: routeMethod });
      pushed = true;
    }

    // Settings-section convention: `handleAction` is only ever dispatched for
    // POST form submissions (see servers/gateway/dashboard/settings/registry.js).
    // Treat methods/properties named `handleAction` as implicit POST scope.
    const POST_ONLY_HELPER_NAMES = new Set(["handleAction", "handlePostAction", "handlePost"]);
    if (
      (node.type === "Property" || node.type === "MethodDefinition") &&
      !node.computed &&
      node.key?.type === "Identifier" &&
      POST_ONLY_HELPER_NAMES.has(node.key.name) &&
      node.value?.type === "FunctionExpression"
    ) {
      scopeStack.push({ kind: "route", method: "POST" });
      pushed = true;
    }
    // Standalone function declarations with POST-only helper names (e.g.,
    // `export async function handlePostAction(req, res) { ... }`).
    if (
      node.type === "FunctionDeclaration" &&
      node.id?.type === "Identifier" &&
      POST_ONLY_HELPER_NAMES.has(node.id.name)
    ) {
      scopeStack.push({ kind: "route", method: "POST" });
      pushed = true;
    }

    // Handle res.redirect call
    if (isResRedirectCall(node)) {
      const line = locateLine(node.start);
      const c = classifyRedirect(node);
      if (c.action === "skip-permanent") {
        skips.push({ line, reason: "301 permanent", details: "left unchanged" });
      } else if (c.action === "skip-already-303") {
        skips.push({ line, reason: "already 303", details: "left unchanged" });
      } else if (c.action === "skip-unexpected") {
        skips.push({ line, reason: "unexpected arity / non-literal status", details: src.slice(node.start, node.end) });
      } else if (c.action === "rewrite") {
        const inPost = scopeImpliesPost(scopeStack);
        if (inPost === true) {
          const urlSrc = src.slice(c.urlNode.start, c.urlNode.end);
          edits.push({
            start: node.start,
            end: node.end,
            replacement: `res.redirectAfterPost(${urlSrc})`,
            line,
          });
        } else if (inPost === false) {
          // GET-like scope → leave as-is
          if (VERBOSE) skips.push({ line, reason: "GET scope", details: describeScope(scopeStack) });
        } else {
          // No scope detected — flag for manual review
          skips.push({ line, reason: "no enclosing route scope", details: src.slice(node.start, node.end) });
        }
      }
    }

    // Recurse into children
    for (const key of Object.keys(node)) {
      if (key === "type") continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) visit(c, scopeStack);
      } else if (v && typeof v === "object" && typeof v.type === "string") {
        visit(v, scopeStack);
      }
    }

    if (pushed) scopeStack.pop();
  }

  visit(ast, []);

  // Apply edits from end to start so offsets stay valid
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }

  return { out, edits, skips };
}

// ---- Main ----
const files = collectCandidateFiles();
let filesChanged = 0;
let totalRewrites = 0;
const allSkips = [];
const parseErrors = [];

for (const abs of files) {
  const rel = path.relative(ROOT, abs);
  const src = fs.readFileSync(abs, "utf8");
  if (!src.includes("res.redirect")) continue; // fast-path
  const result = transformFile(src, rel);
  if (result.parseError) {
    parseErrors.push({ rel, error: result.parseError });
    continue;
  }
  if (result.edits.length > 0) {
    filesChanged++;
    totalRewrites += result.edits.length;
    if (!DRY_RUN) {
      fs.writeFileSync(abs, result.out, "utf8");
    }
    const lines = result.edits.sort((a, b) => a.line - b.line).map(e => `  L${e.line}`).join("\n");
    console.log(`${DRY_RUN ? "[dry-run] " : ""}${rel} — ${result.edits.length} rewrite(s)\n${lines}`);
  }
  for (const s of result.skips) {
    allSkips.push({ rel, ...s });
  }
}

console.log(`\n=== Summary ===`);
console.log(`Files scanned:  ${files.length}`);
console.log(`Files changed:  ${filesChanged}${DRY_RUN ? " (dry-run — no writes)" : ""}`);
console.log(`Total rewrites: ${totalRewrites}`);
console.log(`Skips logged:   ${allSkips.length}`);
console.log(`Parse errors:   ${parseErrors.length}`);

if (allSkips.length > 0) {
  console.log(`\n=== Skipped redirects (needs manual review) ===`);
  const byReason = allSkips.reduce((acc, s) => {
    (acc[s.reason] ||= []).push(s);
    return acc;
  }, {});
  for (const [reason, items] of Object.entries(byReason)) {
    console.log(`\n[${reason}] ${items.length} site(s):`);
    for (const s of items) {
      const detail = s.details && s.details.length < 200 ? ` — ${s.details.replace(/\s+/g, " ")}` : "";
      console.log(`  ${s.rel}:${s.line}${detail}`);
    }
  }
}

if (parseErrors.length > 0) {
  console.log(`\n=== Parse errors ===`);
  for (const { rel, error } of parseErrors) console.log(`  ${rel}: ${error}`);
}
