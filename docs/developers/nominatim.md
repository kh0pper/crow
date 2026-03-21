---
title: Nominatim Developer Guide
description: Self-hosted geocoding with Nominatim — Docker setup, geocoder API client, GIS tools, and Data Dashboard integration.
---

# Nominatim Developer Guide

Nominatim provides self-hosted geocoding (address to coordinates) and reverse geocoding (coordinates to address) using OpenStreetMap data. It runs as a Crow bundle with Docker.

## Docker Setup

The Nominatim bundle uses the `mediagis/nominatim` Docker image with a pre-built PBF extract.

### Install the Bundle

```bash
crow bundle install nominatim
```

This creates `~/.crow/bundles/nominatim/` with a `docker-compose.yml` and default configuration.

### Configure the Region

Before starting, set the PBF extract URL in `~/.crow/bundles/nominatim/.env`:

```bash
# Texas extract (~600 MB, imports in ~30 minutes)
PBF_URL=https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf

# Full US (~10 GB, imports in several hours)
# PBF_URL=https://download.geofabrik.de/north-america/us-latest.osm.pbf
```

Find extracts at [download.geofabrik.de](https://download.geofabrik.de/).

### Start Nominatim

```bash
crow bundle start nominatim
```

First start takes time — Nominatim imports the PBF file and builds its search index. Check progress:

```bash
docker logs -f crow-nominatim
```

The service is ready when you see `Nominatim is ready to accept requests`. The API is available at `http://localhost:8080`.

### Updating Map Data

To update with the latest OSM data:

```bash
crow bundle stop nominatim
# Remove the existing data volume
docker volume rm crow-nominatim-data
crow bundle start nominatim
```

This re-imports from the configured PBF URL. For incremental updates, see the [Nominatim documentation](https://nominatim.org/release-docs/latest/admin/Update/).

## Geocoder API Client

The bundle includes a geocoder client module for use in MCP tools and other Crow code:

```js
import { geocode, reverseGeocode } from '~/.crow/bundles/nominatim/geocoder.js';

// Address → coordinates
const results = await geocode('1100 Congress Ave, Austin, TX');
// [{ lat: 30.2747, lon: -97.7404, display_name: '...', type: 'building' }]

// Coordinates → address
const location = await reverseGeocode(30.2747, -97.7404);
// { address: { road: 'Congress Avenue', city: 'Austin', state: 'Texas', ... } }
```

The client connects to the local Nominatim instance by default. Configure the endpoint in `.env`:

```bash
NOMINATIM_URL=http://localhost:8080
```

### Rate Limiting

The local instance has no rate limit. If you configure an external Nominatim server, the client respects a 1-request-per-second rate limit per the [usage policy](https://operations.osmfoundation.org/policies/nominatim/).

## Adding New GIS Tools

Register GIS tools on the Data Dashboard MCP server or on a standalone server.

### Example: Area Search Tool

```js
server.tool(
  'crow_search_area',
  'Find records within a geographic bounding box',
  {
    database: z.string().max(200).describe('Database to search'),
    lat_column: z.string().max(100).describe('Column containing latitude'),
    lon_column: z.string().max(100).describe('Column containing longitude'),
    north: z.number().min(-90).max(90),
    south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    west: z.number().min(-180).max(180),
    limit: z.number().int().min(1).max(10000).default(100),
  },
  async ({ database, lat_column, lon_column, north, south, east, west, limit }) => {
    const sql = `
      SELECT * FROM records
      WHERE ${lat_column} BETWEEN ? AND ?
        AND ${lon_column} BETWEEN ? AND ?
      LIMIT ?
    `;
    const results = await queryBackend(database, sql, [south, north, west, east, limit]);
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  }
);
```

### Example: Geocode-and-Store Tool

```js
server.tool(
  'crow_geocode_records',
  'Geocode addresses in a database column and store coordinates',
  {
    database: z.string().max(200),
    table: z.string().max(100),
    address_column: z.string().max(100),
    lat_column: z.string().max(100).default('latitude'),
    lon_column: z.string().max(100).default('longitude'),
    batch_size: z.number().int().min(1).max(100).default(10),
  },
  async ({ database, table, address_column, lat_column, lon_column, batch_size }) => {
    // Requires write mode enabled on the target database
    // Geocodes addresses in batches, writes coordinates back to the table
    // ...
  }
);
```

## Data Dashboard Integration

Nominatim integrates with the Data Dashboard as a panel tab plugin. When the bundle is installed, a **Map** tab appears in the Data Dashboard.

### How It Works

1. Run a query that includes latitude and longitude columns
2. Switch to the Map tab
3. Select the lat/lon columns from dropdowns
4. Results render as markers on a Leaflet map

The map tab is implemented as a [tab plugin](./data-dashboard#adding-panel-tabs-via-plugins) at `~/.crow/bundles/nominatim/dashboard-tabs/map-tab.js`.

### Geocoding from the Dashboard

The Map tab includes a geocode bar. Type an address to drop a pin on the map, or click a location to reverse-geocode it. Results can be used as filter parameters for subsequent queries.

## Next Steps

- [Data Dashboard](./data-dashboard) — Extending the dashboard generally
- [Creating Add-ons](./creating-addons) — Bundle development patterns
- [Bundles](./bundles) — Bundle architecture and lifecycle
