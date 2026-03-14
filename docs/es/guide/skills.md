---
title: Uso de Skills
---

# Uso de Skills

Los skills son los flujos de trabajo que hacen a Crow útil. Definen lo que sucede cuando le pides algo a tu asistente de IA — cómo busca en tu memoria, gestiona investigaciones, publica entradas de blog u organiza tus notas.

No necesitas saber cómo funcionan los skills para usarlos. Solo habla de forma natural, y Crow activa el skill correcto automáticamente.

## Qué hacen los skills por ti

Cuando dices "investiga el cambio climático", Crow no simplemente busca en la web. Lo que hace es:

1. Revisar tu memoria en busca de investigaciones previas sobre el tema
2. Crear un proyecto de investigación para organizar los hallazgos
3. Buscar fuentes y generar citas correctas
4. Almacenar todo con referencias cruzadas

Todo ese flujo de trabajo está definido en un skill (`research-pipeline.md`). Sin él, tendrías que llamar cada herramienta de forma individual.

## Cómo activar los skills

Los skills se activan según lo que dices. No necesitas comandos especiales ni una sintaxis particular — solo describe lo que quieres:

| Lo que dices | Skill que se activa |
|---|---|
| "Recuerda esto para después" | Gestión de Memoria |
| "Investiga las tendencias de participación electoral" | Pipeline de Investigación |
| "Escribe una entrada de blog sobre..." | Blog |
| "Aquí están mis notas, organízalas" | Ideation |
| "Envíale un mensaje a Sara sobre la reunión" | Social (mensajería Nostr) |
| "Sube este archivo" | Storage |
| "Comparte mi investigación con Alex" | Sharing |
| "¿Qué puedes hacer?" | Tour de Bienvenida |
| "Respalda mis datos" | Backup |

Crow también entiende español y otros idiomas — la detección de intención no se basa en palabras clave, sino en el significado.

## Recorrido por los skills principales

### Gestión de Memoria

Crow almacena recuerdos automáticamente cuando compartes información importante, pero también puedes ser explícito:

> "Recuerda que prefiero citas en formato MLA para mis trabajos de historia"

> "¿Qué recuerdas sobre la remodelación de mi cocina?"

Los recuerdos persisten entre sesiones y plataformas. Si guardas algo mientras usas Claude, estará disponible cuando cambies a ChatGPT.

### Pipeline de Investigación

Inicia un proyecto de investigación con una solicitud simple:

> "Inicia un proyecto de investigación sobre almacenamiento de energía renovable"

Crow crea el proyecto y, a medida que encuentras fuentes:

> "Agrega este artículo como fuente: [URL]"

Genera citas automáticamente en formato APA, MLA, Chicago o web. Cuando termines:

> "Genera una bibliografía para mi proyecto de almacenamiento de energía en formato Chicago"

### Ideation (de notas a planes)

Pega un volcado de ideas y deja que Crow lo organice:

> "Aquí están mis notas de la reunión de hoy: [pegar notas]"

Crow agrupa tus notas por tema, las cruza con proyectos existentes, señala contradicciones y ofrece distribuirlas en proyectos o generar un plan de acción.

### Blog

Crea y publica entradas de forma conversacional:

> "Escribe una entrada de blog sobre mi excursión a Big Bend"

> "Publícala con la etiqueta 'viajes'"

Las entradas son privadas por defecto hasta que las publiques explícitamente.

### Sharing y Social

Comparte elementos con contactos mediante P2P cifrado:

> "Comparte mi investigación sobre el clima con Alex"

> "Mensaje para Sara: la fecha límite se movió al viernes"

Todos los mensajes usan cifrado de extremo a extremo vía Nostr.

## Flujos de trabajo compuestos

Los skills se combinan para tareas complejas. Antes de ejecutar un flujo de trabajo de varios pasos, Crow muestra un punto de control:

> **[crow checkpoint: Ejecutando "Resumen diario". Pasos: 1) Gmail 2) Calendario 3) Trello 4) Memoria. Di "saltar" para cancelar o "saltar paso N" para omitir un paso.]**

Ejemplos de flujos de trabajo compuestos:

- **"Resumen diario"** — Correo + calendario + tableros de tareas + recordatorios almacenados
- **"Prepárame para mi reunión sobre X"** — Detalles del calendario + hilos de correo + contexto de memoria + notas de investigación
- **"Inicia investigación sobre X"** — Revisión de memoria + creación de proyecto + búsqueda web + documentación de fuentes

## Personalización de skills

### Modificar un skill existente

Si un skill no funciona exactamente como quieres:

> "Crow, personaliza el skill de sharing para que no pida confirmación al compartir con mis contactos"

Crow copia el skill a `~/.crow/skills/` y aplica tus cambios. Tu versión tiene prioridad de forma permanente.

### Crear un skill nuevo

Describe lo que quieres automatizar:

> "Crow, crea un skill para mi rutina matutina. Revisa mi correo, resume el calendario de hoy y lista las tarjetas de Trello que vencen esta semana."

Crow propone el skill, pide tu aprobación y lo guarda. Se activa automáticamente a partir de ese momento.

### Eliminar un skill personalizado

> "Crow, elimina mi skill personalizado de sharing"

Esto restaura la versión original.

### Explorar los skills disponibles

Abre el panel de **Skills** en el Crow's Nest para ver todos los skills disponibles, o pregunta:

> "¿Qué skills tienes?"

## Puntos de control de seguridad

Ciertas acciones disparan confirmaciones de seguridad — Crow pregunta antes de hacer algo destructivo, que consuma muchos recursos o que modifique la red. Consulta la [guía de personalización](/guide/customization#safety-checkpoints) para más detalles.
