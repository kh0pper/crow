/**
 * Settings Section: Change Password
 */

import { formField } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";

export default {
  id: "password",
  group: "account",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  labelKey: "settings.section.password",
  navOrder: 10,

  async getPreview() {
    return "";
  },

  async render({ req, lang }) {
    const successMsg = req.query.success === "password"
      ? `<div class="alert alert-success">${t("settings.passwordUpdated", lang)}</div>` : "";
    const errorMsg = req.query.error === "short"
      ? `<div class="alert alert-error">${t("settings.passwordTooShort", lang)}</div>`
      : req.query.error === "mismatch"
      ? `<div class="alert alert-error">${t("settings.passwordMismatch", lang)}</div>`
      : req.query.error === "wrong_current"
      ? `<div class="alert alert-error">${t("settings.currentPasswordWrong", lang)}</div>` : "";

    return `${successMsg}${errorMsg}
    <form method="POST">
      <input type="hidden" name="action" value="change_password">
      ${formField(t("settings.currentPassword", lang), "current_password", { type: "password", required: true, placeholder: t("settings.currentPasswordPlaceholder", lang) })}
      ${formField(t("settings.newPassword", lang), "password", { type: "password", required: true, placeholder: t("settings.newPasswordPlaceholder", lang) })}
      ${formField(t("settings.confirmPassword", lang), "confirm", { type: "password", required: true })}
      <button type="submit" class="btn btn-secondary">${t("settings.changePasswordButton", lang)}</button>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "change_password") return false;

    const { setPassword, validatePasswordStrength, verifyPassword } = await import("../../auth.js");
    const { current_password, password, confirm } = req.body;

    // Verify current password
    const result = await db.execute("SELECT value FROM dashboard_settings WHERE key = 'password_hash'");
    if (result.rows.length > 0) {
      const valid = await verifyPassword(current_password, result.rows[0].value);
      if (!valid) {
        res.redirectAfterPost("/dashboard/settings?section=password&error=wrong_current");
        return true;
      }
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      res.redirectAfterPost("/dashboard/settings?section=password&error=short");
      return true;
    }
    if (password !== confirm) {
      res.redirectAfterPost("/dashboard/settings?section=password&error=mismatch");
      return true;
    }
    await setPassword(password);
    res.redirectAfterPost("/dashboard/settings?section=password&success=password");
    return true;
  },
};
