/**
 * Nominatim GIS — MCP Server Factory
 *
 * 5 MCP tools for geocoding, reverse geocoding, place search,
 * batch geocoding of data columns, and GeoJSON generation.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "../../../servers/db.js";
import { geocode, reverseGeocode, searchPlaces, checkStatus } from "./geocoder.js";

export function createNominatimServer(dbPath, options = {}) {
  const db = createDbClient(dbPath);

  const server = new McpServer(
    { name: "crow-nominatim", version: "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // --- Tool: crow_gis_geocode ---
  server.tool(
    "crow_gis_geocode",
    "Forward geocode: convert an address or place name to latitude/longitude coordinates. Uses self-hosted Nominatim (OpenStreetMap data).",
    {
      query: z.string().max(500).describe("Address or place name to geocode"),
      limit: z.number().max(10).default(3).describe("Max results"),
      countrycodes: z.string().max(50).optional().describe("Filter by country codes (e.g., 'us,ca')"),
    },
    async ({ query, limit, countrycodes }) => {
      const status = await checkStatus();
      if (!status.available) {
        return { content: [{ type: "text", text: `Nominatim is not reachable: ${status.error}. Is the Docker container running?` }], isError: true };
      }

      const results = await geocode(query, { limit, countrycodes });

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No results found for "${query}"` }] };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.display_name}\n   lat: ${r.lat}, lon: ${r.lon} (${r.type}, importance: ${r.importance?.toFixed(3) || "n/a"})`
      ).join("\n\n");

      return { content: [{ type: "text", text: `Geocoding results for "${query}":\n\n${formatted}` }] };
    }
  );

  // --- Tool: crow_gis_reverse ---
  server.tool(
    "crow_gis_reverse",
    "Reverse geocode: convert latitude/longitude to an address. Zoom level controls detail (3=country, 10=city, 14=suburb, 18=building).",
    {
      lat: z.number().min(-90).max(90).describe("Latitude"),
      lon: z.number().min(-180).max(180).describe("Longitude"),
      zoom: z.number().min(0).max(18).default(18).describe("Detail level (3=country, 10=city, 18=building)"),
    },
    async ({ lat, lon, zoom }) => {
      const status = await checkStatus();
      if (!status.available) {
        return { content: [{ type: "text", text: `Nominatim is not reachable: ${status.error}` }], isError: true };
      }

      const result = await reverseGeocode(lat, lon, zoom);

      if (result.error) {
        return { content: [{ type: "text", text: `No address found at ${lat}, ${lon}` }] };
      }

      const addr = result.address || {};
      const parts = [
        `Address: ${result.display_name}`,
        addr.road ? `Street: ${addr.road}` : null,
        addr.city || addr.town || addr.village ? `City: ${addr.city || addr.town || addr.village}` : null,
        addr.state ? `State: ${addr.state}` : null,
        addr.postcode ? `ZIP: ${addr.postcode}` : null,
        addr.country ? `Country: ${addr.country}` : null,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: parts }] };
    }
  );

  // --- Tool: crow_gis_search ---
  server.tool(
    "crow_gis_search",
    "Search for places by name or type within an optional bounding box. Returns locations with coordinates.",
    {
      query: z.string().max(500).describe("Place name or type to search for"),
      viewbox: z.string().max(100).optional().describe("Bounding box: lon1,lat1,lon2,lat2"),
      countrycodes: z.string().max(50).optional().describe("Filter by country codes"),
      limit: z.number().max(50).default(10).describe("Max results"),
    },
    async ({ query, viewbox, countrycodes, limit }) => {
      const results = await searchPlaces(query, { viewbox, countrycodes, limit });

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No places found for "${query}"` }] };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.display_name}\n   ${r.lat}, ${r.lon} (${r.type})`
      ).join("\n");

      return { content: [{ type: "text", text: `${results.length} places found:\n\n${formatted}` }] };
    }
  );

  // --- Tool: crow_gis_batch_geocode ---
  server.tool(
    "crow_gis_batch_geocode",
    "Geocode a column of addresses in a data_backend SQLite table. Adds lat/lng columns to the table with results. Requires the Data Dashboard bundle.",
    {
      backend_id: z.number().describe("Data backend ID (SQLite database)"),
      table: z.string().max(200).describe("Table name containing addresses"),
      address_column: z.string().max(200).describe("Column containing address strings"),
      lat_column: z.string().max(200).default("lat").describe("Output column name for latitude"),
      lon_column: z.string().max(200).default("lon").describe("Output column name for longitude"),
      limit: z.number().max(10000).default(100).describe("Max rows to geocode"),
    },
    async ({ backend_id, table, address_column, lat_column, lon_column, limit }) => {
      // Resolve backend path
      const { rows: backends } = await db.execute({
        sql: "SELECT connection_ref FROM data_backends WHERE id = ? AND backend_type = 'sqlite'",
        args: [backend_id],
      });
      if (backends.length === 0) {
        return { content: [{ type: "text", text: `Backend #${backend_id} not found or not SQLite.` }], isError: true };
      }

      const ref = JSON.parse(backends[0].connection_ref);
      const { createClient } = await import("@libsql/client");
      const userDb = createClient({ url: `file:${ref.path}` });

      try {
        // Add lat/lon columns if they don't exist
        try { await userDb.execute(`ALTER TABLE "${table}" ADD COLUMN "${lat_column}" REAL`); } catch {}
        try { await userDb.execute(`ALTER TABLE "${table}" ADD COLUMN "${lon_column}" REAL`); } catch {}

        // Get rows needing geocoding
        const { rows } = await userDb.execute({
          sql: `SELECT rowid, "${address_column}" FROM "${table}" WHERE "${lat_column}" IS NULL AND "${address_column}" IS NOT NULL LIMIT ?`,
          args: [limit],
        });

        if (rows.length === 0) {
          return { content: [{ type: "text", text: "No rows need geocoding (all already have coordinates or no addresses)." }] };
        }

        let success = 0;
        let failed = 0;

        for (const row of rows) {
          const addr = row[address_column];
          if (!addr) { failed++; continue; }

          try {
            const results = await geocode(String(addr), { limit: 1 });
            if (results.length > 0) {
              await userDb.execute({
                sql: `UPDATE "${table}" SET "${lat_column}" = ?, "${lon_column}" = ? WHERE rowid = ?`,
                args: [parseFloat(results[0].lat), parseFloat(results[0].lon), row.rowid],
              });
              success++;
            } else {
              failed++;
            }
          } catch {
            failed++;
          }

          // Rate limit: 1 req/sec for self-hosted Nominatim courtesy
          await new Promise(r => setTimeout(r, 100));
        }

        return {
          content: [{
            type: "text",
            text: `Batch geocoding complete.\n\nProcessed: ${rows.length}\nSuccess: ${success}\nFailed: ${failed}\n\nResults stored in "${lat_column}" and "${lon_column}" columns.`,
          }],
        };
      } finally {
        userDb.close();
      }
    }
  );

  // --- Tool: crow_gis_create_geojson ---
  server.tool(
    "crow_gis_create_geojson",
    "Generate GeoJSON from a SQL query result that includes lat/lng columns. Returns a FeatureCollection for use in maps.",
    {
      backend_id: z.number().describe("Data backend ID"),
      sql: z.string().max(10000).describe("SQL query that returns rows with lat/lng columns"),
      lat_column: z.string().max(200).default("lat").describe("Column name for latitude"),
      lon_column: z.string().max(200).default("lon").describe("Column name for longitude"),
      properties: z.array(z.string().max(200)).optional().describe("Additional columns to include as GeoJSON properties"),
    },
    async ({ backend_id, sql: query, lat_column, lon_column, properties }) => {
      const { rows: backends } = await db.execute({
        sql: "SELECT connection_ref FROM data_backends WHERE id = ? AND backend_type = 'sqlite'",
        args: [backend_id],
      });
      if (backends.length === 0) {
        return { content: [{ type: "text", text: `Backend #${backend_id} not found.` }], isError: true };
      }

      const ref = JSON.parse(backends[0].connection_ref);

      // Use the query engine for safe read-only execution
      const { executeReadQuery } = await import("../../data-dashboard/server/query-engine.js");
      const result = await executeReadQuery(ref.path, query, 5000);

      const features = [];
      for (const row of result.rows) {
        const lat = parseFloat(row[lat_column]);
        const lon = parseFloat(row[lon_column]);
        if (isNaN(lat) || isNaN(lon)) continue;

        const props = {};
        const propCols = properties || Object.keys(row).filter(k => k !== lat_column && k !== lon_column);
        for (const col of propCols) {
          if (row[col] !== undefined) props[col] = row[col];
        }

        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: props,
        });
      }

      const geojson = {
        type: "FeatureCollection",
        features,
      };

      return {
        content: [{
          type: "text",
          text: `GeoJSON FeatureCollection (${features.length} features):\n\n${JSON.stringify(geojson, null, 2)}`,
        }],
      };
    }
  );

  return server;
}
