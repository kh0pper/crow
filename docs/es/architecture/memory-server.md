# Servidor de Memoria

El servidor de memoria (`servers/memory/`) proporciona memoria persistente y buscable a través de las sesiones de IA.

## Herramientas

Esta página documenta las herramientas centrales de memoria. El servidor registra **24 herramientas en total** — el resto cubre el contexto conductual (secciones de crow.md), programaciones, notificaciones, recuperación proactiva (`crow_deep_recall`), mantenimiento de embeddings y análisis de salud de la memoria (`crow_dream`); consulta la lista de acciones por categoría en [Gestión de Contexto](./context-management).

### crow_store_memory

Almacena una nueva pieza de información en la memoria persistente.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `content` | string | Sí | La información a recordar |
| `category` | string | No | Categoría: general, project, preference, person, process, decision, learning, goal |
| `context` | string | No | Contexto adicional sobre cuándo/por qué se almacenó |
| `tags` | string | No | Etiquetas separadas por comas para filtrar |
| `source` | string | No | De dónde proviene esta información |
| `importance` | number | No | Puntuación de importancia 1-10 (predeterminado: 5) |

### crow_search_memories

Busca memorias usando búsqueda de texto completo (FTS5).

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `query` | string | Sí | Consulta de búsqueda |
| `category` | string | No | Filtrar por categoría |
| `min_importance` | number | No | Umbral mínimo de importancia (1-10) |
| `limit` | number | No | Máximo de resultados (predeterminado: 10) |

### crow_recall_by_context

Recupera memorias relevantes para un contexto dado. Usa el ranking de FTS5 para encontrar las memorias más relevantes.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `context` | string | Sí | El contexto contra el cual comparar |
| `limit` | number | No | Máximo de resultados (predeterminado: 5) |

### crow_list_memories

Lista memorias con filtrado y ordenamiento opcionales.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `category` | string | No | Filtrar por categoría |
| `tag` | string | No | Filtrar por etiqueta (coincidencia parcial) |
| `min_importance` | number | No | Umbral mínimo de importancia (1-10) |
| `sort_by` | string | No | Orden: recent, importance, accessed (predeterminado: recent) |
| `limit` | number | No | Máximo de resultados (predeterminado: 20) |

### crow_update_memory

Actualiza una memoria existente.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `id` | number | Sí | ID de la memoria a actualizar |
| `content` | string | No | Nuevo contenido |
| `category` | string | No | Nueva categoría |
| `tags` | string | No | Nuevas etiquetas |
| `importance` | number | No | Nueva puntuación de importancia |

### crow_delete_memory

Elimina una memoria por ID.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `id` | number | Sí | ID de la memoria a eliminar |

### crow_memory_stats

Obtiene estadísticas sobre las memorias almacenadas. Sin parámetros — devuelve conteos por categoría, distribución de etiquetas y el total de memorias.

## Recursos

### memory://categories

Devuelve la lista de categorías de memoria válidas.

## Base de datos

Las memorias se almacenan en la tabla `memories` con una tabla virtual FTS5 acompañante, `memories_fts`, para búsqueda de texto completo. Triggers de SQLite mantienen el índice FTS sincronizado en cada inserción, actualización y eliminación.
