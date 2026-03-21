---
title: Extending the Data Dashboard
description: Developer guide for adding chart types, custom exporters, query engine extensions, and panel tabs to the Data Dashboard.
---

# Extending the Data Dashboard

The Data Dashboard is designed to be extended. This guide covers the four main extension points: chart types, exporters, query engine capabilities, and panel tabs.

## Adding New Chart Types

Chart rendering uses Chart.js. To add a new chart type:

### 1. Register the Chart Type

In `bundles/data-dashboard/panel/chart-renderer.js`, add your type to the `CHART_TYPES` registry:

```js
const CHART_TYPES = {
  bar: { label: 'Bar', icon: '...', minColumns: 2 },
  line: { label: 'Line', icon: '...', minColumns: 2 },
  pie: { label: 'Pie', icon: '...', minColumns: 2 },
  scatter: { label: 'Scatter', icon: '...', minColumns: 2 },
  // Add your type:
  heatmap: { label: 'Heatmap', icon: '...', minColumns: 3 },
};
```

### 2. Add the Rendering Logic

Add a case to the `buildChartConfig()` function that returns a Chart.js configuration object:

```js
case 'heatmap':
  return {
    type: 'matrix',  // Requires chartjs-chart-matrix plugin
    data: {
      datasets: [{
        data: transformToMatrix(queryResults, options),
        // ...
      }]
    },
    options: { /* ... */ }
  };
```

### 3. Handle Server-Side Rendering

If the chart type requires a Chart.js plugin, add it to the server-side canvas renderer in `chart-renderer.js`:

```js
import ChartjsMatrix from 'chartjs-chart-matrix';
Chart.register(ChartjsMatrix);
```

Also add the plugin to `package.json` dependencies in the bundle directory.

### 4. Update the Panel UI

The chart type selector in the panel auto-populates from `CHART_TYPES`, so no UI changes are needed unless your type requires custom configuration fields.

## Custom Exporters

Exporters convert query results into downloadable formats. Built-in: CSV, JSON.

### Adding an Exporter

Create a module in `bundles/data-dashboard/exporters/`:

```js
// bundles/data-dashboard/exporters/xlsx.js
export default {
  id: 'xlsx',
  label: 'Excel (.xlsx)',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  extension: '.xlsx',

  async export(queryResults, options) {
    // queryResults.columns: string[]
    // queryResults.rows: object[]
    // Return a Buffer
    const workbook = buildWorkbook(queryResults);
    return workbook.toBuffer();
  }
};
```

Register it in the exporter registry:

```js
// bundles/data-dashboard/exporters/index.js
import xlsx from './xlsx.js';

export const exporters = [csv, json, xlsx];
```

The panel and MCP tools automatically pick up registered exporters.

## Extending the Query Engine

### Adding Query Transforms

Query transforms modify SQL before execution — useful for adding automatic `LIMIT` clauses, query logging, or custom functions.

Add a transform to the pipeline in `server.js`:

```js
const transforms = [
  addDefaultLimit,      // Add LIMIT 1000 if no LIMIT present
  logQueryExecution,    // Log to query history
  // Add yours:
  addCustomFunctions,   // Register custom SQL functions
];
```

Each transform receives the SQL string and connection context, and returns the (possibly modified) SQL:

```js
function addCustomFunctions(sql, context) {
  // Register a custom SQLite function on the connection
  context.db.function('geo_distance', (lat1, lon1, lat2, lon2) => {
    // Haversine formula
    return calculateDistance(lat1, lon1, lat2, lon2);
  });
  return sql;
}
```

### Supporting New Database Types

The query engine currently supports SQLite backends. To add support for PostgreSQL, MySQL, or other databases:

1. Create a driver adapter in `bundles/data-dashboard/drivers/`
2. Implement the `DatabaseDriver` interface: `connect()`, `execute(sql)`, `getSchema()`, `close()`
3. Register the driver type in `server.js`

The data backend's `type` field (set during `crow_register_backend`) determines which driver is used.

## Adding Panel Tabs via Plugins

Third-party bundles can add tabs to the Data Dashboard panel by registering a tab plugin.

### Tab Plugin Structure

Place a module in `~/.crow/bundles/<your-bundle>/dashboard-tabs/`:

```js
// ~/.crow/bundles/geo-tools/dashboard-tabs/map-tab.js
export default {
  id: 'map',
  label: 'Map',
  icon: '<svg>...</svg>',
  order: 50,  // Position after built-in tabs

  async render({ req, db, queryResults }) {
    // Return HTML string for the tab content
    return `
      <div id="map-container" style="height: 500px;"></div>
      <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
      <script>
        const map = L.map('map-container').setView([30, -95], 6);
        // ... render query results as markers
      </script>
    `;
  }
};
```

Tab plugins are auto-discovered when the parent bundle is installed. They appear in the tab bar alongside the built-in tabs.

## Next Steps

- [Data Dashboard Architecture](../architecture/data-dashboard) — Internal design and query engine details
- [Creating Add-ons](./creating-addons) — General add-on development guide
- [Creating Panels](./creating-panels) — Nest panel development patterns
- [Nominatim Developer Guide](./nominatim) — GIS integration example
