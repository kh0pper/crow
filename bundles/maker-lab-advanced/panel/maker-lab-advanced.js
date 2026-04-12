/**
 * Crow's Nest Panel — Maker Lab Advanced: JupyterHub launcher + admin
 * bootstrap checklist + pair-programmer posture.
 *
 * Thin panel, same shape as kolibri/scratch-offline. The real UX lives
 * in JupyterHub's own web UI; this panel is setup hints + the deep link.
 */

export default {
  id: "maker-lab-advanced",
  name: "Maker Lab Advanced",
  icon: "graduation-cap",
  route: "/dashboard/maker-lab-advanced",
  navOrder: 57,
  category: "education",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const port = process.env.MLA_HTTP_PORT || "8088";
    const hubUrl = `http://${req.hostname || "localhost"}:${port}`;
    const adminUser = process.env.MLA_ADMIN_USER || "(MLA_ADMIN_USER unset — set in .env before first launch)";

    // Short liveness probe so the operator sees status at a glance.
    async function probe(url, timeoutMs) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const resp = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        return resp.ok;
      } catch { return false; }
    }
    const live = await probe(`${hubUrl}/hub/health`, 1500);
    const statusBadge = live
      ? `<span class="ma-badge ma-ok">● live</span>`
      : `<span class="ma-badge ma-off">○ offline</span>`;

    const content = `
      <style>${styles()}</style>
      <div class="ma-panel">
        <h1>Maker Lab Advanced</h1>
        <p class="ma-sub">JupyterHub for older learners · ages 9+ · Python notebooks with kid-safe kernel defaults</p>

        <section class="ma-card">
          <h2>Status</h2>
          <p>${statusBadge}</p>
          <dl class="ma-dl">
            <dt>Hub URL</dt><dd><code>${escapeHtml(hubUrl)}</code></dd>
            <dt>Configured admin</dt><dd><code>${escapeHtml(adminUser)}</code></dd>
          </dl>
          <p><a class="ma-btn" href="${escapeHtml(hubUrl)}" target="_blank" rel="noopener">Open Hub ↗</a></p>
        </section>

        <section class="ma-card">
          <h2>First-boot checklist</h2>
          <ol>
            <li>Set <code>MLA_ADMIN_USER</code> and <code>MLA_ADMIN_PASSWORD</code> in <code>.env</code>. Restart the bundle if you changed them.</li>
            <li>Navigate to <code>${escapeHtml(hubUrl)}/hub/signup</code>, sign up with the admin username + password from step 1. Because that username is in the hub's <code>admin_users</code> list, the account auto-authorizes — no self-approval required.</li>
            <li>Admin view at <code>${escapeHtml(hubUrl)}/hub/admin</code> lists users + server status.</li>
            <li>Learner signups go to <code>${escapeHtml(hubUrl)}/hub/authorize</code> for admin approval before they can spawn a server.</li>
          </ol>
        </section>

        <section class="ma-card">
          <h2>Kid-safe kernel defaults</h2>
          <ul>
            <li>Shell-escape magics (<code>%%bash</code>, <code>!rm</code>, <code>%sx</code>) are disabled at kernel startup. A learner can't shell out of the notebook into the container.</li>
            <li>Per-user home dirs live inside the container at <code>/home/&lt;user&gt;</code>; writes outside that path fail with permission errors from the kernel perspective.</li>
            <li><strong>These are defaults for learners, not a security sandbox.</strong> A determined attacker with Python access can still explore the container filesystem. For untrusted users, swap the spawner for DockerSpawner + per-user images.</li>
          </ul>
        </section>

        <section class="ma-card">
          <h2>Pair-programmer (v1)</h2>
          <p>The <code>maker-lab-advanced</code> skill teaches the AI to act as a pair-programmer at tween/teen reading level. It reuses Maker Lab's hint pipeline and hint-ladder prompts, but:</p>
          <ul>
            <li>Default persona: <code>tween-tutor</code> (80-word hints, middle-grade vocabulary).</li>
            <li>For older learners (14+), the caregiver can switch the session persona to <code>adult-tutor</code> (200-word explanations, plain-language technical terminology, direct Q&A).</li>
            <li>Hints reference <strong>Python + notebook idioms</strong>, not Blockly blocks — the skill explicitly flips off the "never say the answer" constraint at <code>adult-tutor</code> level.</li>
          </ul>
        </section>

        <section class="ma-card">
          <h2>Where this sits in the ladder</h2>
          <table class="ma-tbl">
            <tr><th>Ages</th><th>Surface</th><th>Tutor persona</th></tr>
            <tr><td>5-9</td><td>Blockly (maker-lab)</td><td>kid-tutor</td></tr>
            <tr><td>8+</td><td>Scratch (scratch-offline)</td><td>kid-tutor → tween-tutor</td></tr>
            <tr><td>9+</td><td>JupyterLab (this bundle)</td><td>tween-tutor → adult-tutor</td></tr>
          </table>
        </section>
      </div>
    `;
    return layout({ title: "Maker Lab Advanced", content });
  },
};

function styles() {
  return `
    .ma-panel { max-width: 900px; margin: 0 auto; padding: 1.5rem; }
    .ma-sub { color: var(--fg-muted, #888); margin: 0 0 1.5rem; }
    .ma-card { background: var(--card-bg, rgba(255,255,255,0.04)); border: 1px solid var(--border, #333); border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; }
    .ma-card h2 { margin: 0 0 0.75rem; font-size: 1.05rem; color: #84cc16; }
    .ma-card ol, .ma-card ul { margin: 0; padding-left: 1.25rem; line-height: 1.6; }
    .ma-badge { display: inline-block; padding: 0.25rem 0.7rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .ma-ok { background: rgba(34,197,94,0.15); color: #22c55e; }
    .ma-off { background: rgba(239,68,68,0.15); color: #ef4444; }
    .ma-btn { display: inline-block; padding: 0.6rem 1.2rem; background: #84cc16; color: #111; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 0.5rem; }
    .ma-btn:hover { background: #a3e635; }
    .ma-dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; margin: 0.5rem 0 0; }
    .ma-dl dt { color: var(--fg-muted, #888); }
    .ma-dl dd { margin: 0; }
    .ma-tbl { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
    .ma-tbl th, .ma-tbl td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border, #333); }
    .ma-tbl th { color: var(--fg-muted, #888); font-weight: 600; }
  `;
}
