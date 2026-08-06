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
- **Perch**: El agente se vuelve conversable desde la página Perch de tu propio panel. No hay nada que configurar: elegir el canal es toda la configuración. Perch necesita la extensión Perch Hub instalada. Consulta [Perch](#perch-habla-con-un-agente-desde-tu-propio-panel) más abajo.

Vincular los lentes a un agente es uno a uno: un dispositivo dirige un agente a la vez, y elegir un nuevo agente para un dispositivo libera el vínculo anterior.

## Perch: habla con un agente desde tu propio panel

Perch es una extensión que agrega una página **Perch** al Crow's Nest. Muestra todos los agentes de tu Crow, todas las conversaciones que cada uno ha tenido en cualquier canal, y la transcripción de cada una. Para los agentes a los que les adjuntes el canal Perch, además te da una caja de mensajes.

Nada de Perch queda expuesto a internet. Corre en tu máquina, escucha solo ahí, y solo es accesible a través del inicio de sesión de tu panel.

### 1. Instala Perch

Instala **Perch Hub** desde la página de Extensiones, o abre **Perch** en la navegación y usa el botón **Instalar Perch** de la tarjeta que aparece. Perch registra un pequeño servicio local, así que Crow se reinicia para poder enrutarlo; la página se recarga sola cuando la puerta de enlace vuelve, y aparece una entrada **Perch** en la navegación.

Si Perch dice que está desconectado justo después de instalarlo, normalmente es el reinicio que aún está pendiente: la tarjeta te dice en cuál de los dos casos estás, y lo dice con claridad cuando el supervisor sí registró un error real.

### 2. Adjunta el canal Perch a un agente

Abre el agente en el Bot Builder, ve a la pestaña **Gateways**, elige **Perch (chat del panel)** y guarda. No hay campos que llenar. También puedes elegir Perch como canal mientras creas un agente en el asistente.

Los turnos de Perch corren sobre el mismo motor de bots que usan Gmail y Discord, así que si el motor todavía no está instalado, Crow te ofrecerá instalarlo antes de dejarte guardar.

Puedes adjuntar el canal antes de instalar Perch, y el guardado sí se completa — pero Crow te avisa, porque la página que mostraría las respuestas del agente es justamente la extensión Perch. El aviso trae al lado un botón **Instalar Perch**, y cuando la instalación y el reinicio terminan vuelves al mismo agente ya sin el aviso.

Los agentes sin el canal adjunto igual aparecen en Perch. Puedes leer sus sesiones y transcripciones; simplemente no puedes escribirles. Observar es gratis, hablar es la parte que eliges activar.

### 3. Escríbele al agente

Abre **Perch**. Cada agente es una tarjeta. Los agentes con el canal adjunto tienen una caja de mensajes al pie de la suya: escribe, envía, y la respuesta llega en vivo a medida que el agente la produce. Si algo sale mal — el motor no está listo, el agente ya está ocupado con otro mensaje de la misma conversación — la tarjeta lo dice en lugar de la respuesta, en vez de quedarse girando.

Cada conversación es una sesión. Aparece en la lista de sesiones del agente con una **transcripción** que puedes abrir, y el agente retoma el hilo donde lo dejaste.

### 4. Acota las herramientas de un agente para una sola conversación

Abre **Controls** en cualquier fila de sesión. Verás el envelope completo del agente: todas las herramientas que tiene permitidas, cada una con una casilla, además de su modelo y sus skills.

Desmarca una herramienta y queda apagada **solo para esa conversación**, a partir del siguiente mensaje. La definición del agente no se toca, y todas las demás conversaciones conservan el conjunto completo. Esto es para el momento en que quieres que un agente responda una pregunta sin tocar tus archivos, sin editar nada, sin salir a la red: en este hilo, ahora mismo.

Las herramientas que aparecen con un candado son las que el agente no tiene permitidas en absoluto. Ahí no se pueden activar; enlazan al Bot Builder, que es el único lugar que otorga una herramienta. Perch solo puede quitar, nunca dar.

### 5. Cómo leer las insignias

Cada fila de sesión lleva insignias:

- el **canal** por el que llegó: `perch`, `gmail`, `discord`, etc.;
- una insignia de **tarjeta** cuando la sesión fue iniciada por un despacho del bot-board, que enlaza de vuelta a la tarjeta en el tablero;
- una insignia **live** mientras un turno está corriendo de verdad.

### 6. Genera un agente en vivo: una sesión en lugar de un turno

Cada tarjeta de agente que tenga el canal Perch adjunto también recibe un botón **Generar como agente**. Un mensaje en la caja del paso 3 es un turno único y autocontenido: lo envías, recibes una respuesta, y termina ahí. Generar es distinto: abre una sesión en vivo, un proceso del agente que se mantiene corriendo a través de varios mensajes, de la misma forma que el agente se comporta cuando trabaja consigo mismo a lo largo de varios pasos de una tarea, en vez de responder una sola pregunta.

La tarjeta de la sesión lleva una insignia de estado: **awake** (despierto) mientras el agente está activo y puede recibir un mensaje ahora mismo, **hibernating** (hibernando) una vez que ha estado inactivo y se apagó solo (no se pierde nada: el siguiente mensaje lo despierta de nuevo a mitad de la conversación), **waking** (despertando) durante el instante en que un mensaje está trayendo de vuelta a una sesión hibernando, **stopped** (detenido) una vez que terminaste la sesión definitivamente, y **error** si lo último que hizo falló. Una sesión detenida no se puede volver a despertar; genera una nueva si quieres seguir hablando con ese agente de esta forma.

Por defecto solo una sesión generada puede estar despierta a la vez, y compite por los mismos cupos de procesamiento que usa cualquier otro turno de agente: respuestas de Gmail, respuestas de Discord, trabajos en segundo plano. Dejar una sesión generada despierta e inactiva por un rato largo puede hacer que esos esperen. Si ya terminaste con una sesión por ahora, deja que hiberne (lo hará sola) o deténla.

Mientras un turno está corriendo, la actividad de las herramientas se transmite a la tarjeta en tiempo real, así que puedes ver qué está haciendo el agente antes de que llegue la respuesta. Aparece un botón **Abortar** durante un turno si quieres interrumpirlo.

### 7. Responder una pregunta que te hace el agente

Algunas skills te preguntan algo a mitad de la tarea en vez de adivinar: elegir de una lista, confirmar antes de hacer algo, escribir texto libre, o editar un bloque de texto. En una sesión generada, eso aparece como una **tarjeta** en lugar de la respuesta: la pregunta, y la forma de responderla. Respóndela y el agente continúa justo donde se quedó. Si una tarjeta sigue esperando tu respuesta cuando sales de la página, ahí sigue cuando vuelves a la sesión.

### 8. Volver más tarde

Recarga la página de Perch y la conversación más reciente de cada agente en cada canal se reabre donde la dejaste: el hilo de la caja de mensajes del paso 3 con su transcripción, y cualquier sesión generada del paso 6 con su estado en vivo y su transcripción, ambos. Nunca tienes que buscar cuál sesión era cuál.

### Antes de instalarlo

Vale la pena saber varias cosas, porque Perch no las esconde.

Cualquiera que pueda entrar a tu panel puede leer las transcripciones de **todos** los agentes en Perch. No hay control de acceso por agente.

Generar una sesión (paso 6) extiende eso de leer a conducir: cualquiera que pueda iniciar sesión también puede sostener una conversación en vivo como cualquier agente, usando las herramientas y permisos propios de ese agente, no solo observar lo que ya hizo. Es el mismo límite de confianza que el punto anterior sobre transcripciones, no uno nuevo: una sesión del panel ya podía activar a un agente escribiéndole por la caja de chat de Perch, o por el canal real del agente (un correo, un mensaje de Discord). Generar solo elimina el paso de "sale y vuelve por un canal".

Perch además trae su gestor de sesiones original completo, que puede iniciar programas en la máquina donde corre. Eso es deliberado: es una herramienta de operador autoalojada, y está detrás del inicio de sesión de tu panel y de nada más. Instálalo en un Crow cuyo inicio de sesión trates con la misma seriedad que el acceso por shell a esa máquina, y no en uno donde ese inicio de sesión esté compartido más ampliamente.

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
