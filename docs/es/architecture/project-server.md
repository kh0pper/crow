# Servidor de Proyectos

El servidor de proyectos (`servers/research/`) ofrece gestión estructurada de proyectos con soporte para distintos tipos de proyecto, seguimiento de fuentes, generación de citas APA, salida de bibliografía y registro de backends de datos.

::: info Renombrado desde Servidor de Investigación
Este servidor se llamaba antes "crow-research". El nombre del servidor ahora es `crow-projects`, y la función de fábrica es `createProjectServer` (el antiguo nombre `createResearchServer` sigue funcionando como alias retrocompatible). El gateway lo monta en `/projects/mcp` (principal) y `/research/mcp` (alias heredado).
:::

## Tipos de proyecto

Los proyectos tienen un campo `type` que determina su propósito:

| Tipo | Descripción |
|---|---|
| `research` | Proyectos de investigación tradicionales con fuentes, citas y bibliografía (predeterminado) |
| `data_connector` | Proyectos que se conectan a datos externos a través de backends registrados |

El tipo se establece al crear el proyecto y determina qué herramientas y flujos de trabajo son relevantes.

## Herramientas

### crow_create_project

Crea un proyecto nuevo.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `name` | string | Sí | Nombre del proyecto |
| `description` | string | No | Descripción y objetivos del proyecto |
| `tags` | string | No | Etiquetas separadas por comas |
| `type` | string | No | Tipo de proyecto: `research` (predeterminado) o `data_connector` |

### crow_list_projects

Lista todos los proyectos con un filtro de estado opcional.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `status` | string | No | Filtrar por estado |

### crow_update_project

Actualiza el nombre, la descripción, el estado o las etiquetas de un proyecto.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `id` | number | Sí | ID del proyecto |
| `name` | string | No | Nombre nuevo |
| `description` | string | No | Descripción nueva |
| `status` | string | No | Estado nuevo (active, paused, completed, archived) |
| `tags` | string | No | Etiquetas nuevas |

### crow_add_source

Agrega una fuente a un proyecto. Genera automáticamente una cita APA si no se proporciona una. Se usa más comúnmente con proyectos de tipo `research`.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `title` | string | Sí | Título de la fuente |
| `source_type` | string | Sí | Tipo (ver la lista de abajo) |
| `project_id` | number | No | Asociarla a un proyecto |
| `url` | string | No | URL donde se encontró la fuente |
| `authors` | string | No | Autor(es) en formato "Last, F. M." |
| `publication_date` | string | No | Fecha de publicación (YYYY-MM-DD o YYYY) |
| `publisher` | string | No | Editorial o nombre del sitio web |
| `doi` | string | No | DOI (para artículos académicos) |
| `isbn` | string | No | ISBN (para libros) |
| `abstract` | string | No | Resumen (abstract) o descripción breve |
| `content_summary` | string | No | Resumen de los puntos y hallazgos clave |
| `full_text` | string | No | Texto completo, si está disponible |
| `citation_apa` | string | No | Cita APA manual (se autogenera si se omite) |
| `retrieval_method` | string | No | Cómo se obtuvo la fuente |
| `tags` | string | No | Etiquetas separadas por comas |
| `relevance_score` | number | No | Qué tan relevante es para el proyecto, 1-10 (predeterminado: 5) |

**Tipos de fuente**: `web_article`, `academic_paper`, `book`, `interview`, `web_search`, `web_scrape`, `api_data`, `document`, `video`, `podcast`, `social_media`, `government_doc`, `dataset`, `other`

### crow_search_sources

Busca fuentes usando búsqueda de texto completo.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `query` | string | Sí | Consulta de búsqueda |
| `source_type` | string | No | Filtrar por tipo |
| `project_id` | number | No | Filtrar por proyecto |
| `limit` | number | No | Máximo de resultados |

### crow_get_source

Obtiene los detalles completos de una fuente específica.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `source_id` | number | Sí | ID de la fuente |

### crow_verify_source

Marca el estado de verificación de una fuente.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `source_id` | number | Sí | ID de la fuente |
| `verified` | boolean | Sí | Estado de verificación |
| `verification_notes` | string | No | Notas sobre la verificación |

### crow_list_sources

Lista fuentes con filtrado opcional.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `project_id` | number | No | Filtrar por proyecto |
| `source_type` | string | No | Filtrar por tipo |
| `verified` | boolean | No | Filtrar por estado de verificación |
| `limit` | number | No | Máximo de resultados |

### crow_add_note

Agrega una nota, opcionalmente vinculada a un proyecto o a una fuente.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `content` | string | Sí | Contenido de la nota |
| `note_type` | string | No | Tipo: note, quote, summary, analysis, question, insight (predeterminado: note) |
| `project_id` | number | No | Proyecto asociado |
| `source_id` | number | No | Fuente asociada |
| `title` | string | No | Título de la nota |
| `tags` | string | No | Etiquetas separadas por comas |

### crow_search_notes

Busca notas por contenido.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `query` | string | Sí | Términos de búsqueda |
| `project_id` | number | No | Filtrar por proyecto |
| `note_type` | string | No | Filtrar por tipo (note, quote, summary, analysis, question, insight) |
| `limit` | number | No | Máximo de resultados (predeterminado: 10) |

### crow_generate_bibliography

Genera una bibliografía APA formateada para un proyecto o un conjunto filtrado de fuentes.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `project_id` | number | No | Generar la bibliografía de este proyecto |
| `tag` | string | No | Filtrar por etiqueta |
| `verified_only` | boolean | No | Incluir solo fuentes verificadas (predeterminado: false) |

### crow_project_stats

Obtiene estadísticas sobre los proyectos y el pipeline de investigación. Sin parámetros.

## Herramientas de backends de datos

Estas herramientas gestionan conexiones de datos externas para proyectos de tipo `data_connector`.

### crow_register_backend

Registra un servidor MCP externo como backend de datos.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `name` | string | Sí | Nombre del backend |
| `server_url` | string | Sí | URL del servidor MCP |
| `description` | string | No | Qué datos proporciona este backend |

### crow_list_backends

Lista todos los backends de datos registrados. Sin parámetros.

### crow_remove_backend

Elimina un backend de datos registrado.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `backend_id` | number | Sí | ID del backend |

### crow_backend_schema

Obtiene el esquema (las herramientas disponibles) de un backend registrado.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `backend_id` | number | Sí | ID del backend |

## Recursos

### research://projects

Devuelve la lista de todos los proyectos.

## Generación de citas APA

El servidor genera citas APA automáticamente al agregar fuentes. El formato de la cita varía según el tipo de fuente:

- **Artículos académicos**: `Author (Year). Title. Publisher. DOI/URL`
- **Libros**: `Author (Year). *Title*. Publisher.`
- **Artículos web**: `Author (Year). Title. Site Name. URL`
- **Otros tipos**: formato APA estándar con los campos disponibles
