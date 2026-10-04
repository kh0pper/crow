/**
 * Crow's Nest panel — Kiosk displays. PLACEHOLDER (Task 10): the manifest
 * declares this file (bundle-contract file-checks it, and the gateway only
 * loads kiosk-routes.js next to a kiosk.js panel). Task 12 replaces it with
 * the pairing/admin panel.
 */
export default {
  id: "kiosk",
  name: "Kiosk",
  icon: "monitor",
  route: "/dashboard/kiosk",
  navOrder: 56,
  category: "hardware",
  async handler(req, res, { layout }) {
    res.send(layout({ title: "Kiosk", content: "<p>Kiosk displays: open /display on the display to pair it.</p>" }));
  },
};
