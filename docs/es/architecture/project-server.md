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

### crow_web_search

Busca en la web con la API de Brave Search (`servers/shared/brave-search.js`, clave `BRAVE_API_KEY`, límite de 10 segundos). No obtiene ni guarda nada. Cada resultado lleva la marca `SNIPPET, not a source: open it with crow_add_source before citing`, y los resultados se recortan por entradas completas para que la respuesta quepa en el límite de resultados de voz. Sin clave de API, la herramienta dice que la búsqueda no está configurada y sugiere abrir una URL conocida con `crow_add_source`.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `query` | string | Sí | Consulta de búsqueda (hasta 400 caracteres) |
| `count` | number | No | Número de resultados, 1-10 (predeterminado: 5) |

### crow_fetch_source

Vuelve a abrir la URL de una fuente guardada (requiere la capacidad `write_sources` en su proyecto). Sirve para reintentar una obtención fallida o actualizar una copia antigua. Consulta [Verificar antes de citar](#verificar-antes-de-citar).

- Una fuente sin URL no tiene nada que obtener.
- Si la obtención falla o no encuentra texto legible, se conserva la copia anterior que tenía texto, y la fuente sigue siendo citable.
- Si la página no cambió (mismo hash de contenido), solo se actualiza `fetched_at`.
- Si la página cambió, el texto nuevo no se guarda mientras haya notas de cita que pasaron su comprobación con el texto anterior, salvo que el propietario pase `force: true`.
- Cuando se guarda texto nuevo, se vuelven a comprobar las notas de cita de la fuente, y se quita una verificación `quotes_checked` si una cita ya no está en la página.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `id` | number | Sí | ID de la fuente |
| `force` | boolean | No | Solo el propietario: reemplaza el texto guardado de la página aunque haya comprobaciones de citas que dependan de él |

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
| `id` | number | Sí | ID de la fuente |

### crow_verify_source

Verifica una fuente o quita su verificación. Con `quotes_checked`, la fuente queda verificada solo si tiene al menos una nota de cita y cada cita aparece en la página que Crow obtuvo. Consulta [Verificar una fuente](#verificar-una-fuente).

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `id` | number | Sí | ID de la fuente |
| `verified` | boolean | No | `true` para verificar (predeterminado), `false` para quitar la verificación |
| `method` | string | No | `quotes_checked` (predeterminado) o `manual_owner` (solo el propietario; los bots no pueden) |
| `notes` | string | No | Notas sobre la verificación |

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
| `provenance` | string | No | De dónde viene lo que dice la nota: `fetched`, `snippet` o `derived`. Obligatorio en las notas quote y summary; en analysis e insight el valor predeterminado es `derived`. Consulta [Procedencia de las notas](#procedencia-de-las-notas) |
| `locator` | string | No | Dónde está en la fuente (página, sección, marca de tiempo) |
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

## Verificar antes de citar

Crow abre por sí mismo la página de una fuente antes de que esta cuente como citable. Que un bot diga que leyó una página nunca se acepta sin comprobarlo.

### Estados de obtención

`research_sources.fetch_status` es uno de:

| Estado | Significado |
|---|---|
| `fetched` | Crow abrió la página y guardó su texto legible |
| `fetched_no_text` | Crow abrió la página pero no encontró texto legible (un PDF, una imagen, una página solo de scripts) |
| `failed` | Crow no pudo abrir la página; el motivo queda en `fetch_error` |
| `not_applicable` | La fuente no tiene URL (un libro, una entrevista), así que no hay nada que obtener |
| `legacy` | La fuente es anterior a esta función; se muestra como "legacy, unchecked" |
| `NULL` | La fila llegó de un par, de un recurso compartido o de un clon; aquí nunca se comprobó y no es citable aquí |

Una fuente es **citable** cuando su estado es `fetched`, `fetched_no_text` o `legacy`, o cuando es `not_applicable` y la dueña o el dueño la verificó a mano (`manual_owner`). Las bibliografías citan solo fuentes citables e indican cuántas se dejaron fuera; `include_unfetched` muestra el resto, marcadas `[NOT FETCHED: ...]`.

`crow_add_source` con una URL obtiene primero la página (con el obtenedor compartido protegido contra SSRF, `servers/shared/fetch-page.js`) y guarda la URL final, el código HTTP, un hash del contenido y el texto de la página. `crow_fetch_source` actualiza la copia guardada. Si una actualización no encuentra texto legible, se conserva la copia anterior; y si el texto nuevo rompería una verificación de cita que hoy pasa, se conserva el texto anterior salvo que el propietario pase `force: true`.

### Procedencia de las notas

Las notas de cita y de resumen indican de dónde viene la afirmación: `fetched` (respaldada por una página que Crow abrió), `snippet` (solo un fragmento de resultados de búsqueda, por lo que aún no se puede citar en el texto) o `derived` (razonamiento propio de quien escribe). Las notas de análisis y de idea usan `derived` por defecto. Una nota de cita sobre una fuente obtenida se comprueba contra el texto de la página y registra `quote_found` (1, 0, o NULL cuando la comprobación no pudo decidir) y un `locator`. La procedencia, `quote_found` y `locator` se quedan en local: están en `EXCLUDED_COLUMNS` (y se descartan en las filas entrantes) en `servers/sharing/instance-sync.js`, porque cada uno es un juicio sobre la copia de la página de esta instancia.

### Verificar una fuente

`crow_verify_source` registra en `verification_method` cómo se verificó una fuente:

- `quotes_checked` (predeterminado): la fuente necesita al menos una nota de cita, y todas las citas deben aparecer en la página guardada. Si la copia guardada tiene más de 30 días, Crow reabre primero la página y adopta el texto nuevo solo si todas las citas siguen coincidiendo. Si una cita falla más adelante, se borra la verificación `quotes_checked`; el registro de auditoría lo anota como `invalidated`.
- `manual_owner`: verifica el propietario a mano. Los bots no pueden. Es la única forma de verificar una fuente `not_applicable`.
- `legacy_flag`: la puso una sola vez la migración en filas que ya estaban marcadas como verificadas. Nunca se comprobó contra una página, por eso no se muestra como `[V]`.

### Quién es el propietario

El servidor de proyectos decide la identidad de quien llama cuando se construye, y el propietario tiene que ser explícito. `npm run mcp-config` marca la entrada generada de crow-projects con `CROW_ACTOR_KIND=owner`; una configuración de cliente escrita a mano necesita la misma variable de entorno para verificar a mano por stdio. Los montajes del gateway iniciados con `--no-auth`, los bots, las instancias pares y quien no dice nada nunca son el propietario. Las llamadas HTTP de un bot a los montajes `router`, `projects`, `research` y `tools` del gateway las bloquea la guarda de URL de pi-bots, así que un bot no puede llegar a la vía del propietario a través del gateway.

### Coincidencia de citas

`servers/research/quote-match.js` decide si una cita está en la página. Una cita cuenta como encontrada solo cuando su redacción exacta aparece en la página. Crow nunca reconstruye una cita editada.

- **Normalización:** ambos lados se igualan del mismo modo: Unicode NFKC, espacios, guiones suaves y caracteres de ancho cero, mayúsculas y minúsculas, y los estilos de comillas, guiones y apóstrofos. En la cita se recortan las comillas exteriores y un `.` `,` `;` `:` final; `?` y `!` se conservan, porque cambian lo que dice la frase.
- **Límites de palabra:** la coincidencia debe empezar y terminar en un límite de palabra. Las palabras con guion y los números como `2.5` o `1,500` cuentan como palabras completas.
- **Dónde busca:** primero el texto de Readability y después el cuerpo completo de la página. El resultado indica `body` cuando la coincidencia salió del cuerpo completo.
- **Ediciones permitidas en una cita:** `[sic]`, `[citation needed]` y un solo corchete con una letra mayúscula al inicio de una palabra (`[I]t`). Cualquier puntos suspensivos u otro corchete deja la comprobación en "no se pudo comprobar exactamente": cita el pasaje sin cortes o avisa al propietario. Las marcas de nota como `[3]` se ignoran solo en el lado de la página.
- **No se pudo comprobar:** una cita de más de 2,000 caracteres, de menos de 4 caracteres, o con demasiadas posiciones posibles en la página. Una página cortada por el límite de tamaño y sin coincidencia también es "no se pudo comprobar", nunca "no está en la página".
- **Atribución:** primero se prueba la cita completa. Solo si no se encuentra se descarta una cola final tras un guion o tras las comillas de cierre, y solo cuando la cola parece un nombre: dos o más palabras con mayúscula inicial, que no empiecen por palabras como The, Never o Not, con un `, Cargo` opcional. Pon a quien habla o la publicación en tu propia frase, no dentro de la cita.
- **Resultado:** encontrada (1), no encontrada (0) o no se pudo comprobar (NULL).

Límites conocidos: la coincidencia por subcadena no distingue cuando la propia página niega la frase citada, ni cuando la coincidencia viene de elementos de la página como un menú o un pie (el resultado indica entonces `body`).
