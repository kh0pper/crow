# Servidor Orquestador

El servidor orquestador (`servers/orchestrator/`) provee orquestación multiagente, permitiendo que equipos de agentes de IA colaboren en metas complejas usando las herramientas MCP de Crow.

> ¿Buscas el recorrido de cara al usuario (ejecutar equipos, programar pipelines, monitorear)? Consulta la [guía del Orquestador](/es/guide/orchestrator). Esta página cubre los detalles internos.

Impulsado por el motor [open-multi-agent](https://github.com/kh0pper/open-multi-agent), el orquestador conecta las herramientas existentes de Crow (memoria, proyectos, blog, compartición) en un registro de herramientas compartido al que múltiples agentes pueden acceder simultáneamente.

## Cómo funciona

```
Meta del usuario → Agente coordinador → Descomposición en tareas
                                      ↓
                            Pool de agentes worker
                  (cada uno con herramientas apropiadas a su rol)
                                      ↓
                Memoria compartida + resultados de herramientas
                                      ↓
                      El coordinador sintetiza la salida
```

1. Tú provees una **meta** (texto plano) y seleccionas un **preset** (configuración de equipo)
2. Un **agente coordinador** descompone la meta en tareas y las asigna a los agentes worker
3. Cada **agente worker** tiene acceso a un conjunto curado de herramientas MCP de Crow relevantes para su rol
4. Los workers ejecutan las tareas, llamando herramientas y compartiendo resultados vía la memoria compartida
5. El coordinador sintetiza todos los hallazgos en una salida final

## Herramientas

### crow_orchestrate

Inicia un equipo multiagente sobre una meta. Se ejecuta de forma asíncrona y devuelve un ID de trabajo de inmediato.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `goal` | string | Sí | La meta de alto nivel para el equipo de agentes |
| `preset` | string | No | Nombre del preset de equipo (predeterminado: "research") |

### crow_orchestrate_status

Consulta el estado de un trabajo de orquestación en ejecución.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `jobId` | string | Sí | ID de trabajo devuelto por crow_orchestrate |

Devuelve `{ status: "running" | "completed" | "failed", result?, error? }`.

### crow_list_presets

Lista todos los presets de equipo disponibles con sus descripciones, proveedor, modelo y nombres de agentes. Sin parámetros.

### crow_run_pipeline

Ejecuta un pipeline con nombre de inmediato. Como crow_orchestrate, pero usa una meta predefinida.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `pipeline` | string | Sí | Nombre del pipeline (p. ej. "memory-consolidation") |

### crow_schedule_pipeline

Programa un pipeline para ejecutarse con un horario cron. Crea una entrada en la tabla de schedules de Crow.

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `pipeline` | string | Sí | Nombre del pipeline |
| `cron_expression` | string | No | Expresión cron (por defecto, el horario integrado del pipeline) |
| `description` | string | No | Descripción opcional que reemplaza la predeterminada |

### crow_list_pipelines

Lista todos los pipelines disponibles con descripciones y horarios predeterminados. Sin parámetros.

### crow_list_remote_tools

Lista las herramientas disponibles en instancias remotas de Crow. Muestra las instancias conectadas y sus herramientas expuestas. Sin parámetros.

## Presets

Los presets definen configuraciones de equipo. Los presets son agnósticos al proveedor por defecto; el proveedor LLM se resuelve desde la variable de entorno `CROW_ORCHESTRATOR_PROVIDER` o el primer proveedor en `models.json`.

| Preset | Descripción | Agentes |
|---|---|---|
| `research` | Equipo de investigación con búsqueda en memoria/proyectos y escritura | researcher (18 herramientas), writer (sin herramientas) |
| `memory_ops` | Análisis, consolidación y organización de memorias | analyst (11 herramientas) |
| `full` | Equipo amplio con investigación, escritura de memorias y síntesis | researcher (15 herramientas), memory_writer (4 herramientas), writer (sin herramientas) |

El arreglo `tools` de cada agente lista las herramientas específicas relevantes para su rol. El agente coordinador (creado automáticamente por el motor) siempre recibe `tools: []`, de modo que solo descompone metas sin llamar herramientas.

### Agregar un preset

Los presets viven en módulos bajo `servers/orchestrator/presets/` — `core.js` (equipos generales), `mpa.js`, `teams.js`, `bot-job-search.js`, `bot-trackers.js`, con constantes compartidas en `shared.js`. El punto de entrada `servers/orchestrator/presets.js` los expande en un único objeto `presets` (el orden del spread está congelado — los consumidores pueden iterar `Object.keys(presets)`).

Agrega una entrada al módulo que corresponda a tu preset (p. ej. `servers/orchestrator/presets/core.js`):

```javascript
export const corePresets = {
  my_preset: {
    description: "Qué hace este equipo",
    categories: ["memory", "projects"],  // qué servidores MCP conectar
    agents: [
      {
        name: "worker",
        systemPrompt: "Eres un agente especializado...",
        tools: ["crow_search_memories", "crow_list_memories", "crow_store_memory"],
        maxTurns: 6,
      },
    ],
  },
}
```

Lista las herramientas que cada agente realmente necesita para su rol. Los agentes que no deben llamar herramientas (escritores, sintetizadores) usan `tools: []`.

### Overrides de proveedor por agente

Los agentes individuales pueden usar distintos proveedores LLM dentro de la misma orquestación:

```javascript
{
  name: "researcher",
  provider: "zai",     // reemplaza el proveedor predeterminado
  model: "glm-5",      // reemplaza el modelo predeterminado
  tools: [...],
}
```

Esto habilita orquestaciones híbridas donde algunos agentes corren en modelos locales y otros en APIs en la nube.

## Pipelines

Los pipelines son combinaciones predefinidas de meta + preset que pueden ejecutarse con un horario.

| Pipeline | Horario predeterminado | Preset | Descripción |
|---|---|---|---|
| `memory-consolidation` | Diario a las 3am | memory_ops | Encuentra memorias duplicadas y en conflicto |
| `daily-summary` | Diario a las 10pm | research | Resume la actividad del día |
| `research-digest` | Semanal, lunes 9am | research | Revisa todos los proyectos activos |

Los resultados de los pipelines se almacenan automáticamente como memorias de Crow (categoría según la configuración del pipeline, etiquetadas `pipeline,automated`).

### Programar un pipeline

```
"Programa el pipeline daily-summary"
→ crow_schedule_pipeline({ pipeline: "daily-summary" })
→ Usa el cron predeterminado: "0 22 * * *"

"Ejecuta la consolidación de memorias cada domingo a las 2am"
→ crow_schedule_pipeline({ pipeline: "memory-consolidation", cron_expression: "0 2 * * 0" })
```

El ejecutor de pipelines consulta la tabla de schedules cada 60 segundos buscando entradas con prefijo `pipeline:` y las ejecuta cuando les toca.

## Puente MCP

El puente MCP (`servers/orchestrator/mcp-bridge.js`) conecta los servidores MCP de Crow con el motor de orquestación:

1. Crea clientes MCP en proceso vía `InMemoryTransport` (el mismo patrón que el ejecutor de herramientas del gateway)
2. Lista todas las herramientas de cada servidor conectado
3. Registra cada herramienta en el `ToolRegistry` compartido con:
   - `z.any()` como esquema Zod (passthrough, sin validación del lado del cliente)
   - `rawInputSchema` establecido al JSON Schema real de la herramienta (enviado al LLM para la generación de parámetros)
4. La ejecución de herramientas llama de vuelta al servidor a través del cliente MCP

El filtrado de categorías por preset asegura que solo se conecten los servidores necesarios (p. ej., el preset `research` solo conecta memoria y proyectos, no compartición ni blog).

## Herramientas de instancias remotas

Los presets pueden incluir `"remote"` en su arreglo `categories` para acceder a herramientas en instancias remotas de Crow conectadas. Las herramientas remotas se registran con nombres con espacio de nombres, como `colibri:ha_light_toggle`.

```javascript
{
  description: "Domótica con herramientas remotas",
  categories: ["memory", "remote"],
  agents: [{
    name: "controller",
    tools: ["colibri:ha_light_toggle", "colibri:ha_status"],
    // o usa el comodín: tools: ["colibri:*"]
  }],
}
```

El comodín `"instance:*"` se expande a todas las herramientas de esa instancia al momento de la orquestación.

Las conexiones a herramientas remotas provienen del map `connectedServers` del gateway (poblado por `proxy.js` desde la tabla `crow_instances`). El orquestador lo recibe vía inyección de dependencias, así que funciona en modo gateway pero se degrada con gracia en modo stdio (sin herramientas remotas disponibles).

## Configuración del LLM

El orquestador lee `models.json` (el mismo archivo de configuración que el chat de IA principal de Crow) para resolver los endpoints de los proveedores. Configúralo vía variables de entorno:

- `CROW_ORCHESTRATOR_PROVIDER` — nombre del proveedor predeterminado (con respaldo al primer proveedor en models.json)
- `CROW_ORCHESTRATOR_MODEL` — ID del modelo predeterminado (con respaldo al primer modelo del proveedor resuelto)

Configuraciones clave:
- `maxConcurrency` es 1 por defecto, configurable por preset
- `maxTokens` es 8192 por defecto, configurable por agente o por preset
- Timeout de 5 minutos en todas las orquestaciones
- Verificación de salud de los proveedores con `baseURL` antes de iniciar (consulta el endpoint `/health`)
