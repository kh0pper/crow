---
title: Bot Builder
---

# Bot Builder

El Bot Builder es donde compones y ejecutas tus propios agentes de IA. Un agente (un "bot") es una persona más los skills, herramientas, gateways y permisos que le das. Todo se configura desde el dashboard Crow's Nest en un editor con pestañas, sin archivos de configuración que editar a mano y sin una herramienta de administración aparte.

El Bot Builder es la columna vertebral agéntica de Crow. El mismo agente que construyes aquí puede responder tu correo, chatear en Discord o funcionar manos libres en tus lentes, apoyándose en la memoria, los proyectos, los archivos de Crow y cualquier integración que tengas instalada.

## Qué es un agente

Un agente es una definición con varias partes, cada una en su propia pestaña del editor:

| Parte | Qué controla |
|---|---|
| **AI / Modelos** | El modelo de chat que usa el agente, más un modelo de voz rápido opcional para los lentes y los perfiles de habla y visión con los que se expresa. |
| **Herramientas y Extensiones** | Exactamente qué herramientas puede llamar el agente: las propias herramientas de memoria, proyectos, blog y almacenamiento de Crow, más las herramientas aportadas por cualquier extensión instalada. |
| **Skills y Prompt** | La persona del agente (system prompt) y los skills adjuntos a él. Los skills son prompts conductuales que enseñan un flujo de trabajo. |
| **Gateways** | Los canales en los que corre el agente: Gmail, Discord o lentes Meta. |
| **Permisos / Seguridad** | Lo que el agente puede hacer por su cuenta, lo que necesita confirmación y lo que se le niega. También el interruptor opt-in de autoescritura. |
| **Proyecto / Kanban** | Un proyecto opcional sobre el que trabaja el agente. |
| **Revisar / Desplegar** | Un resumen de la definición antes de guardarla y desplegarla. |

Guardar una pestaña fusiona solo los campos de esa pestaña en la definición, así que un guardado nunca pisa las demás pestañas.

## Herramientas y extensiones

Cada agente solo ve las herramientas que le otorgas. La pestaña de Herramientas lista las categorías de herramientas integradas de Crow junto a las herramientas aportadas por cada extensión instalada, agrupadas por extensión con una insignia de estado de instalación.

Cuando seleccionas las herramientas de una extensión, el Bot Builder conecta esa extensión al agente automáticamente. No editas entradas de servidores MCP a mano. Si una extensión provee una herramienta que el canal del agente no puede alcanzar (por ejemplo, una herramienta sin equivalente de voz en la ruta de los lentes), el editor te advierte en lugar de descartarla en silencio.

## Skills

Los skills son prompts conductuales (archivos Markdown con un pequeño encabezado de front-matter) que le enseñan a un agente un flujo de trabajo específico. Adjúntalos en la pestaña de Skills, agrupados por la extensión que los provee. Una tarjeta destacada de "Skill authoring" te permite adjuntar la guía de escritura de skills de Crow a un agente con un clic.

Los skills son portables entre agentes y entre canales. Las variantes de idioma (inglés, español, etcétera) son simplemente archivos de skill distintos que llaman a las mismas herramientas subyacentes.

## Gateways: un agente, los canales que elijas

Un gateway conecta un agente con un lugar donde la gente habla con él. La misma definición de agente puede correr en más de un canal.

- **Gmail**: El agente lee y responde correo en un buzón conectado.
- **Discord**: El agente se une a un servidor de Discord como bot y responde en canales y mensajes directos, con una lista de usuarios permitidos por agente.
- **Lentes Meta**: Un par de lentes Ray-Ban Meta (Gen 2) emparejados se vincula a un agente. Ese agente entonces dirige el turno de voz rápido: su persona, sus skills, sus herramientas delimitadas y sus permisos, hablados a través de los perfiles de habla y voz que elegiste. Consulta la [guía de Lentes Meta](/es/guide/meta-glasses).
- **Crow Messages**: El agente se vuelve accesible como un contacto. Las personas que invites pueden enviarle mensajes, puedes explorar y agregar los bots que corren en tus Crows, y puedes reunir a personas y bots en una sala grupal. Consulta la [guía de Crow Messages](/es/guide/crow-messages).

