/**
 * How bots actually run here, in plain words (security audit N1b-2).
 *
 * Until this existed the only signal for a host where bubblewrap was missing or
 * blocked was one console.error in scripts/pi-bots/pi_sandbox.mjs, and pi
 * children then ran unsandboxed (setpriv no-new-privs, or plain, with this
 * user's docker group and sudo). The Bot Runtime settings section and the Nest
 * health card both read THIS module, so the two can never disagree.
 *
 * The probe is the spawner's own (probePiSandbox, cached for 5 minutes in the
 * gateway process), so nothing here starts pi. `probe.ok` means bwrap could
 * make the namespaces the sandbox needs; `probe.reason` is the plain English
 * failure the console line prints; `probe.setpriv` is the fallback binary (when
 * it is there, sudo/setuid are blocked but docker is not).
 *
 * The advice is never wider than the evidence: "Ubuntu 24.04 blocks it, re-run
 * the installer" is shown only when this kernel really restricts unprivileged
 * user namespaces (the AppArmor switch reads 1). On a container, on Debian's
 * unprivileged_userns_clone=0, or when the installed profile is not enough, the
 * probe's own error is the reason and the next step is generic. And when the
 * bots are started by an external supervisor (PIBOT_SUPERVISOR=external), this
 * process has nothing to observe at all: the status is "unobserved", never
 * "sandboxed".
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { probePiSandbox, piSandboxMode, piSandboxReasonCode } from "../../../../scripts/pi-bots/pi_sandbox.mjs";
import { t, fill } from "./i18n.js";
import { escapeHtml } from "./components.js";

/** Test seam: the probe every status surface uses. Null restores the real one. */
let probeOverride = null;
export function _setBotSandboxProbeForTest(fn) { probeOverride = typeof fn === "function" ? fn : null; }

/** The launch probe for this render (never throws on a hostile seam). */
export function botSandboxProbe() {
  if (probeOverride) {
    try { return probeOverride() || {}; } catch { return {}; }
  }
  return probePiSandbox();
}

const DEFAULT_USERNS_SWITCH = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const DEFAULT_APPARMOR_DIR = "/etc/apparmor.d";

/** Test seams: the kernel switch and the profile dir this module reads. */
let usernsSwitchPath = DEFAULT_USERNS_SWITCH;
let apparmorDirPath = DEFAULT_APPARMOR_DIR;
export function _setUsernsRestrictionPathForTest(p) { usernsSwitchPath = p ? String(p) : DEFAULT_USERNS_SWITCH; }
export function _setApparmorDirForTest(p) { apparmorDirPath = p ? String(p) : DEFAULT_APPARMOR_DIR; }

/** True when this kernel restricts unprivileged user namespaces (AppArmor). */
export function usernsRestrictionOn(path = usernsSwitchPath) {
  try { return readFileSync(path, "utf8").trim() === "1"; } catch { return false; }
}

/** A real profile line attaching /usr/bin/bwrap — never a comment. */
const BWRAP_PROFILE_LINE = /^[ \t]*profile[ \t]+\S+[ \t]+\/usr\/bin\/bwrap/m;

/** True when an AppArmor profile for bubblewrap is installed under dir. */
export function bwrapProfileInstalled(dir = apparmorDirPath) {
  let names = [];
  try { names = readdirSync(dir); } catch { return false; }
  for (const name of names) {
    let text;
    try { text = readFileSync(join(dir, name), "utf8"); } catch { continue; }
    if (BWRAP_PROFILE_LINE.test(text)) return true;
  }
  return false;
}

/**
 * True when this instance's bots are spawned somewhere this process cannot see
 * (PIBOT_SUPERVISOR=external: the host's own units start them, with an env this
 * gateway never reads). Shared with the settings section's containment block.
 */
export function spawnsOutsideThisProcess(env = process.env) {
  return String(env.PIBOT_SUPERVISOR || "").trim() === "external";
}

const REASON_KEY = {
  "no-bwrap": "settings.sandboxStatus.reasonNoBwrap",
  "userns-blocked": "settings.sandboxStatus.reasonUserns",
  disabled: "settings.sandboxStatus.reasonDisabled",
};

