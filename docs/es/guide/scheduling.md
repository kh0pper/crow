---
title: Programación
---

# Programación y tareas recurrentes

Crow puede llevar el registro de tareas programadas y recurrentes. Pídele a tu IA que programe recordatorios, procesos recurrentes o cualquier actividad basada en tiempo.

## Cómo funciona

Crow almacena las programaciones en la base de datos con [expresiones cron](https://crontab.guru/) para los horarios. Las programaciones son accesibles desde todas las plataformas — crea una programación en Claude Desktop y aparecerá cuando te conectes desde ChatGPT o Gemini.

**Para usuarios autoalojados (Crow OS):** El gateway puede ejecutar las tareas programadas automáticamente vía el cron del sistema. El instalador lo configura durante la instalación.

**Para usuarios de nube/web:** Las programaciones se almacenan y se les da seguimiento, pero la ejecución depende de la sesión de IA. Al inicio de cada sesión, la IA revisa si hay programaciones pendientes o vencidas y te lo recuerda.

## Crear una programación

Solo pídelo con naturalidad:

> "Recuérdame respaldar mis datos cada domingo a las 3am"

> "Programa una revisión semanal del proyecto para los viernes por la tarde"

> "Configura un check-in diario a las 9am"

Crow crea una programación con la expresión cron apropiada. No necesitas saber la sintaxis de cron — la IA se encarga de la traducción.

## Gestionar programaciones

### Listar programaciones

> "Muéstrame mis tareas programadas"

> "¿Qué tareas recurrentes tengo configuradas?"

### Pausar o reanudar

> "Desactiva la programación del respaldo diario"

> "Vuelve a activar la programación #3"

### Cambiar el horario

> "Cambia la revisión del proyecto a los lunes en lugar de los viernes"

### Eliminar

> "Elimina la programación del check-in diario"

## Referencia de expresiones cron

Para usuarios avanzados que quieren especificar horarios exactos:

| Expresión | Significado |
|---|---|
| `0 9 * * *` | Todos los días a las 9:00 AM |
| `0 */6 * * *` | Cada 6 horas |
| `0 9 * * 1` | Cada lunes a las 9:00 AM |
| `0 3 * * 0` | Cada domingo a las 3:00 AM |
| `0 9 1 * *` | El primer día de cada mes a las 9:00 AM |
| `*/30 * * * *` | Cada 30 minutos |

## Referencia de herramientas

La función de programación usa tres herramientas MCP:

| Herramienta | Propósito |
|---|---|
| `crow_create_schedule` | Crear una nueva programación (tarea, expresión cron, descripción) |
| `crow_list_schedules` | Listar todas las programaciones, con la opción de filtrar solo las activas |
| `crow_update_schedule` | Actualizar o eliminar una programación por ID |