Vincular los lentes a un agente es uno a uno: un dispositivo dirige un agente a la vez, y elegir un nuevo agente para un dispositivo libera el vínculo anterior.

## Permisos y seguridad

Cada agente lleva una política de permisos que gobierna lo que puede hacer sin preguntar:

- **Confirmar**: Las acciones nombradas requieren un paso de confirmación antes de ejecutarse.
- **Denegar**: Las acciones nombradas se rechazan de plano.
- **Salidas solo en borrador**: Los envíos y publicaciones salientes se degradan. Una publicación de blog se convierte en borrador, y un envío real (como un correo) se bloquea y se reporta, de modo que un agente no puede hablar con el mundo exterior en tu nombre a menos que lo permitas.

Estas reglas se aplican sobre la acción subyacente, no solo sobre el nombre superficial de la herramienta. Si un agente intenta alcanzar una acción protegida a través de un envoltorio de herramienta de propósito general, la política se aplica igual. En la ruta de voz, la misma compuerta corre antes de que se ejecute cualquier herramienta, y una acción bloqueada se te comunica en voz alta.

## Autoescritura opt-in

Un agente puede ayudar a escribir sus propios skills, pero solo si tú lo activas. La autoescritura está **desactivada por defecto**.

Cuando la habilitas para un agente:

1. El agente puede **redactar** un nuevo archivo de skill en un área de preparación confinada que pertenece a ese agente. El borrador es inerte. No se carga, no se adjunta al agente y no puede surtir efecto.
2. El skill redactado aparece en el Bot Builder para revisión. Puedes leerlo, editar el texto y aprobarlo o rechazarlo. Cualquier redacción que pudiera debilitar una salvaguarda se marca para tu atención.
3. Al aprobarlo, Crow promueve el skill a tu biblioteca de skills y lo adjunta al agente. Solo entonces se carga.

Un skill autoescrito es solamente texto de prompt. Aprobar uno no puede otorgarle al agente nuevas herramientas ni cambiar su política de permisos, porque esas vienen de las pestañas de Herramientas y Permisos, no de un skill. La compuerta de aprobación del operador es el límite.

Este es el núcleo de la postura de Crow frente a las plataformas de bots con autoescritura automática: un agente puede proponer, pero un humano aprueba antes de que cualquier cosa que un agente escribió para sí mismo se vuelva real.

## Trabajo profundo

Para tareas que toman más de un turno, un agente puede pasarle trabajo al orquestador de Crow. El agente reconoce la solicitud de inmediato y el resultado llega en un turno posterior, así que una tarea larga de investigación no bloquea la conversación. Pregunta "¿qué encontraste?" en un turno de seguimiento para recogerlo.

## Desplegar y monitorear

La pestaña Revisar / Desplegar resume el agente antes de que lo confirmes. Una vez desplegado, un agente corre contra la misma base de datos de Crow que cualquier otra conexión, así que sus memorias, proyectos, archivos y mensajes son visibles en todas las demás partes de Crow.

## Relacionado

- [Lentes Meta](/es/guide/meta-glasses): Ejecuta un agente manos libres en lentes Ray-Ban Meta
- [Crow Messages](/es/guide/crow-messages): Comparte un bot, explora bots de tus Crows y crea salas grupales
- [Arquitectura del Bot Builder](/es/architecture/bot-builder): El motor, el modelo de datos y los internos del despacho de voz
- [Extensiones](/es/guide/extensions): Instala extensiones que aportan herramientas y skills
- [Escribir Skills](/es/developers/skills): Crea los prompts conductuales que usan los agentes
- [Proveedores de IA (BYOAI)](/es/guide/ai-providers): Configura los modelos en los que corren los agentes