const NEXT_KEY = {
  "no-bwrap": "settings.sandboxStatus.nextNoBwrap",
  "userns-blocked": "settings.sandboxStatus.nextUserns",
  disabled: "settings.sandboxStatus.nextDisabled",
};

/**
 * The status of the bot sandbox as text.
 * @returns {{sandboxed:boolean, observed:boolean, code:string|null, reason:string|null,
 *            exposure:string|null, nextStep:string|null, sentence:string,
 *            setpriv:boolean}}
 * `sentence` is the one line both surfaces show; `nextStep` is the single plain
 * action for the reason (null when already sandboxed). `observed` is false when
 * the spawns happen outside this process, so nothing here can claim a tier.
 */
export function botSandboxStatus({
  probe = null,
  mode = piSandboxMode(process.env),
  lang = "en",
  externalSupervisor = spawnsOutsideThisProcess(),
} = {}) {
  const p = probe || botSandboxProbe() || {};
  if (externalSupervisor) {
    return {
      sandboxed: false,
      observed: false,
      code: "unobserved",
      reason: t("settings.sandboxStatus.reasonUnobserved", lang),
      exposure: null,
      nextStep: t("settings.sandboxStatus.nextUnobserved", lang),
      sentence: t("settings.sandboxStatus.unobserved", lang),
      setpriv: false,
    };
  }
  const code = piSandboxReasonCode(p, mode);
  const sandboxed = code === null;
  const key = code || "no-bwrap";
  let reasonKey = REASON_KEY[key];
  let nextKey = NEXT_KEY[key];
  let reasonText = null;
  if (code === "userns-blocked") {
    const restrictionOn = usernsRestrictionOn();
    if (restrictionOn && bwrapProfileInstalled()) {
      // The installer's profile IS there and bwrap still fails: never send the
      // operator back to "re-run the installer".
      reasonKey = "settings.sandboxStatus.reasonUsernsProfile";
      nextKey = "settings.sandboxStatus.nextUsernsProfile";
    } else if (restrictionOn) {
      reasonKey = "settings.sandboxStatus.reasonUserns";
      nextKey = "settings.sandboxStatus.nextUserns";
    } else {
      // Not the Ubuntu AppArmor restriction: show what the probe really said,
      // and a next step that does not name Ubuntu at all.
      reasonKey = "settings.sandboxStatus.reasonUsernsGeneric";
      nextKey = "settings.sandboxStatus.nextUsernsGeneric";
      const raw = String(p.reason || "").trim();
      if (raw) reasonText = raw;
    }
  }
  // The console line has two cases: with setpriv sudo/setuid are blocked and
  // docker is not; without it the bot keeps this user's groups and sudo works.
  // Mode off is its own case: pi_sandbox.mjs spawns plain, so sudo works no
  // matter what a probe found.
  const exposureKey = code === "disabled" || !p.setpriv
    ? "settings.sandboxStatus.exposurePlain"
    : "settings.sandboxStatus.exposureSetpriv";
  const reason = sandboxed ? null : (reasonText || t(reasonKey, lang));
  const exposure = sandboxed ? null : t(exposureKey, lang);
  const nextStep = sandboxed ? null : t(nextKey, lang);
  const sentence = sandboxed
    ? t("settings.sandboxStatus.sandboxed", lang)
    : fill(t("settings.sandboxStatus.unsandboxed", lang), { reason, exposure });
  return { sandboxed, observed: true, code, reason, exposure, nextStep, sentence, setpriv: !!p.setpriv };
}

/** The Bot Runtime settings status line (its own block, above the form). */
export function renderBotSandboxStatus(opts = {}) {
  const lang = opts.lang ?? "en";
  const status = botSandboxStatus({ ...opts, lang });
  const next = status.nextStep
    ? `<p style="margin:0.25rem 0 0;color:var(--crow-text-secondary);font-size:0.9rem">${escapeHtml(status.nextStep)}</p>`
    : "";
  return `<div class="crow-sandbox-status" id="crow-sandbox-status" style="margin:0 0 1.5rem">
      <p id="crow-sandbox-status-line" style="margin:0;font-weight:600">${escapeHtml(status.sentence)}</p>
      ${next}
    </div>`;
}