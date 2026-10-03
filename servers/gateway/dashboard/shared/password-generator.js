/**
 * The Generate button's password generator (spec §5.5). ES5 on purpose and free of
 * backticks: extensions/client.js embeds it with Function.prototype.toString() inside its
 * template literal, and the same function is unit-tested in Node.
 * 24 chars; at least one lower/upper/digit/symbol; look-alikes (l I O 0 1) left out, and
 * ONLY .env-bare-safe symbols (no # ~ $ quotes backslash backtick space — review C2/C3):
 * a generated password is written to a bundle .env byte-identically to before and is
 * never expanded by bash. randomUint32 MUST be a CSPRNG
 * (crypto.getRandomValues in the browser); rejection sampling keeps every pick uniform.
 * A manifest `pattern` is honoured by retrying, then by falling back to alphanumerics;
 * null means "cannot satisfy it" and the client hides the button.
 */
export const PASSWORD_LENGTH = 24;

export function generatePassword(length, pattern, randomUint32) {
  var lower = "abcdefghijkmnopqrstuvwxyz";
  var upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  var digits = "23456789";
  var symbols = "!%*+,-./:=?@^_";
  var re = null;
  if (pattern) {
    try { re = new RegExp(pattern); } catch (e) { return null; }
  }
  function uniform(n) {
    var limit = Math.floor(4294967296 / n) * n;
    var r;
    do { r = randomUint32(); } while (!(r < limit));
    return r % n;
  }
  function attempt(sets) {
    var all = sets.join("");
    var out = [];
    for (var i = 0; i < sets.length; i++) out.push(sets[i].charAt(uniform(sets[i].length)));
    while (out.length < length) out.push(all.charAt(uniform(all.length)));
    for (var j = out.length - 1; j > 0; j--) {
      var k = uniform(j + 1);
      var tmp = out[j]; out[j] = out[k]; out[k] = tmp;
    }
    return out.join("");
  }
  var plans = [[lower, upper, digits, symbols], [lower, upper, digits]];
  for (var p = 0; p < plans.length; p++) {
    for (var n = 0; n < 50; n++) {
      var pw = attempt(plans[p]);
      if (!re || re.test(pw)) return pw;
    }
  }
  return null;
}
