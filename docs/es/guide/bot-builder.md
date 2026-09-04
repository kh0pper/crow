---
title: Bot Builder
---

# Bot Builder

> ¿Nuevo con los bots? Empieza con el tutorial paso a paso [Tu primer bot](/es/guide/bot-builder-tutorial); esta página es la referencia completa.

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
- **Perch**: El agente se vuelve conversable directamente en el tablero de tu propio panel. No hay nada que configurar: elegir el canal es toda la configuración, y nada que instalar. Consulta [Perch](#perch-habla-con-un-agente-desde-tu-propio-panel) más abajo.

Vincular los lentes a un agente es uno a uno: un dispositivo dirige un agente a la vez, y elegir un nuevo agente para un dispositivo libera el vínculo anterior.

## Perch: habla con un agente desde tu propio panel

Perch es la propia **franja de percha (roost)** del tablero: una fila de aves, una por agente, encima de las tarjetas — más un **panel lateral de sesión** que se abre junto al tablero al hacer clic en una de ellas. Juntos muestran las sesiones en vivo y recientes de cada agente, sus transcripciones, y un lugar para escribirles directamente. Es nativo del tablero: nada que instalar, nada que configurar más allá de adjuntar el canal.

Nada de esto queda expuesto a internet. Corre como parte de la puerta de enlace, escucha solo ahí, y solo es accesible a través del inicio de sesión de tu panel.

### 1. Adjunta el canal Perch a un agente

Abre el agente en el Bot Builder, ve a la pestaña **Gateways**, elige **Perch (chat del panel)** y guarda. No hay campos que llenar. También puedes elegir Perch como canal mientras creas un agente en el asistente.

Los turnos de Perch corren sobre el mismo motor de bots que usan Gmail y Discord, así que si el motor todavía no está instalado, Crow te ofrecerá instalarlo antes de dejarte guardar.

Los agentes sin el canal adjunto también aparecen en la franja de percha, como **Observando** — puedes saltar al Bot Builder para adjuntarlos, pero no hay sesión que abrir hasta que lo hagas.

### 2. Encuentra al agente en la franja de percha

Abre el tablero. Cada agente adjunto es un ave con un estado y una acción principal:

- **Inactivo** — sin sesión en vivo. El botón es **Enviar**: escribe un mensaje, envíalo, y arranca una sesión nueva.
- **Esperando tu respuesta** — el agente hizo una pregunta a mitad de la sesión y está en pausa esperando tu respuesta. El botón es **Responder**.
- **Trabajando** / **Hibernando** — hay una sesión en vivo o que se puso inactiva sola. El botón es **Abrir**.
- **Observando** — todavía sin canal adjunto (ver paso 1). El enlace va directo al Bot Builder.

Un menú desplegable en cada ave también ofrece **Hablar** (iniciar una sesión nueva aunque ya haya una abierta), **Sesiones** (elegir entre las demás sesiones recientes del agente), **Retirar** (detener la sesión en vivo) y **Configurar** (saltar al agente en el Bot Builder).

### 3. El panel lateral de sesión

Al hacer clic en un ave — o en una insignia de sesión de una tarjeta del tablero — se abre el panel lateral: la transcripción, un cuadro para enviar un mensaje o redirigir un turno en curso, y un botón **Abortar** mientras hay un turno corriendo. La actividad de las herramientas se transmite en tiempo real, así que puedes ver qué está haciendo el agente antes de que llegue la respuesta.

Cada sesión lleva un estado: **Despierto** mientras el agente puede recibir un mensaje ahora mismo, hibernando una vez que ha estado inactiva y se apagó sola (no se pierde nada: el siguiente mensaje la despierta de nuevo a mitad de la conversación), y **Detenido** una vez que tú o Retirar la terminaron definitivamente. Una sesión detenida no se puede volver a despertar — inicia una nueva desde **Enviar** o **Hablar** si quieres seguir hablando con ese agente de esta forma.

Por defecto solo una sesión por agente corre a la vez, y cada sesión compite por los mismos cupos de procesamiento que usa cualquier otro turno de agente: respuestas de Gmail, respuestas de Discord, trabajos en segundo plano. Dejar una sesión despierta e inactiva por un rato largo puede hacer que esos esperen; deja que hiberne (lo hará sola) o deténla cuando termines.

### 4. Acota las herramientas de un agente para una sola sesión

Abre **Envoltura y herramientas** en el panel lateral. Verás el envelope completo del agente: todas las herramientas que tiene permitidas, cada una con una casilla, además de su modelo y sus skills.

Desmarca una herramienta y queda apagada **solo para esa sesión**, a partir del siguiente mensaje. La definición del agente no se toca, y todas las demás sesiones conservan el conjunto completo. Esto es para el momento en que quieres que un agente responda sin tocar tus archivos, sin editar nada, sin salir a la red: en esta sesión, ahora mismo.

Las herramientas que aparecen con un candado son las que el agente no tiene permitidas en absoluto. Ahí no se pueden activar; enlazan al Bot Builder, que es el único lugar que otorga una herramienta. El panel lateral solo puede quitar, nunca dar.

### 5. Responder una pregunta que te hace el agente

Algunas skills te preguntan algo a mitad de la tarea en vez de adivinar: elegir de una lista, confirmar antes de hacer algo, escribir texto libre, o editar un bloque de texto. Eso aparece en el panel lateral como una tarjeta en lugar de la respuesta: la pregunta, y la forma de responderla. Respóndela y el agente continúa justo donde se quedó. Si una tarjeta sigue esperando tu respuesta cuando sales de la página, ahí sigue cuando vuelves a la sesión — mientras tanto, el ave muestra **Esperando tu respuesta**.

### 6. Volver más tarde

Recarga el tablero y el estado de percha y la sesión más reciente de cada agente adjunto siguen justo donde los dejaste — reabre el panel lateral y la transcripción, el estado en vivo y cualquier pregunta pendiente siguen ahí. Nunca tienes que buscar cuál sesión era cuál.

### Antes de adjuntarlo

Vale la pena saber varias cosas, porque Perch no las esconde.

Cualquiera que pueda entrar a tu panel puede leer las transcripciones de **todos** los agentes en el panel lateral. No hay control de acceso por agente.

Escribir o redirigir una sesión extiende eso de leer a conducir: cualquiera que pueda iniciar sesión puede sostener una conversación en vivo como cualquier agente, usando las herramientas y permisos propios de ese agente, no solo observar lo que ya hizo. No es un límite de confianza nuevo: una sesión del panel ya podía activar a un agente escribiéndole por su canal real (un correo, un mensaje de Discord). Perch solo lo hace alcanzable directamente desde el tablero, sin salir y volver por un canal.

Adjunta el canal Perch solo en un Crow cuyo inicio de sesión trates con la misma seriedad que el acceso por shell a esa máquina — una sesión en vivo puede ejecutar cualquier herramienta que la política de permisos propia del agente permita, incluyendo las que inician programas en la máquina donde corre.

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
