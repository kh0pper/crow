/**
 * Approval-card secret masking, the Crow side (contract with pi-lab,
 * 2026-10-26): one shared maskSecrets() with the contract's pattern set plus
 * exact values. Every fake below is assembled at runtime from obviously fake
 * parts, so no literal in this file looks like a real credential (the public
 * hygiene guard reads tracked files line by line).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { maskSecrets, maskSecretsDetailed, REDACTED, displayEscape, hiddenNote } = await import("../servers/shared/secret-mask.js");

const FAKE = "fake-" + "pw-" + "0000";            // a stand-in password, never a real one
const S = "-" + "S";                                 // sudo's read-stdin flag, kept apart from "sudo"
const STDIN = "--" + "stdin";
const SSHPASS = "sshpass" + " -p";
const none = { values: [] };
const m = (t, values = []) => maskSecrets(t, { values });

test("the 10-25 shape: a quoted literal piped into sudo -S", () => {
  const cmd = ["echo", '"' + FAKE + '"', "|", "sudo", S, "systemctl restart x"].join(" ");
  const out = m(cmd);
  assert.equal(out.includes(FAKE), false);
  assert.equal(out, ["echo", '"' + REDACTED + '"', "|", "sudo", S, "systemctl restart x"].join(" "));
});

test("sudo pipe: bare and single-quoted words, printf with a format, -kS and --stdin, a path to sudo", () => {
  for (const cmd of [
    "echo " + FAKE + " | sudo " + S + " ls",
    "echo '" + FAKE + "' | sudo -k" + "S ls",
    "printf '%s\\n' '" + FAKE + "' | sudo " + STDIN + " ls",
    "echo -n " + FAKE + " | /usr/bin/sudo -u root " + S + " ls",
    "ECHO " + FAKE + " | SUDO " + S + " ls",
  ]) {
    assert.equal(m(cmd).includes(FAKE), false, cmd);
  }
});

test("sudo pipe: a variable reference and a pipe into something else stay as they are", () => {
  const varRef = 'echo "$SUDO_PW" | sudo ' + S + " ls";
  assert.equal(m(varRef), varRef);
  const notSudo = "echo hello-world | grep hello";
  assert.equal(m(notSudo), notSudo);
});

test("sudo -S fed by a here-string or a heredoc (raw and approvalText-escaped)", () => {
  assert.equal(m("sudo " + S + " ls <<< " + FAKE).includes(FAKE), false);
  assert.equal(m("sudo " + S + " ls <<<'" + FAKE + "'").includes(FAKE), false);
  const heredoc = "sudo " + S + " ls <<EOF\n" + FAKE + "\nEOF\necho done";
  const out = m(heredoc);
  assert.equal(out.includes(FAKE), false);
  assert.match(out, /echo done$/);
  const escaped = displayEscape(heredoc);
  assert.equal(m(escaped).includes(FAKE), false);
  assert.match(m(escaped), /echo done$/);
});

test("sshpass, mysql -p, PGPASSWORD, --password and --passwd", () => {
  for (const cmd of [
    SSHPASS + " " + FAKE + " ssh host",
    SSHPASS + "'" + FAKE + "' ssh host",
    "mysql -u root -p" + FAKE + " db",
    "PGPASSWORD=" + FAKE + " psql -h x",
    "tool --password=" + FAKE,
    "tool --password " + FAKE,
    "tool --passwd " + FAKE,
  ]) {
    assert.equal(m(cmd).includes(FAKE), false, cmd);
  }
  // mysql -p alone (prompt) has nothing to hide
  assert.equal(m("mysql -u root -p db"), "mysql -u root -p db");
});

test("Authorization, X-Api-Key and token/api_key query values", () => {
  for (const cmd of [
    'curl -H "Authorization: Bearer ' + FAKE + '" http://x',
    "curl -H 'authorization: basic " + FAKE + "' http://x",
    'curl -H "Authorization: token ' + FAKE + '" http://x',
    'curl -H "X-Api-Key: ' + FAKE + '" http://x',
    "curl http://x/?token=" + FAKE + "&a=1",
    "curl 'http://x/?a=1&token=" + FAKE + "'",
    "curl http://x/?api_key=" + FAKE,
  ]) {
    const out = m(cmd);
    assert.equal(out.includes(FAKE), false, cmd);
  }
  assert.match(m("curl http://x/?token=" + FAKE + "&a=1"), /&a=1$/);
});

test("NAME=value for secret-like names, any case; other assignments untouched", () => {
  for (const name of ["DB_PASS", "ADMIN_PASSWORD", "app_secret", "GH_TOKEN", "OPENAI_API_KEY", "MY_APIKEY", "SSH_PRIVATE_KEY", "private_key"]) {
    const out = m(name + "=" + FAKE + " ./run");
    assert.equal(out, name + "=" + REDACTED + " ./run", name);
  }
  assert.equal(m("PORT=8080 HOST=localhost ./run"), "PORT=8080 HOST=localhost ./run");
  assert.equal(m('PW_FILE="$HOME/x" TOKEN=$TOKEN ./run'), 'PW_FILE="$HOME/x" TOKEN=$TOKEN ./run');
});

test("known token shapes and PEM private-key blocks", () => {
  const shapes = [
    "gh" + "p_" + "A".repeat(36),
    "github" + "_pat_" + "B".repeat(30),
    "t" + "k_" + "c".repeat(29),
    "s" + "k-" + "d".repeat(30),
    "AK" + "IA" + "E".repeat(16),
  ];
  for (const tok of shapes) {
    const out = m("use " + tok + " now");
    assert.equal(out, "use " + REDACTED + " now", tok.slice(0, 6));
  }
  const dash = "-".repeat(5);
  const pem = dash + "BEGIN RSA PRIVATE KEY" + dash + "\nAAAAfakefakefake\n" + dash + "END RSA PRIVATE KEY" + dash;
  const out = m("key:\n" + pem + "\nafter");
  assert.equal(out.includes("fakefakefake"), false);
  assert.match(out, /after$/);
  assert.equal(m(displayEscape("key:\n" + pem + "\nafter")).includes("fakefakefake"), false);
});

test("exact values: raw and escaped forms, every occurrence, longest first; < 6 chars ignored", () => {
  const v = "plain-" + "value-1";
  const longer = v + "-extended";
  const out = m("a " + longer + " b " + v + " c " + v, [v, longer]);
  assert.equal(out, "a " + REDACTED + " b " + REDACTED + " c " + REDACTED);
  const odd = "back\\" + "slash-" + "é";                   // escapes differently in approvalText
  assert.equal(m("x " + displayEscape(odd) + " y", [odd]), "x " + REDACTED + " y");
  assert.equal(m("abc12 abc12", ["abc12"]), "abc12 abc12");
});

test("count, idempotence, a clean text byte-identical, non-strings, never throws", () => {
  const cmd = "echo " + FAKE + " | sudo " + S + " ls; GH_TOKEN=" + FAKE;
  const r = maskSecretsDetailed(cmd, none);
  assert.equal(r.count, 2);
  assert.equal(maskSecretsDetailed(r.text, none).count, 0);
  assert.equal(maskSecrets(r.text, none), r.text);
  const clean = "rm -rf /tmp/build && ls -la ~/x \"quoted\" 'single' | grep y";
  assert.equal(m(clean), clean);
  assert.equal(maskSecrets(null, none), "");
  assert.equal(maskSecrets(undefined, none), "");
  assert.equal(maskSecrets(42, none), "42");
});

test("a long adversarial line stays fast (no catastrophic backtracking)", () => {
  const evil = ("echo " + "a".repeat(50) + " ").repeat(200) + "| " + "x ".repeat(5000);
  const t0 = Date.now();
  m(evil);
  m("sudo " + " -".repeat(20000) + " <<<");
  m("mysql " + "a ".repeat(20000));
  m("A".repeat(50000) + "=");
  assert.ok(Date.now() - t0 < 1500, "took " + (Date.now() - t0) + " ms");
});

test("hiddenNote: the contract's first-line wording", () => {
  assert.equal(hiddenNote(1), "(1 secret value(s) hidden from this card)");
  assert.equal(hiddenNote(3), "(3 secret value(s) hidden from this card)");
});

test("a value cut by pi-lab's display limit: its leading part before the marker is hidden", () => {
  const v = "cut-" + "secret-" + "value-123456";
  const shown = "run x " + v.slice(0, 12) + "…(40 more characters)";
  assert.equal(m(shown, [v]), "run x " + REDACTED + "…(40 more characters)");
  // fewer than 6 leading characters: left alone; no values: unchanged
  assert.equal(m("run x " + v.slice(0, 5) + "…(9 more characters)", [v]), "run x " + v.slice(0, 5) + "…(9 more characters)");
  assert.equal(m("a…(3 more characters)"), "a…(3 more characters)");
});

test("over-masking guards: MAX_TOKENS, short sk- placeholders, -s shell flag text without a pipe", () => {
  assert.equal(m("MAX_TOKENS=4096 ./run"), "MAX_TOKENS=4096 ./run");
  assert.equal(m("api: sk-" + "no-key-required"), "api: sk-" + "no-key-required");
  assert.equal(m("sudo -s"), "sudo -s");
});

test("100 KB of adversarial text with cut markers stays fast", () => {
  const v = "adversarial-" + "value-xyz";
  const big = ("x".repeat(390) + "…(5 more characters)").repeat(250);
  const t0 = Date.now();
  m(big, [v, v + "2", v + "3"]);
  m(("echo a | " + "b ".repeat(30)).repeat(1500));
  assert.ok(Date.now() - t0 < 1500, "took " + (Date.now() - t0) + " ms");
});

test("JSON-escaped quotes (a tool call's stringified args) are words too", () => {
  const args = JSON.stringify({ command: ["echo", '"' + FAKE + '"', "|", "sudo", S, "ls"].join(" ") });
  const out = m(args);
  assert.equal(out.includes(FAKE), false);
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out).command, ["echo", '"' + REDACTED + '"', "|", "sudo", S, "ls"].join(" "));
  const env = JSON.stringify({ command: "GH_TOKEN=\"" + FAKE + "\" git push" });
  assert.equal(JSON.parse(m(env)).command, 'GH_TOKEN="' + REDACTED + '" git push');
});

test("a bare word with an escaped backslash (approvalText doubles it) is masked whole", () => {
  const pw = "fake" + "\\" + "pw-0000";
  const shown = displayEscape("echo " + pw + " | sudo " + S + " ls");
  const out = m(shown);
  assert.equal(out.includes("pw-0000"), false, out);
  assert.equal(out.includes("fake"), false, out);
});

test("a masked heredoc is not masked again", () => {
  const once = maskSecretsDetailed("sudo " + S + " ls <<EOF\n" + FAKE + "\nEOF", none);
  assert.equal(once.count, 1);
  assert.equal(maskSecretsDetailed(once.text, none).count, 0);
});

test("an exact value inside JSON-escaped text (a quote in it) is masked", () => {
  const v = 'quo"te-' + "value-1";
  const args = JSON.stringify({ command: "login " + v });
  const out = m(args, [v]);
  assert.equal(out.includes("value-1"), false, out);
  assert.equal(JSON.parse(out).command, "login " + REDACTED);
});
