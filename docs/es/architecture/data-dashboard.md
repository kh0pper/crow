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

### Validación del primer token

Antes de ejecutar cualquier consulta, el motor extrae el primer token SQL y lo verifica contra una lista de permitidos:

```
Permitido (modo solo lectura): SELECT, WITH, EXPLAIN, PRAGMA
Permitido (modo escritura):    SELECT, WITH, EXPLAIN, PRAGMA, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP
```

Las consultas que comienzan con cualquier otro token se rechazan. Esto intercepta `ATTACH`, `DETACH`, `.import` y otras operaciones potencialmente peligrosas.

### Restricciones de rutas

Para los backends SQLite, la ruta del archivo de base de datos debe estar dentro de un directorio permitido:

- `~/.crow/data/`
- Cualquier ruta registrada explícitamente vía `crow_register_backend`
- Directorios de datos específicos de cada bundle (`~/.crow/bundles/*/data/`)

Los symlinks se resuelven antes de la verificación. Las rutas fuera de la lista de permitidos se rechazan.

### Timeouts

Cada consulta se ejecuta con un timeout de 30 segundos. El timeout se aplica a nivel del driver de la base de datos — la conexión se interrumpe si la consulta excede el límite. Esto evita que un `SELECT *` accidental sobre tablas de millones de filas bloquee el sistema.

### Modo escritura

El modo escritura está deshabilitado de forma predeterminada. Los usuarios pueden habilitarlo por base de datos a través del panel de configuración del Nest o pidiéndoselo a la IA:

```
"Habilita el acceso de escritura en mi base de datos de analítica"
```

El modo escritura requiere confirmación explícita. La IA advertirá antes de habilitarlo y confirmará la base de datos específica.

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
