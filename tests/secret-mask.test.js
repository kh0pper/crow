/**
 * Approval-card secret masking, the Crow side (contract with pi-lab,
 * 2026-10-26, final rules of pi-lab fa30563): one shared maskSecrets() with
 * pi-lab's pattern set plus exact values. Heuristic masking must never hide
 * anything that could execute: text piped or here-stringed into sudo -S, and
 * heredoc bodies, are hidden ONLY by exact values; every pattern candidate
 * must be password-like and not a host or a path; PEM only in its strict key
 * shape. Every fake below is assembled at runtime from obviously fake parts,
 * so no literal in this file looks like a real credential (the public hygiene
 * guard reads tracked files line by line).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { maskSecrets, maskSecretsDetailed, REDACTED, displayEscape, hiddenNote } = await import("../servers/shared/secret-mask.js");

const FAKE = "fake-" + "pw-" + "0000";            // a stand-in password, never a real one
const S = "-" + "S";                                 // sudo's read-stdin flag, kept apart from "sudo"
const none = { values: [] };
const m = (t, values = []) => maskSecrets(t, { values });
const pipe = (word, target = "systemctl restart x") => ["echo", word, "|", "sudo", S, target].join(" ");

test("the 10-25 shape: hidden by the exact value; with no value it stays byte-identical (it could be stdin code)", () => {
  const cmd = pipe('"' + FAKE + '"');
  assert.equal(m(cmd, [FAKE]), pipe('"' + REDACTED + '"'));
  assert.equal(m(cmd), cmd, "no pattern for sudo -S stdin");
  assert.equal(m(pipe('"rm -rf ~"', "bash")), pipe('"rm -rf ~"', "bash"), "code fed to a shell is never hidden");
});

test("here-strings and heredocs into sudo -S: exact values only", () => {
  const hs = "sudo " + S + " ls <<< " + FAKE;
  assert.equal(m(hs), hs);
  assert.equal(m(hs, [FAKE]), "sudo " + S + " ls <<< " + REDACTED);
  const heredoc = "sudo " + S + " bash <<EOF\nrm -rf /tmp/x\n" + FAKE + "\nEOF";
  assert.equal(m(heredoc), heredoc);
  assert.equal(m(displayEscape(heredoc), [FAKE]).includes(FAKE), false);
  assert.match(m(displayEscape(heredoc), [FAKE]), /rm -rf \/tmp\/x/);
});

test("sshpass, mysql -p, PGPASSWORD, --password and --passwd", () => {
  const SSHPASS = "sshpass" + " -p";
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
  assert.equal(m("mysql -u root -p db"), "mysql -u root -p db", "-p alone prompts");
  assert.equal(m("mysql -u root -p " + FAKE), "mysql -u root -p " + FAKE, "-p WORD: WORD is the database");
});

test("Authorization, X-Api-Key and token query values", () => {
  for (const cmd of [
    'curl -H "Authorization: Bearer ' + FAKE + '" http://x',
    "curl -H 'authorization: basic " + FAKE + "' http://x",
    'curl -H "X-Api-Key: ' + FAKE + '" http://x',
    "curl http://x/?token=" + FAKE + "&a=1",
    "curl 'http://x/?a=1&token=" + FAKE + "'",
    "curl http://x/?api_key=" + FAKE,
  ]) {
    assert.equal(m(cmd).includes(FAKE), false, cmd);
  }
  assert.match(m("curl http://x/?token=" + FAKE + "&a=1"), /&a=1$/);
});

test("NAME=value for secret-like names; MAX_TOKENS, BYPASS_X and references stay visible", () => {
  for (const name of ["DB_PASS", "ADMIN_PASSWORD", "app_secret", "GH_TOKEN", "OPENAI_API_KEY", "MY_APIKEY", "SSH_PRIVATE_KEY", "private_key", "PGPASSWORD"]) {
    assert.equal(m(name + "=" + FAKE + " ./run"), name + "=" + REDACTED + " ./run", name);
  }
  for (const t of ["PORT=8080 HOST=localhost ./run", 'PW_FILE="$HOME/x" TOKEN=$TOKEN ./run', "MAX_TOKENS=4096 ./run", "BYPASS_CACHE=" + FAKE]) {
    assert.equal(m(t), t, t);
  }
});

test("a pattern never hides code, a host or a path", () => {
  for (const t of [
    'GH_TOKEN="$(cat /etc/shadow)" ./run',
    "DB_PASSWORD=/run/secrets/db ./run",
    "API_KEY=`id` ./run",
    "TOKEN=a;rm -rf ~ ./run",
    "sshpass" + " -p " + "./script.sh ssh host",
  ]) {
    assert.equal(m(t), t, t);
  }
});

test("known token shapes", () => {
  for (const tok of [
    "gh" + "p_" + "A".repeat(36),
    "github" + "_pat_" + "B".repeat(30),
    "t" + "k_" + "c".repeat(29),
    "s" + "k-" + "d".repeat(30),
    "AK" + "IA" + "E".repeat(16),
  ]) {
    assert.equal(m("use " + tok + " now"), "use " + REDACTED + " now", tok.slice(0, 6));
  }
  assert.equal(m("api: sk-" + "no-key-required"), "api: sk-" + "no-key-required");
});

test("PEM: only the strict key shape is hidden; anything else between the markers stays visible", () => {
  const dash = "-".repeat(5);
  const b64 = (n) => "Q".repeat(n);
  const block = (body) => dash + "BEGIN RSA PRIVATE KEY" + dash + "\n" + body + "\n" + dash + "END RSA PRIVATE KEY" + dash;
  const key = block([b64(64), b64(64), b64(20)].join("\n"));
  const out = m("key:\n" + key + "\nafter");
  assert.equal(out.includes(b64(64)), false);
  assert.match(out, /after$/);
  assert.equal(m(displayEscape("key:\n" + key)).includes(b64(64)), false, "escaped \\n lines too");
  for (const body of ["bash /tmp/x", "# reboot", b64(64), b64(64) + "\n" + b64(10) + " x"]) {
    const t = "k:\n" + block(body);
    assert.equal(m(t), t, body);
  }
  const mid = "x " + dash + "BEGIN RSA PRIVATE KEY" + dash + "\n" + [b64(64), b64(64)].join("\n") + "\n" + dash + "END RSA PRIVATE KEY" + dash;
  assert.equal(m(mid), mid, "BEGIN mid-line");
  assert.equal(m("k:\n" + block("bash /tmp/x"), ["bash /tmp/x"]).includes("bash /tmp/x"), false, "an exact value still masks");
});

test("exact values: raw, escaped and JSON-escaped forms, every occurrence, longest first; < 6 chars ignored", () => {
  const v = "plain-" + "value-1";
  const longer = v + "-extended";
  assert.equal(m("a " + longer + " b " + v + " c " + v, [v, longer]), "a " + REDACTED + " b " + REDACTED + " c " + REDACTED);
  const odd = "back\\" + "slash-" + "é";
  assert.equal(m("x " + displayEscape(odd) + " y", [odd]), "x " + REDACTED + " y");
  const q = 'quo"te-' + "value-1";
  assert.equal(JSON.parse(m(JSON.stringify({ command: "login " + q }), [q])).command, "login " + REDACTED);
  assert.equal(m("abc12 abc12", ["abc12"]), "abc12 abc12");
});

test("a value cut by pi-lab's display limit: its leading part before the marker is hidden, at any length", () => {
  const v = "cut-" + "secret-" + "value-123456";
  assert.equal(m("run x " + v.slice(0, 12) + "\u2026(40 more characters)", [v]), "run x " + REDACTED + "\u2026(40 more characters)");
  const long = "tok" + "x9".repeat(98) + "z";                 // 200 characters
  assert.equal(long.length, 200);
  const shown = "curl -d " + long.slice(0, 150) + "\u2026(50 more characters)";
  assert.equal(m(shown, [long]), "curl -d " + REDACTED + "\u2026(50 more characters)");
  assert.equal(m("run x " + v.slice(0, 5) + "\u2026(9 more characters)", [v]), "run x " + v.slice(0, 5) + "\u2026(9 more characters)", "under 6: left alone");
  assert.equal(m("a\u2026(3 more characters)"), "a\u2026(3 more characters)");
});

test("count, idempotence, a clean text byte-identical, non-strings", () => {
  const cmd = "GH_TOKEN=" + FAKE + " push; " + pipe(FAKE);
  const r = maskSecretsDetailed(cmd, { values: [FAKE] });
  assert.equal(r.count, 2);
  assert.equal(maskSecretsDetailed(r.text, { values: [FAKE] }).count, 0);
  const clean = "rm -rf /tmp/build && ls -la ~/x \"quoted\" 'single' | grep y";
  assert.equal(m(clean), clean);
  assert.equal(maskSecrets(null, none), "");
  assert.equal(maskSecrets(undefined, none), "");
  assert.equal(maskSecrets(42, none), "42");
});

test("long adversarial texts stay fast (no catastrophic backtracking)", () => {
  const v = "adversarial-" + "value-xyz";
  const long = "L".repeat(4000);
  const t0 = Date.now();
  m(("echo " + "a".repeat(50) + " ").repeat(200) + "| " + "x ".repeat(5000));
  m("sshpass " + "a ".repeat(20000));
  m("mysql " + "a ".repeat(20000));
  m("A".repeat(50000) + "=");
  m(("x".repeat(390) + "\u2026(5 more characters)").repeat(250), [v, v + "2", long]);
  m(("L".repeat(3999) + "\u2026(1 more characters)").repeat(25), [long]);
  m("-".repeat(5) + "BEGIN RSA PRIVATE KEY" + "-".repeat(5) + "\n" + "Q".repeat(100000));
  assert.ok(Date.now() - t0 < 2000, "took " + (Date.now() - t0) + " ms");
});

test("hiddenNote: the contract's first-line wording", () => {
  assert.equal(hiddenNote(1), "(1 secret value(s) hidden from this card)");
  assert.equal(hiddenNote(3), "(3 secret value(s) hidden from this card)");
});
