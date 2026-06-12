---
title: Guía de Nominatim para desarrolladores
description: Geocodificación autoalojada con Nominatim — configuración con Docker, cliente de la API de geocodificación, herramientas GIS e integración con el Panel de Datos.
---

# Guía de Nominatim para desarrolladores

Nominatim provee geocodificación autoalojada (de dirección a coordenadas) y geocodificación inversa (de coordenadas a dirección) usando datos de OpenStreetMap. Corre como un bundle de Crow con Docker.

## Configuración con Docker

El bundle de Nominatim usa la imagen Docker `mediagis/nominatim` con un extracto PBF preconstruido.

### Instala el bundle

```bash
crow bundle install nominatim
```

Esto crea `~/.crow/bundles/nominatim/` con un `docker-compose.yml` y la configuración predeterminada.

### Configura la región

Antes de iniciar, define la URL del extracto PBF en `~/.crow/bundles/nominatim/.env`:

```bash
# Extracto de Texas (~600 MB, se importa en ~30 minutos)
PBF_URL=https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf

# EE. UU. completo (~10 GB, se importa en varias horas)
# PBF_URL=https://download.geofabrik.de/north-america/us-latest.osm.pbf
```

Encuentra extractos en [download.geofabrik.de](https://download.geofabrik.de/).

### Inicia Nominatim

```bash
crow bundle start nominatim
```

El primer inicio toma tiempo — Nominatim importa el archivo PBF y construye su índice de búsqueda. Revisa el progreso:

```bash
docker logs -f crow-nominatim
```

El servicio está listo cuando veas `Nominatim is ready to accept requests`. La API queda disponible en `http://localhost:8080`.

### Actualizar los datos del mapa

Para actualizar con los datos más recientes de OSM:

```bash
crow bundle stop nominatim
# Elimina el volumen de datos existente
docker volume rm crow-nominatim-data
crow bundle start nominatim
```

Esto reimporta desde la URL del PBF configurada. Para actualizaciones incrementales, consulta la [documentación de Nominatim](https://nominatim.org/release-docs/latest/admin/Update/).

## Cliente de la API de geocodificación

El bundle incluye un módulo cliente de geocodificación para usarlo en herramientas MCP y en otro código de Crow:

```js
import { geocode, reverseGeocode } from '~/.crow/bundles/nominatim/geocoder.js';

// Dirección → coordenadas
const results = await geocode('1100 Congress Ave, Austin, TX');
// [{ lat: 30.2747, lon: -97.7404, display_name: '...', type: 'building' }]

// Coordenadas → dirección
const location = await reverseGeocode(30.2747, -97.7404);
// { address: { road: 'Congress Avenue', city: 'Austin', state: 'Texas', ... } }
```

El cliente se conecta por defecto a la instancia local de Nominatim. Configura el endpoint en `.env`:

```bash
NOMINATIM_URL=http://localhost:8080
```

### Límite de tasa

La instancia local no tiene límite de tasa. Si configuras un servidor Nominatim externo, el cliente respeta un límite de 1 solicitud por segundo conforme a la [política de uso](https://operations.osmfoundation.org/policies/nominatim/).

## Agregar nuevas herramientas GIS

Registra herramientas GIS en el servidor MCP del Panel de Datos o en un servidor independiente.

### Ejemplo: herramienta de búsqueda por área

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

### Ejemplo: herramienta de geocodificar y almacenar

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
    // Requiere el modo de escritura habilitado en la base de datos de destino
    // Geocodifica las direcciones en lotes y escribe las coordenadas de vuelta en la tabla
    // ...
  }
);
```

## Integración con el Panel de Datos

Nominatim se integra con el Panel de Datos como un plugin de pestaña del panel. Cuando el bundle está instalado, aparece una pestaña **Mapa** en el Panel de Datos.

### Cómo funciona

1. Ejecuta una consulta que incluya columnas de latitud y longitud
2. Cambia a la pestaña Mapa
3. Selecciona las columnas de lat/lon en los menús desplegables
4. Los resultados se muestran como marcadores en un mapa de Leaflet

La pestaña de mapa está implementada como un [plugin de pestaña](./data-dashboard) en `~/.crow/bundles/nominatim/dashboard-tabs/map-tab.js`.

### Geocodificación desde el dashboard

La pestaña Mapa incluye una barra de geocodificación. Escribe una dirección para colocar un pin en el mapa, o haz clic en una ubicación para geocodificarla de forma inversa. Los resultados pueden usarse como parámetros de filtro para consultas posteriores.

## Próximos pasos

- [Panel de Datos](./data-dashboard) — Cómo extender el dashboard en general
- [Crear complementos](./creating-addons) — Patrones de desarrollo de bundles
- [Bundles](./bundles) — Arquitectura y ciclo de vida de los bundles
