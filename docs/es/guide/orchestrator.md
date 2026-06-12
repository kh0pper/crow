# Orquestador (Equipos de Agentes)

Ejecuta equipos de agentes de IA que colaboran en un objetivo usando tus datos de Crow — buscando memorias, leyendo proyectos, escribiendo resúmenes — y programa trabajos recurrentes que mantienen tu base de conocimiento ordenada mientras duermes.

## ¿Qué es esto?

El orquestador convierte una sola solicitud en un esfuerzo de equipo coordinado. Le das un objetivo en lenguaje natural; un agente coordinador lo divide en tareas y se las entrega a agentes trabajadores, cada uno equipado solo con las herramientas de Crow que su rol necesita. El equipo comparte hallazgos y el coordinador sintetiza una respuesta final.

## ¿Por qué querría esto?

- **Investigación de varios pasos** — un agente escarba en tus memorias y fuentes de proyecto mientras otro redacta lo que encuentra
- **Mantenimiento recurrente** — un pipeline nocturno encuentra memorias duplicadas o contradictorias para que tu recuperación se mantenga afinada
- **Resúmenes programados** — un resumen diario de actividad, o una revisión semanal de todos los proyectos activos, entregado como una memoria sin que lo pidas

## Ejecutar un Equipo

Pídele a tu cliente de IA que orqueste — usa la herramienta `crow_orchestrate` tras bambalinas:

```
"Orquesta un equipo de investigación sobre: ¿qué dicen mis notas sobre el cumplimiento de FERPA?"
```

La ejecución arranca en segundo plano y devuelve un ID de trabajo. Pregunta por el estado en cualquier momento:

```
"Revisa esa orquestación"
→ crow_orchestrate_status({ jobId: "..." })
```

### Elegir un Preset de Equipo

Los presets son configuraciones de equipo listas para usar. Pregunta "lista los presets del orquestador" (`crow_list_presets`) para ver todo lo disponible en tu instancia. Los de propósito general:

| Preset | Qué hace |
|---|---|
| `research` | Un agente busca en memorias y proyectos, otro sintetiza los hallazgos |
| `memory_ops` | Un solo analista busca, consolida y organiza memorias |
| `full` | Investigador + escritor de memorias + sintetizador con acceso amplio a herramientas |
| `code_team`, `vision_team`, `deep_synthesis` | Equipos especializados para trabajo de código, imagen y síntesis profunda |

Hay presets adicionales que impulsan los bots del Bot Builder y flujos de trabajo específicos de cada instancia — también aparecen en la lista, pero rara vez los llamarás directamente.

## Pipelines: Ejecuciones de Equipo Programadas

Los pipelines son combinaciones predefinidas de objetivo + preset que pueden correr con un horario. Los integrados:

| Pipeline | Horario Predeterminado | Qué hace |
|---|---|---|
| `memory-consolidation` | Diario a las 3am | Encuentra memorias duplicadas y contradictorias |
| `daily-summary` | Diario a las 10pm | Resume la actividad del día |
| `research-digest` | Semanal, lunes 9am | Revisa todos los proyectos activos |

Ejecuta uno de inmediato, o ponlo en el calendario — ambas cosas en lenguaje natural:

```
"Ejecuta el pipeline de consolidación de memorias ahora"
→ crow_run_pipeline({ pipeline: "memory-consolidation" })

"Programa el resumen diario"
→ crow_schedule_pipeline({ pipeline: "daily-summary" })

"Ejecuta la consolidación de memorias cada domingo a las 2am"
→ crow_schedule_pipeline({ pipeline: "memory-consolidation", cron_expression: "0 2 * * 0" })
```

Los resultados de los pipelines se guardan como memorias de Crow (etiquetadas `pipeline,automated`), así que la salida cae en la misma base de conocimiento buscable que todo lo demás.

## Verlo Trabajar

Abre **Orchestrator** en el dashboard Crow's Nest para una línea de tiempo en vivo de cada ejecución: qué agentes se despacharon, qué modelo usó cada uno, conteos de tokens, duraciones y cualquier error. Es la vista de un nivel más abajo — no la necesitas para que la orquestación funcione, pero ahí está cuando tengas curiosidad por lo que realmente pasó.

## ¿Qué Modelo Usa?

Por defecto, la misma configuración de proveedor que el chat de IA de Crow (`models.json`). Dos variables de entorno sobreescriben el valor predeterminado para la orquestación: `CROW_ORCHESTRATOR_PROVIDER` y `CROW_ORCHESTRATOR_MODEL`. Los agentes individuales dentro de un preset pueden fijar su propio proveedor/modelo, así que un equipo puede mezclar modelos locales y en la nube en una sola ejecución.

## Próximos Pasos

- [Arquitectura del orquestador](/es/architecture/orchestrator) — presets, el puente MCP, herramientas de instancias remotas e internos
- [Guía de programación](/es/guide/scheduling) — cómo funcionan los horarios de Crow en general
- [Contexto y Rendimiento](/es/guide/context-performance) — cómo encajan las herramientas del orquestador en el presupuesto de contexto de tu IA
