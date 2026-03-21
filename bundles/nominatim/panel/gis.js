/**
 * Nominatim GIS — Map Tab Plugin for Data Dashboard
 *
 * When installed, adds a "Map" tab to the Data Dashboard panel.
 * Uses Leaflet with OpenStreetMap tiles for visualization.
 * Renders point markers from geocoded data.
 */

import { escapeHtml, section } from "../../../../servers/gateway/dashboard/shared/components.js";

export default {
  id: "gis-map",
  tabId: "map",
  tabLabel: "Map",
  tabIcon: "🗺️",
  extends: "data-dashboard",

  /**
   * Render the map tab content.
   * @param {object} params - { db, backendId, lang }
   */
  async render({ db, backendId, lang }) {
    if (!backendId) {
      return `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">Select a database with geocoded data to view on the map.</div>`;
    }

    // Check if backend has lat/lon columns
    let hasGeoData = false;
    try {
      const { rows } = await db.execute({
        sql: "SELECT connection_ref FROM data_backends WHERE id = ? AND backend_type = 'sqlite'",
        args: [backendId],
      });
      if (rows.length > 0) {
        const ref = JSON.parse(rows[0].connection_ref);
        const { getSchema } = await import("../../data-dashboard/server/query-engine.js");
        const schema = await getSchema(ref.path);
        hasGeoData = schema.tables.some(t =>
          t.columns.some(c => c.name === "lat" || c.name === "latitude") &&
          t.columns.some(c => c.name === "lon" || c.name === "lng" || c.name === "longitude")
        );
      }
    } catch {}

    const mapHtml = `
      <div id="gis-map" style="width:100%;height:400px;border-radius:var(--crow-radius-card);border:1px solid var(--crow-border);background:var(--crow-bg-elevated)">
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--crow-text-muted)">
          ${hasGeoData
            ? "Map visualization requires Leaflet (loaded in browser). Use <code>crow_gis_create_geojson</code> to generate map data, then view at <code>/blog/</code> or export."
            : "No geocoded data found. Use <code>crow_gis_batch_geocode</code> to add lat/lon columns to your data."}
        </div>
      </div>
      <div style="margin-top:1rem;font-size:0.8rem;color:var(--crow-text-secondary)">
        <p><strong>GIS Tools available via AI:</strong></p>
        <ul style="margin:0.25rem 0;padding-left:1.5rem">
          <li><code>crow_gis_geocode</code> — Address → coordinates</li>
          <li><code>crow_gis_reverse</code> — Coordinates → address</li>
          <li><code>crow_gis_batch_geocode</code> — Geocode a whole column</li>
          <li><code>crow_gis_create_geojson</code> — Generate GeoJSON for maps</li>
        </ul>
      </div>
    `;

    return mapHtml;
  },
};
