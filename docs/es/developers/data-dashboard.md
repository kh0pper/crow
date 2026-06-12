---
title: Extender el Data Dashboard
description: Guía para desarrolladores sobre cómo agregar tipos de gráficos, exportadores personalizados, extensiones del motor de consultas y pestañas de panel al Data Dashboard.
---

# Extender el Data Dashboard

El Data Dashboard está diseñado para extenderse. Esta guía cubre los cuatro puntos de extensión principales: tipos de gráficos, exportadores, capacidades del motor de consultas y pestañas de panel.

## Agregar nuevos tipos de gráficos

El renderizado de gráficos usa Chart.js. Para agregar un nuevo tipo de gráfico:

### 1. Registra el tipo de gráfico

En `bundles/data-dashboard/panel/chart-renderer.js`, agrega tu tipo al registro `CHART_TYPES`:

```js
const CHART_TYPES = {
  bar: { label: 'Bar', icon: '...', minColumns: 2 },
  line: { label: 'Line', icon: '...', minColumns: 2 },
  pie: { label: 'Pie', icon: '...', minColumns: 2 },
  scatter: { label: 'Scatter', icon: '...', minColumns: 2 },
  // Agrega tu tipo:
  heatmap: { label: 'Heatmap', icon: '...', minColumns: 3 },
};
```

### 2. Agrega la lógica de renderizado

Agrega un case a la función `buildChartConfig()` que devuelva un objeto de configuración de Chart.js:

```js
case 'heatmap':
  return {
    type: 'matrix',  // Requiere el plugin chartjs-chart-matrix
    data: {
      datasets: [{
        data: transformToMatrix(queryResults, options),
        // ...
      }]
    },
    options: { /* ... */ }
  };
```

### 3. Maneja el renderizado del lado del servidor

Si el tipo de gráfico requiere un plugin de Chart.js, agrégalo al renderizador de canvas del lado del servidor en `chart-renderer.js`:

```js
import ChartjsMatrix from 'chartjs-chart-matrix';
Chart.register(ChartjsMatrix);
```

Agrega también el plugin a las dependencias del `package.json` en el directorio del bundle.

### 4. Actualiza la UI del panel

El selector de tipo de gráfico del panel se autopobla desde `CHART_TYPES`, así que no se necesitan cambios de UI a menos que tu tipo requiera campos de configuración personalizados.

## Exportadores personalizados

Los exportadores convierten los resultados de consultas en formatos descargables. Integrados: CSV, JSON.

### Agregar un exportador

Crea un módulo en `bundles/data-dashboard/exporters/`:

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
    // Devuelve un Buffer
    const workbook = buildWorkbook(queryResults);
    return workbook.toBuffer();
  }
};
```

Regístralo en el registro de exportadores:

```js
// bundles/data-dashboard/exporters/index.js
import xlsx from './xlsx.js';

export const exporters = [csv, json, xlsx];
```

El panel y las herramientas MCP detectan automáticamente los exportadores registrados.

## Extender el motor de consultas

### Agregar transformaciones de consultas

Las transformaciones de consultas modifican el SQL antes de su ejecución — útiles para agregar cláusulas `LIMIT` automáticas, registro de consultas o funciones personalizadas.

Agrega una transformación al pipeline en `server.js`:

```js
const transforms = [
  addDefaultLimit,      // Agrega LIMIT 1000 si no hay un LIMIT presente
  logQueryExecution,    // Registra en el historial de consultas
  // Agrega la tuya:
  addCustomFunctions,   // Registra funciones SQL personalizadas
];
```

Cada transformación recibe la cadena SQL y el contexto de conexión, y devuelve el SQL (posiblemente modificado):

```js
function addCustomFunctions(sql, context) {
  // Registra una función SQLite personalizada en la conexión
  context.db.function('geo_distance', (lat1, lon1, lat2, lon2) => {
    // Fórmula de Haversine
    return calculateDistance(lat1, lon1, lat2, lon2);
  });
  return sql;
}
```

### Soportar nuevos tipos de bases de datos

El motor de consultas actualmente soporta backends SQLite. Para agregar soporte para PostgreSQL, MySQL u otras bases de datos:

1. Crea un adaptador de driver en `bundles/data-dashboard/drivers/`
2. Implementa la interfaz `DatabaseDriver`: `connect()`, `execute(sql)`, `getSchema()`, `close()`
3. Registra el tipo de driver en `server.js`

El campo `type` del backend de datos (establecido durante `crow_register_backend`) determina qué driver se usa.

## Agregar pestañas de panel vía plugins

Los bundles de terceros pueden agregar pestañas al panel del Data Dashboard registrando un plugin de pestaña.

### Estructura de un plugin de pestaña

Coloca un módulo en `~/.crow/bundles/<your-bundle>/dashboard-tabs/`:

```js
// ~/.crow/bundles/geo-tools/dashboard-tabs/map-tab.js
export default {
  id: 'map',
  label: 'Map',
  icon: '<svg>...</svg>',
  order: 50,  // Posición después de las pestañas integradas

  async render({ req, db, queryResults }) {
    // Devuelve una cadena HTML para el contenido de la pestaña
    return `
      <div id="map-container" style="height: 500px;"></div>
      <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
      <script>
        const map = L.map('map-container').setView([30, -95], 6);
        // ... renderiza los resultados de la consulta como marcadores
      </script>
    `;
  }
};
```

Los plugins de pestaña se detectan automáticamente cuando se instala el bundle padre. Aparecen en la barra de pestañas junto a las pestañas integradas.

## Próximos pasos

- [Arquitectura del Data Dashboard](../architecture/data-dashboard) — Diseño interno y detalles del motor de consultas
- [Crear complementos](./creating-addons) — Guía general de desarrollo de complementos
- [Crear paneles](./creating-panels) — Patrones de desarrollo de paneles del Nest
- [Guía para desarrolladores de Nominatim](./nominatim) — Ejemplo de integración GIS
