# Contexto y rendimiento

Cada herramienta MCP que carga tu IA ocupa espacio en su ventana de contexto — la cantidad finita de texto que puede contener a la vez. Cuando conectas varios servidores e integraciones, esas definiciones de herramientas se acumulan, dejando menos espacio para tu conversación real. Esta guía explica por qué eso importa y qué puedes hacer al respecto.

## El problema

Piensa en la ventana de contexto de la IA como un escritorio de trabajo. Cada servidor MCP conectado deja una pila de manuales de herramientas sobre ese escritorio: nombres, descripciones, esquemas de parámetros. Cuantas más herramientas se cargan, menos espacio queda para la conversación misma.

El resultado: las respuestas pueden sentirse más lentas, la IA puede "olvidar" antes las partes iniciales de una conversación, y la calidad se degrada a medida que la ventana se llena. No es un problema exclusivo de Crow — afecta a cualquier configuración MCP — pero Crow te da opciones para gestionarlo.

## Cómo las herramientas MCP usan el contexto

Cuando un servidor MCP se conecta, cada herramienta que expone se serializa en el contexto de la IA. Eso significa el nombre de la herramienta, su descripción y el esquema completo de parámetros Zod — todo convertido a tokens de texto.

```
El servidor se conecta → se cargan 126 firmas de herramientas → ~25,000 tokens consumidos
```

Esos tokens se consumen antes de que escribas una sola palabra. Con una ventana de contexto de 200K tokens, 25,000 tokens es más del 12% de tu presupuesto gastado solo en definiciones de herramientas. Agrega unas cuantas integraciones externas y fácilmente puedes llegar al 30% o más.

## El inventario de herramientas de Crow

Los servidores centrales de Crow exponen más de 120 herramientas en total:

| Servidor | Herramientas | Ejemplos |
|--------|-------|---------|
| Memoria | 24 | `crow_store_memory`, `crow_search_memories`, `crow_recall_by_context` |
| Proyectos | 23 | `crow_create_project`, `crow_add_source`, `crow_generate_bibliography` |
| Blog | 23 | `crow_create_post`, `crow_publish_post`, `crow_blog_settings` |
| Compartición | 33 | `crow_generate_invite`, `crow_share`, `crow_inbox` |
| Almacenamiento | 8 | `crow_upload_file`, `crow_list_files`, `crow_delete_file` |
| Orquestador | 9 | `crow_orchestrate`, `crow_run_pipeline`, `crow_list_presets` |
| Consultoría | 6 | `crow_consulting_get`, `crow_consulting_stats` |
| **Total** | **126** | |

Cada integración externa (Obsidian, Home Assistant, Ollama, etc.) agrega 5-20+ herramientas adicionales encima de esto.

## Tus opciones

Crow ofrece tres modos de configuración que intercambian eficiencia de contexto por compatibilidad:

| Modo | Herramientas cargadas | Costo de contexto | Ideal para |
|------|-------------|-------------|----------|
| Router del gateway (`/router/mcp`) | 10 | ~3,000 tokens | Despliegues alojados, muchas integraciones |
| Núcleo combinado (`crow-core` stdio) | las herramientas de un servidor al inicio | ~6,000 tokens | Local/stdio, Raspberry Pi |
| Servidores individuales | 126+ | ~25,000+ tokens | Máxima compatibilidad, configuración simple |

### Router del gateway

El gateway expone un único endpoint MCP en `/router/mcp` con una **herramienta de categoría por servidor** consolidada — 10 herramientas en una instalación completa: `crow_memory`, `crow_projects`, `crow_blog`, `crow_sharing`, `crow_storage`, `crow_media`, `crow_orchestrator`, `crow_consulting`, más `crow_tools` (integraciones externas e instancias remotas) y `crow_discover` (consulta de esquemas). En lugar de cargar 126 definiciones de herramientas por adelantado, la IA llama a una herramienta de categoría con un parámetro `action` — `crow_memory` con `action: "store_memory"`, por ejemplo — y usa `crow_discover` para consultar bajo demanda las acciones disponibles y sus esquemas completos. Las definiciones de herramientas solo entran al contexto cuando realmente se necesitan.

### Núcleo combinado

El servidor stdio `crow-core` arranca con las herramientas de un solo servidor activas (memoria por defecto — `CROW_DEFAULT_SERVER` lo cambia) más tres herramientas de control, y activa otros servidores bajo demanda vía `crow_activate_server`. Un punto intermedio — menos herramientas que los servidores individuales, acceso más directo que el router.

### Servidores individuales

Cada servidor corre como una conexión MCP separada. Todas las herramientas están disponibles de inmediato, sin paso de descubrimiento. La configuración más simple, y la más compatible entre plataformas, pero con el costo de contexto más alto.

::: info Alias de nombres
Puede que veas dos nombres para lo mismo en configuraciones antiguas — son alias, no servidores distintos: el servidor de **proyectos** antes se llamaba **research** (`/research/mcp` sigue funcionando como alias de `/projects/mcp`, y el router acepta `crow_research` en lugar de `crow_projects`), y el endpoint `/mcp` a secas es un alias de compatibilidad para el servidor de memoria.
:::

## Recomendaciones por caso de uso

- **¿Apenas estás empezando?** Usa servidores individuales. La configuración es sencilla y el costo de contexto es manejable con solo las herramientas centrales de Crow.

- **¿Ejecutas muchas integraciones?** Cambia al router del gateway. Cuando tienes Obsidian, Home Assistant y otras integraciones apiladas sobre las 126 herramientas de Crow, el patrón de despacho por categorías del router mantiene el contexto ligero.

- **¿Estás en una Raspberry Pi o un dispositivo limitado?** Usa `crow-core`. Equilibra una sobrecarga baja con acceso directo a las herramientas — no requiere gateway HTTP.

- **Límites de contexto por plataforma a tener en cuenta:** Claude (200K tokens), ChatGPT (128K tokens), Gemini (varía según el modelo). Cuanto más pequeña sea tu ventana de contexto, más te ayuda un enfoque de router o combinado.

::: tip
No tienes que elegir un solo modo para todo. Algunos usuarios ejecutan servidores individuales localmente en Claude Code y el router del gateway para su instancia alojada.
:::

## Revisar tu uso de contexto

### Modo gateway

Consulta el endpoint `/health` de tu gateway. La respuesta incluye un objeto `toolCounts` que muestra cuántas herramientas expone cada servidor conectado:

```bash
curl http://localhost:3001/health
```

### Modo núcleo combinado

Usa la herramienta `crow_server_status` para ver qué grupos de herramientas están activos y cuántas herramientas están cargadas actualmente.

### Modo router

Usa `crow_discover` con una consulta amplia para ver las herramientas disponibles sin cargarlas todas al contexto.

---

Para los detalles de implementación sobre cómo Crow gestiona internamente la carga de herramientas y los presupuestos de contexto, consulta la [referencia de arquitectura de gestión de contexto](/architecture/context-management).
