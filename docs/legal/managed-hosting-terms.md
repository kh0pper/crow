# Managed Hosting Terms of Service

*Draft — Effective: March 2026 | Maestro Press. This document is a draft and should be reviewed by a lawyer before being treated as binding.*

---

## 1. Service Description

Maestro Press provides managed hosting of Crow. Each customer receives an isolated Crow instance accessible at `username.crow.maestro.press`, running in a dedicated Docker container with a separate database. Up to 5 instances share a single server; capacity upgrades occur as demand grows.

## 2. Account & Access

One account per person. You are responsible for keeping your login credentials secure. Do not share your dashboard password or session tokens with others.

## 3. Data Handling & Privacy

- **Isolated database** — Your data is stored in a separate database from other customers. There is no cross-instance access.
- **API keys** — Any API keys you configure (Gmail, GitHub, Slack, etc.) are stored only as environment variables on your instance, never in the database.
- **No data access** — Maestro Press does not access your data except when necessary for maintenance, support you have requested, or legal obligation.
- **IP logging** — IP addresses are logged for security purposes (detecting unauthorized access, brute-force protection). IP logs are automatically deleted after 90 days.
- **Infrastructure** — Your data is stored on DigitalOcean infrastructure in the United States.
- **Backups** — Daily backups are included. Backups are retained for 7 days.

## 4. Your Responsibilities

- Keep your dashboard password and API keys secure.
- Comply with the terms of service of any third-party services whose API keys you configure in your Crow instance (e.g., Google, GitHub, Slack, Notion).
- Notify Maestro Press promptly if you believe your account has been compromised.

## 5. Acceptable Use

You may not use the service for:

- Any illegal activity under United States or applicable local law
- Abuse, harassment, or distribution of harmful content
- Excessive resource consumption that degrades service for other customers
- Reselling or sublicensing your Crow instance to third parties
- Automated attacks, scraping, or other activity that violates third-party terms of service

## 6. Billing & Payment

- **Pricing** — $15/month or $120/year (annual plan saves 4 months).
- **Payment** — Processed via Stripe. By completing checkout, you agree to these terms.
- **Monthly plans** — No partial-month refunds upon cancellation.
- **Annual plans** — Pro-rata refund available if cancelled within 30 days of purchase.
- **Pricing changes** — 30 days advance notice via email before any pricing changes take effect.

## 7. Service Availability

- **Best-effort availability** — Maestro Press strives to keep your instance running, but does not guarantee a specific uptime percentage (no SLA).
- **Not liable for downtime** caused by third-party services, network outages, or force majeure events (natural disasters, government actions, etc.).
- **Planned maintenance** — Advance notice will be provided when possible, typically via email or dashboard notification.

## 8. Intellectual Property

- **Crow is open source** — Crow is released under the MIT License. You may self-host it at any time.
- **Your data is yours** — Maestro Press claims no ownership of your memories, research, blog posts, files, or any other data stored in your instance.

## 9. Limitation of Liability

- The service is provided **"as is"** without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement.
- **Total liability** of Maestro Press is limited to the fees you have paid in the 12 months preceding the claim.
- Maestro Press is **not liable for indirect, incidental, special, consequential, or punitive damages**, including but not limited to loss of data, revenue, or business opportunities.
- Maestro Press is **not liable for data loss** beyond the scope of included daily backups.

## 10. Indemnification

You agree to indemnify and hold harmless Maestro Press from any claims, damages, or expenses arising from:

- Your use of the service
- API keys you configure and their associated third-party services
- Content you store, publish, or share through your Crow instance
- Your violation of these terms

## 11. Account Termination & Data Export

- **You may cancel** your subscription at any time through Stripe or by contacting Maestro Press.
- **Maestro Press may terminate** your account immediately for violations of these terms, particularly the Acceptable Use policy.
- **Data export window** — After termination, you have 30 days to export your data. After 30 days, all data is permanently deleted.
- **Self-hosting migration** — You may export your data and migrate to a self-hosted Crow instance at any time.

## 12. Changes to Terms

- Maestro Press may update these terms with **30 days advance notice** via email or dashboard notification.
- Continued use of the service after the notice period constitutes acceptance of the updated terms.
- If you do not agree with the changes, you may cancel your subscription before they take effect.

## 13. Governing Law

These terms are governed by the laws of the **State of Texas, United States**, without regard to conflict of law provisions.

## 14. Contact

For questions about these terms, your account, or the service:

- **Email**: kevin@maestro.press
