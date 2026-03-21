/**
 * Settings Section: Two-Factor Authentication
 */

import { t } from "../../shared/i18n.js";

const isHosted = !!process.env.CROW_HOSTED;

export default {
  id: "two-factor",
  group: "account",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  labelKey: "settings.section.twoFactor",
  navOrder: 11, // Right after password (10)

  async getPreview({ settings }) {
    const enabled = settings.totp_enabled === "true";
    return enabled ? "Enabled" : "Disabled";
  },

  async render({ req, db, lang }) {
    const {
      is2faEnabled,
      getRecoveryCodeCount,
      generateTotpSecret,
      generateQrDataUri,
      generateRecoveryCodes,
    } = await import("../../totp.js");

    const enabled = await is2faEnabled();
    const successMsg = req.query.success === "2fa-enabled"
      ? `<div class="alert alert-success">${t("settings.2faEnabled", lang)}</div>`
      : req.query.success === "2fa-disabled"
      ? `<div class="alert alert-success">${t("settings.2faDisabled", lang)}</div>`
      : req.query.success === "2fa-codes-regenerated"
      ? `<div class="alert alert-success">${t("settings.2faCodesRegenerated", lang)}</div>`
      : req.query.success === "2fa-devices-revoked"
      ? `<div class="alert alert-success">${t("settings.2faDevicesRevoked", lang)}</div>`
      : "";
    const errorMsg = req.query.error === "invalid-code"
      ? `<div class="alert alert-error">${t("login.2faInvalidCode", lang)}</div>` : "";

    if (enabled) {
      const remaining = await getRecoveryCodeCount();

      // Show new recovery codes if just regenerated
      const newCodes = req.query.codes ? JSON.parse(decodeURIComponent(req.query.codes)) : null;
      const codesHtml = newCodes
        ? `<div style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin:1rem 0;text-align:center">
            <p style="font-size:0.8rem;font-weight:600;margin-bottom:0.5rem">${t("login.2faRecoveryCodes", lang)}</p>
            ${newCodes.map(c => `<code style="display:block;padding:0.2rem 0;font-size:0.9rem">${c}</code>`).join("")}
            <p style="font-size:0.7rem;color:var(--crow-text-tertiary);margin-top:0.5rem">${t("login.2faSaveCodesWarning", lang)}</p>
          </div>`
        : "";

      return `${successMsg}${errorMsg}${codesHtml}
        <div style="margin-bottom:1.5rem">
          <p style="color:var(--crow-text-secondary);font-size:0.9rem">${t("settings.2faStatus", lang)}: <strong style="color:var(--crow-accent)">${t("settings.2faStatusEnabled", lang)}</strong></p>
          <p style="color:var(--crow-text-tertiary);font-size:0.85rem;margin-top:0.25rem">${t("settings.2faRecoveryRemaining", lang)}: ${remaining}</p>
        </div>
        <div style="display:flex;flex-direction:column;gap:0.75rem">
          <form method="POST" style="margin:0">
            <input type="hidden" name="action" value="regenerate_recovery_codes">
            <button type="submit" class="btn btn-secondary" style="width:100%">${t("settings.2faRegenerateCodes", lang)}</button>
          </form>
          <form method="POST" style="margin:0">
            <input type="hidden" name="action" value="revoke_devices">
            <button type="submit" class="btn btn-secondary" style="width:100%">${t("settings.2faRevokeDevices", lang)}</button>
          </form>
          ${!isHosted ? `
          <form method="POST" style="margin:0" onsubmit="return confirm('${t("settings.2faDisableConfirm", lang)}')">
            <input type="hidden" name="action" value="disable_2fa">
            <button type="submit" class="btn btn-secondary" style="width:100%;color:var(--crow-error,#e55)">${t("settings.2faDisableButton", lang)}</button>
          </form>` : `
          <p style="font-size:0.8rem;color:var(--crow-text-tertiary)">${t("settings.2faMandatory", lang)}</p>`}
        </div>`;
    }

    // Not enabled — show setup
    const { secret, uri } = generateTotpSecret();
    const qrDataUri = await generateQrDataUri(uri);
    const recoveryCodes = generateRecoveryCodes();

    return `${successMsg}${errorMsg}
      <p style="color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:1rem">${t("settings.2faSetupInstructions", lang)}</p>
      <div style="text-align:center;margin:1rem 0">
        <img src="${qrDataUri}" alt="QR Code" width="180" height="180" style="border-radius:8px;background:#fff;padding:6px">
      </div>
      <p style="font-size:0.75rem;color:var(--crow-text-tertiary);word-break:break-all;text-align:center;margin-bottom:1rem">${t("login.2faManualKey", lang)}: <code>${secret}</code></p>
      <div style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin:1rem 0;text-align:center">
        <p style="font-size:0.8rem;font-weight:600;margin-bottom:0.5rem">${t("login.2faRecoveryCodes", lang)}</p>
        ${recoveryCodes.map(c => `<code style="display:block;padding:0.2rem 0;font-size:0.9rem">${c}</code>`).join("")}
        <p style="font-size:0.7rem;color:var(--crow-text-tertiary);margin-top:0.5rem">${t("login.2faSaveCodesWarning", lang)}</p>
      </div>
      <form method="POST">
        <input type="hidden" name="action" value="enable_2fa">
        <input type="hidden" name="secret" value="${secret}">
        <input type="hidden" name="recovery_codes" value="${encodeURIComponent(JSON.stringify(recoveryCodes))}">
        <input type="text" name="totp_code" placeholder="${t("login.2faPlaceholder", lang)}" required autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" style="text-align:center;font-size:1.1rem;letter-spacing:0.2em;padding:0.5rem;width:100%;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-bg-deep);color:var(--crow-text-primary);margin-bottom:0.75rem">
        <button type="submit" class="btn btn-secondary" style="width:100%">${t("login.2faSetupVerifyButton", lang)}</button>
      </form>`;
  },

  async handleAction({ req, res, db, action }) {
    const {
      is2faEnabled,
      verifyTotp,
      getTotpSecret,
      saveTotpSetup,
      enable2fa,
      disable2fa,
      generateRecoveryCodes,
      revokeAllDeviceTrust,
    } = await import("../../totp.js");

    if (action === "enable_2fa") {
      const { totp_code, secret, recovery_codes } = req.body;
      const codes = JSON.parse(decodeURIComponent(recovery_codes));

      // Save setup first
      await saveTotpSetup(secret, codes);

      // Verify the code
      if (!verifyTotp(totp_code, secret)) {
        res.redirect("/dashboard/settings?section=two-factor&error=invalid-code");
        return true;
      }

      await enable2fa();
      res.redirect("/dashboard/settings?section=two-factor&success=2fa-enabled");
      return true;
    }

    if (action === "disable_2fa") {
      if (isHosted) {
        // Cannot disable on managed hosting
        res.redirect("/dashboard/settings?section=two-factor");
        return true;
      }
      await disable2fa();
      res.redirect("/dashboard/settings?section=two-factor&success=2fa-disabled");
      return true;
    }

    if (action === "regenerate_recovery_codes") {
      const secret = await getTotpSecret();
      if (!secret) {
        res.redirect("/dashboard/settings?section=two-factor");
        return true;
      }
      const newCodes = generateRecoveryCodes();
      await saveTotpSetup(secret, newCodes);
      res.redirect(`/dashboard/settings?section=two-factor&success=2fa-codes-regenerated&codes=${encodeURIComponent(JSON.stringify(newCodes))}`);
      return true;
    }

    if (action === "revoke_devices") {
      await revokeAllDeviceTrust();
      res.redirect("/dashboard/settings?section=two-factor&success=2fa-devices-revoked");
      return true;
    }

    return false;
  },
};
