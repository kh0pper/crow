---
title: Arquitectura del Panel de Datos
description: Arquitectura técnica del complemento Panel de Datos — motor de consultas, herramientas MCP, estructura del panel y pipeline de publicación al blog.
---

# Arquitectura del Panel de Datos

El Panel de Datos es un complemento (bundle) que proporciona exploración de bases de datos, consultas SQL, gráficos y publicación de estudios de caso. Esta página cubre la arquitectura interna.

Para instrucciones de uso, consulta la [Guía del Panel de Datos](/es/guide/data-dashboard).

## Estructura del bundle

```
bundles/data-dashboard/
  manifest.json           — Metadatos del complemento, dependencias, declaraciones de paneles/skills
  docker-compose.yml      — No requiere contenedores (se ejecuta en el mismo proceso)
  server.js               — Fábrica createDataDashboardServer() → McpServer
  index.js                — Punto de entrada del transporte stdio
  panel/
    data-dashboard.js     — Panel del Nest: UI de 4 pestañas (esquema, editor, gráficos, estudios de caso)
    chart-renderer.js     — Renderizado de Chart.js del lado del servidor
  skills/
    data-exploration.md   — Flujo de trabajo de IA para explorar y consultar bases de datos
    case-study.md         — Flujo de trabajo de IA para construir estudios de caso
```

El bundle registra:
- Un servidor MCP con 10 herramientas
- Un panel del Crow's Nest con 4 pestañas
- Dos archivos de skill para flujos de trabajo guiados por IA

## Motor de consultas

El motor de consultas ejecuta SQL contra los [backends de datos](/es/guide/data-backends) registrados. Aplica medidas de seguridad en múltiples niveles.

Todas las reglas viven en `servers/shared/sqlite-datasets.js`, compartido por el bundle, el bundle GIS y la API pública de incrustación del blog.

### Conexiones de solo lectura

Un conjunto de datos se abre con better-sqlite3 `readonly` más `PRAGMA query_only`, así que el propio SQLite rechaza cualquier escritura (incluidas asignaciones `PRAGMA` y `WITH … DELETE`). Debe ser una sola sentencia, de solo lectura según SQLite (`stmt.readonly`), que devuelva filas; una lista de palabras iniciales permitidas (`SELECT`, `WITH`, `EXPLAIN`, `PRAGMA`, `VALUES`) se mantiene como defensa adicional y también rechaza `ATTACH`.

### Restricciones de rutas

La ruta real de un conjunto de datos debe estar bajo `datasets/` o `projects/<id>/databases/` del directorio de datos de la instancia (comparada segmento a segmento, no como prefijo de texto). Las bases de datos del núcleo — `crow.db`, `tasks.db`, `CROW_DB_PATH`, cualquier `*.db` directamente en el directorio de datos — se rechazan por ruta real y por dispositivo e inodo, así que los enlaces no sirven para eludirlo.

### Límites de filas, tamaño y tiempo

Las filas se leen paso a paso y se detienen en el límite (5.000 filas, 8 MB serializados), diga lo que diga el texto SQL. Cada consulta y lectura de esquema corre en un proceso hijo de corta vida que se mata al llegar a su límite de tiempo (10 s); como máximo cuatro a la vez, y las demás se rechazan como ocupadas. El hijo limita su memoria V8 y la de SQLite (`PRAGMA hard_heap_limit`, 128 MB), así que un valor enorme falla allí. Los límites que pasa quien llama solo pueden bajarlos.

El archivo se abre con `O_NOFOLLOW` mientras SQLite lo abre, y después la ruta debe seguir resolviendo al mismo inodo.

### Sin escritura

`crow_data_write` está desactivada. El geocodificador por lotes GIS es el único que escribe, y solo en bases de datos creadas por el dashboard (`projects/<id>/databases/`), con identificadores entre comillas.

## Herramientas MCP

El servidor del Panel de Datos expone 10 herramientas:

| Herramienta | Descripción |
|---|---|
| `crow_list_databases` | Lista todos los backends de datos registrados con resúmenes de esquema |
| `crow_explore_schema` | Obtiene tablas, columnas, tipos y relaciones de una base de datos |
| `crow_run_query` | Ejecuta una consulta SQL y devuelve los resultados |
| `crow_save_query` | Guarda una consulta con nombre y descripción |
| `crow_list_saved_queries` | Lista las consultas guardadas, opcionalmente filtradas por base de datos |
| `crow_delete_saved_query` | Elimina una consulta guardada |
| `crow_create_chart` | Crea una configuración de gráfico a partir de los resultados de una consulta |
| `crow_create_case_study` | Crea un nuevo estudio de caso |
| `crow_update_case_study` | Agrega/elimina/reordena secciones de un estudio de caso |
| `crow_publish_case_study` | Convierte un estudio de caso en una entrada de blog |

Todas las herramientas siguen el patrón estándar de fábrica de servidores de Crow — `createDataDashboardServer(dbPath?, options?)` devuelve una instancia de `McpServer`.

## Pipeline de estudio de caso a blog

Publicar un estudio de caso lo convierte en una entrada del blog de Crow:

1. **Recopilar secciones** — Consulta las secciones del estudio de caso (narrativa, consultas, gráficos) en orden
2. **Ejecutar consultas** — Vuelve a ejecutar cada sección de consulta para obtener resultados frescos
3. **Renderizar gráficos** — Genera las imágenes de los gráficos del lado del servidor usando Chart.js (canvas de Node)
4. **Componer Markdown** — Ensambla el texto narrativo, las tablas de resultados (como tablas de Markdown) y las imágenes de gráficos (como base64 en línea o subidas al almacenamiento)
5. **Crear la entrada de blog** — Llama a `crow_create_post` con el Markdown compuesto, etiquetado con `case-study`
6. **Publicar** — Opcionalmente llama a `crow_publish_post` para hacerla pública de inmediato

El estudio de caso original se conserva. Volver a publicar regenera la entrada del blog con datos actualizados.

## Arquitectura del panel

El panel del Nest sigue el [patrón de paneles](/es/developers/creating-panels) estándar. Registra cuatro pestañas como sub-rutas:

- `/dashboard/data-dashboard` — Explorador de Esquemas (predeterminado)
- `/dashboard/data-dashboard?tab=editor` — Editor SQL
- `/dashboard/data-dashboard?tab=charts` — Gráficos
- `/dashboard/data-dashboard?tab=cases` — Estudios de Caso

Los gráficos se renderizan del lado del cliente usando Chart.js cargado desde un CDN. El editor usa un `<textarea>` con resaltado de sintaxis básico vía CSS — sin dependencias pesadas de editores.

## Próximos pasos

- [Guía del Panel de Datos](/es/guide/data-dashboard) — Documentación orientada al usuario
- [Extender el Panel de Datos](/es/developers/data-dashboard) — Agrega tipos de gráficos y exportadores
- [Crear Paneles](/es/developers/creating-panels) — Guía general de desarrollo de paneles
