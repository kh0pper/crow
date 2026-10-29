---
title: Bot Builder
---

# Bot Builder

> ¿Nuevo con los bots? Empieza con el tutorial paso a paso [Tu primer bot](/es/guide/bot-builder-tutorial); esta página es la referencia completa.

Tus bots aparecen como tarjetas; consulta [Tu lista de bots](/es/guide/bot-builder-tutorial#tu-lista-de-bots) para ver las acciones de cada tarjeta.

El Bot Builder es donde compones y ejecutas tus propios agentes de IA. Un agente (un "bot") es una persona más los skills, herramientas, gateways y permisos que le das. Todo se configura desde el dashboard Crow's Nest en un editor con pestañas, sin archivos de configuración que editar a mano y sin una herramienta de administración aparte.

El Bot Builder es la columna vertebral agéntica de Crow. El mismo agente que construyes aquí puede responder tu correo, chatear en Discord o funcionar manos libres en tus lentes, apoyándose en la memoria, los proyectos, los archivos de Crow y cualquier integración que tengas instalada.

## Qué es un agente

Un agente es una definición con varias partes. El editor las agrupa en cuatro pestañas, más una vista Avanzado para los ajustes que la mayoría de los agentes nunca necesitan:

| Pestaña | Qué controla |
|---|---|
| **Lo básico** | El nombre del agente, su personalidad e instrucciones, su modelo (más un modelo más potente opcional para preguntas difíciles y un modelo de voz rápido para gafas, quiosco y compañero) y el único canal por el que la gente lo contacta: Gmail, Discord, Telegram, Slack, un quiosco de Compañero de IA, Mensajes de Crow o Perch. Solo se muestran los ajustes del canal elegido. |
| **Capacidades** | Lo que puede hacer: leer o editar archivos en sus carpetas, ejecutar comandos, usar la memoria y qué servicios conectados puede usar. Cada servicio es una fila con **Apagado / Solo lectura / Todo / Personalizado**; Personalizado abre una lista con buscador de las herramientas de ese servicio, cada una marcada como "lee" o "hace cambios". Aquí también se eligen las habilidades. |
| **Seguridad** | Si el correo que escribe se guarda como borrador para ti o se envía directamente, qué carpetas puede ver y modificar, y las acciones sobre las que siempre debe preguntarte antes. |
| **Actividad** | Una lista de verificación, el interruptor Activar / Desactivar, las habilidades que esperan tu revisión y sus conversaciones recientes. |
| **Avanzado** | Aprender habilidades nuevas, agentes auxiliares, una lista de comandos permitidos, el tablero y proyecto en que trabaja, compartir con tus otros Crows, una revisión de conexiones de herramientas, los ajustes en bruto y Eliminar. |

Cada pestaña guarda solo sus propios ajustes, y solo los controles que cambiaste: guardar una pestaña sin tocar nada deja el agente exactamente como estaba. Si el agente se modificó en otro lugar mientras la página estaba abierta (por ejemplo, se aprobó una habilidad), el guardado se rechaza y se te pide recargar.

## Herramientas y extensiones

Cada agente solo ve las herramientas que le otorgas. La pestaña Capacidades muestra cada servicio conectado (los servidores propios de Crow y cada extensión instalada) como una fila. **Solo lectura** otorga solo las herramientas que consultan; **Todo** añade las que hacen cambios. Las herramientas que un servicio añada más adelante nunca se activan solas: un agente en Todo pasa a mostrar Personalizado hasta que vuelvas a elegir. Crow decide por el nombre de cada herramienta, y lo que no reconoce cuenta como "hace cambios"; una herramienta cuyo nombre parece una consulta pero que muestra, comparte o pulsa algo (una pantalla de quiosco, un enlace de descarga, un navegador que navega) también cuenta como que hace cambios. Un servicio puede marcar más herramientas como que hacen cambios, nunca menos.

Cuando un servicio está conectado más de una vez (dos cuentas de Google, por ejemplo), cada fila muestra su cuenta. Define la etiqueta con una entrada opcional `"account"` en ese servidor dentro de `~/.pi/agent/mcp.json` o `mcp-addons.json` (por ejemplo `"account": "alex@example.com"`); sin ella, la fila muestra el nombre del servidor.

Cuando seleccionas las herramientas de una extensión, el Bot Builder conecta esa extensión al agente automáticamente. No editas entradas de servidores MCP a mano. Si una extensión provee una herramienta que el canal del agente no puede alcanzar (por ejemplo, una herramienta sin equivalente de voz en la ruta de los lentes), el editor te advierte en lugar de descartarla en silencio.

## Skills

Los skills son prompts conductuales (archivos Markdown con un pequeño encabezado de front-matter) que le enseñan a un agente un flujo de trabajo específico. Elígelos en la pestaña Capacidades, agrupados por la extensión que los provee.

Los skills son portables entre agentes y entre canales. Las variantes de idioma (inglés, español, etcétera) son simplemente archivos de skill distintos que llaman a las mismas herramientas subyacentes.

## Gateways: un agente, los canales que elijas

Un gateway conecta un agente con un lugar donde la gente habla con él. La misma definición de agente puede correr en más de un canal.

- **Gmail**: El agente lee y responde correo en un buzón conectado.
- **Discord**: El agente se une a un servidor de Discord como bot y responde en canales y mensajes directos, con una lista de usuarios permitidos por agente.
- **Lentes Meta**: Los lentes Ray-Ban Meta (Gen 2) emparejados responden como Crow, con los perfiles de habla y voz que elegiste. Consulta la [guía de Lentes Meta](/es/guide/meta-glasses).
- **Crow Messages**: El agente se vuelve accesible como un contacto. Las personas que invites pueden enviarle mensajes, puedes explorar y agregar los bots que corren en tus Crows, y puedes reunir a personas y bots en una sala grupal. Consulta la [guía de Crow Messages](/es/guide/crow-messages).
- **Perch**: El agente se vuelve conversable directamente en el tablero de tu propio panel. No hay nada que configurar: elegir el canal es toda la configuración, y nada que instalar. Consulta [Perch](#perch-habla-con-un-agente-desde-tu-propio-panel) más abajo.

### La voz y los encargos

La voz siempre responde como **Crow**, hables con un quiosco, con tus lentes o con Hablar con Crow en el teléfono. Ya no se elige un bot por dispositivo. Los ajustes de Crow (su modelo, su voz, la memoria y lo demás) están en el bot de voz **Crow** del Bot Builder.

Crow puede encargarle un trabajo más grande a uno de tus bots. Pide algo que le toque a un bot («que writer redacte una entrada sobre el huerto») y Crow te dice a qué bot se lo daría y de qué trata. No pasa nada hasta que digas que sí. En un quiosco, que es una pantalla compartida, lo confirmas en el teléfono: Crow te manda una notificación y ahí tocas Confirmar.

Cuando dices que sí, el trabajo aparece como una tarjeta en el tablero de ese bot, y Crow te avisa de que el bot ya se puso con ello (o de que todavía está arrancando). Al terminar recibes una sola notificación que abre lo que el bot hizo. Si sigues hablando con Crow, también te dice en voz alta que el bot terminó.

Mientras un bot trabaja puedes preguntar «¿cómo va writer?». Para pararlo, di «para a writer» o «párala». Crow siempre te pregunta antes, y lo que el bot ya hizo se conserva.

Los bots a los que Crow puede encargar trabajo se eligen en los ajustes de voz de Crow: abre **Crow** en el Bot Builder y ve a la sección **Encargos a otros bots**, con un interruptor, la lista de bots permitidos (vacía significa todos los bots activados con su tablero encendido; Crow ofrece como máximo ocho) y un registro de los encargos recientes.

## Perch: habla con un agente desde tu propio panel

Perch es la superficie de chat del propio panel para los agentes — el **hub de Perch** en `/dashboard/perch` (una entrada del nav bajo Agents). Una sola página reúne una lista de sesiones en vivo, un lanzador para iniciar una sesión nueva y el chat. El tablero también lleva una compacta **franja de percha (roost)** encima de las tarjetas que enlaza al hub. No hay nada que instalar y nada que configurar más allá de adjuntar el canal.

Nada de esto queda expuesto a internet. Corre como parte de la puerta de enlace, escucha solo ahí, y solo es accesible a través del inicio de sesión de tu panel.

### 1. Adjunta el canal Perch a un agente

Abre el agente en el Bot Builder, en la pestaña **Lo básico** elige **Perch (chat del panel)** como canal y guarda. No hay campos que llenar. También puedes elegir Perch como canal mientras creas un agente en el asistente.

Los turnos de Perch corren sobre el mismo motor de bots que usan Gmail y Discord, así que si el motor todavía no está instalado, Crow te ofrecerá instalarlo antes de dejarte guardar.

Los agentes sin el canal adjunto aun así aparecen en la lista del hub, pero no hay sesión que abrir hasta que lo adjuntes — salta al Bot Builder para hacerlo.

### 2. Inicia una sesión — opcionalmente en cualquier directorio

Abre el hub de Perch. El lanzador en la parte superior de la lista inicia una sesión nueva: elige el agente (cuando hay más de uno), opcionalmente elige un modelo y **opcionalmente elige un directorio de trabajo**.

El campo de directorio es el control de abrir-en-cualquier-lugar. Déjalo vacío y la sesión corre en el directorio predeterminado del propio agente. Llénalo — escribiendo una ruta o tocando **Explorar…**, que abre un selector alimentado por el servidor (lista solo nombres de directorios, nunca contenido de archivos) — y el agente corre *ahí*: puede leer y escribir ese directorio, y sus herramientas MCP por agente lo siguen. Así es como apuntas un agente a un checkout de proyecto real en vez de a su propio sandbox. El directorio elegido ya debe existir; el selector solo ofrece directorios que existen.

> Perch no enjaula a un agente en un directorio en esta máquina — el selector puede alcanzar cualquier directorio que el usuario de la puerta de enlace pueda. La barrera entre agentes son las herramientas y permisos de cada uno, no el directorio. Trata al hub de Perch como el acceso por shell que es (ver [Antes de adjuntarlo](#antes-de-adjuntarlo)).

Toca **Nueva sesión**. El chat se abre en la conversación.

### 3. El chat: cuatro pestañas

El chat tiene cuatro pestañas a lo ancho de la parte inferior (teléfono) o superior (escritorio). Cambiar de pestaña nunca interrumpe la sesión — la conexión en vivo pertenece a la sesión, no a la pestaña.

- **Chat** — la transcripción, un cuadro para enviar un mensaje o redirigir un turno en curso, y cualquier tarjeta de pregunta que el agente esté esperando. La actividad de herramientas y las líneas de registro *no* atiborran esta vista; van a Actividad.
- **Sesión** — los controles de modelo, nivel de razonamiento, modo de permisos y modo de plan; el estado de la sesión; Renombrar y Cerrar; y el directorio de trabajo con un botón **Cambiar directorio**. Cambiar el directorio duerme la sesión y la despierta en el directorio nuevo con tu siguiente mensaje (el proceso de un agente no puede cambiar de directorio a mitad de ejecución) — el botón lo advierte antes de que confirmes, y se rechaza mientras hay un turno en curso.
- **Archivos** — lo que el agente ha escrito en su directorio de resultados esta sesión, lo más reciente primero, cada fila una descarga. Esta es la carpeta de entregables propia de la sesión, no el directorio de trabajo que elegiste.
- **Actividad** — el riel de registro/herramientas/error con marca de tiempo: qué hizo el agente, qué herramientas llamó, y cualquier nota de la puerta de enlace, para que la pestaña Chat siga siendo una conversación limpia.

Cada sesión lleva un estado: **Despierto** mientras el agente puede recibir un mensaje ahora mismo, hibernando una vez que ha estado inactiva y se apagó sola (no se pierde nada: el siguiente mensaje la despierta de nuevo a mitad de la conversación, en su directorio elegido y con su modelo elegido), y **Detenido** una vez que tú o Cerrar la terminaron definitivamente. Una sesión detenida no se puede volver a despertar — inicia una nueva si quieres seguir hablando con ese agente de esta forma.

Por defecto solo una sesión por agente corre a la vez, y cada sesión compite por los mismos cupos de procesamiento que usa cualquier otro turno de agente: respuestas de Gmail, respuestas de Discord, trabajos en segundo plano. Dejar una sesión despierta e inactiva por un rato largo puede hacer que esos esperen; deja que hiberne (lo hará sola) o deténla cuando termines.

### 4. Acota las herramientas de un agente para una sola sesión

El acotado de herramientas por sesión vive en el hub: abre una sesión, ve a su pestaña **Sesión** y despliega **`Envoltura y herramientas`**. Verás el envelope completo del agente: todas las herramientas que tiene permitidas, cada una con una casilla, además de su modelo y sus skills. El mismo panel sigue en el tablero — abre el panel lateral de la tarjeta en la que trabaja una sesión — y ambos leen y escriben el mismo acotado por sesión. Las concesiones son solo del Bot Builder; el panel solo puede quitar.

Desmarca una herramienta y queda apagada **solo para esa sesión**, a partir del siguiente mensaje. La definición del agente no se toca, y todas las demás sesiones conservan el conjunto completo. Esto es para el momento en que quieres que un agente responda sin tocar tus archivos, sin editar nada, sin salir a la red: en esta sesión, ahora mismo.

Las herramientas que aparecen con un candado son las que el agente no tiene permitidas en absoluto. No se pueden activar desde ninguno de los dos paneles; solo el Bot Builder otorga una herramienta. La sesión solo puede quitar, nunca dar.

### 5. Responder una pregunta que te hace el agente

Algunas skills te preguntan algo a mitad de la tarea en vez de adivinar: elegir de una lista, confirmar antes de hacer algo, escribir texto libre, o editar un bloque de texto. Eso aparece en la pestaña Chat como una tarjeta en lugar de la respuesta: la pregunta, y la forma de responderla. Respóndela y el agente continúa justo donde se quedó. Si una tarjeta sigue esperando tu respuesta cuando sales de la página, ahí sigue cuando vuelves a la sesión — mientras tanto, la lista del hub muestra la sesión como **esperando tu respuesta**.

### 6. Volver más tarde

Recarga el hub y las sesiones de cada agente adjunto siguen justo donde las dejaste — reabre una sesión y la transcripción, el estado en vivo, el directorio y modelo elegidos, y cualquier pregunta pendiente siguen ahí. Nunca tienes que buscar cuál sesión era cuál.

### Antes de adjuntarlo

Vale la pena saber varias cosas, porque Perch no las esconde.

Cualquiera que pueda entrar a tu panel puede leer las transcripciones de **todos** los agentes en el hub. No hay control de acceso por agente.

Escribir o redirigir una sesión extiende eso de leer a conducir: cualquiera que pueda iniciar sesión puede sostener una conversación en vivo como cualquier agente, usando las herramientas y permisos propios de ese agente, no solo observar lo que ya hizo. No es un límite de confianza nuevo: una sesión del panel ya podía activar a un agente escribiéndole por su canal real (un correo, un mensaje de Discord). Perch solo lo hace alcanzable directamente desde el tablero, sin salir y volver por un canal.

Adjunta el canal Perch solo en un Crow cuyo inicio de sesión trates con la misma seriedad que el acceso por shell a esa máquina — una sesión en vivo puede ejecutar cualquier herramienta que la política de permisos propia del agente permita, incluyendo las que inician programas en la máquina donde corre.

## Tarjetas de decisión

Un bot que necesita que elijas entre unas pocas opciones puede preguntarlo con una **tarjeta de decisión** en vez de una pregunta de texto libre. Llama a `board_ask_decision` en el servidor MCP del tablero; la tarjeta aparece en el Bot Board y, al abrirla, muestra un bloque **Decisión** encima del plan.

**Qué contiene una decisión.** Una pregunta (hasta 300 caracteres), un contexto opcional (se muestra como texto plano) y **de 2 a 4 opciones**. Cada opción tiene una etiqueta (hasta 120 caracteres) y una línea de consecuencia (hasta 240) que dice qué pasa si la eliges. Exactamente una opción va marcada como recomendada y debe ir primero; el panel la señala con **Recomendada**. Una opción también puede llevar `snooze_days` (de 0 a 90: tras elegirla, la misma pregunta no se repite durante esos días) y una tarjeta de seguimiento que crear. Una decisión vence en su fecha `expires` (por defecto, a los siete días); una tarjeta vencida es de solo lectura.

**Responder.** Haz clic en una opción, o en **Otra…** para escribir tu propia respuesta (hasta 2000 caracteres) y **Enviar respuesta**. Solo el panel puede responder; ninguna herramienta MCP puede. La elección se registra una sola vez: un segundo clic o una segunda pestaña recibe «ya decidida» y ve la primera respuesta. Después la tarjeta se cierra. Si la opción elegida indica una tarjeta de seguimiento, se crea exactamente una, siempre **con aprobación** (espera a que apruebes su plan), lleva sin cambios las etiquetas de la tarjeta de decisión, y el panel enlaza a ella. El historial de la tarjeta muestra **decisión planteada** y **decidida**.

**Sin repeticiones ni avalanchas.** Una tarjeta cuyo `fingerprint` coincide con otra que sigue abierta no se vuelve a crear; se devuelve la abierta (`deduped: true`). Lo mismo ocurre mientras dure la pausa de una opción elegida. Un bot tiene como máximo **5 tarjetas de decisión abiertas por lote**; la sexta se rechaza (`batch_full`). Preguntar nunca envía una notificación: el bot llama a `board_notify_decisions` una vez al final del lote para un único aviso agrupado, y cada tarjeta se notifica como mucho una vez, por muchas veces que se llame.

**Por quien pregunta.** Los lotes y los `fingerprint` pertenecen a quien los pidió: dos bots pueden usar el mismo nombre de lote o el mismo `fingerprint` sin ver las tarjetas del otro, y un bot solo puede notificar tarjetas que él mismo preguntó. El aviso se envía una vez por lote, mientras sus tarjetas notificadas sigan abiertas; las tarjetas añadidas después solo aparecen en el tablero. Cada quien puede enviar como máximo **3 avisos al día (UTC)**; el cuarto se rechaza (`push_limit`, 429).

**Crear una tarjeta para un bot.** `board_create_item` acepta `assigned_bot` para tarjetas (no para elementos de seguimiento). El bot debe existir, estar habilitado y no ser el bot de voz, o la llamada se rechaza. La tarjeta nueva es **gated** por defecto, así que espera tu aprobación del plan.

## Permisos y seguridad

Cada agente lleva una política de permisos que gobierna lo que puede hacer sin preguntar:

- **Confirmar**: Las acciones nombradas requieren un paso de confirmación antes de ejecutarse.
- **Denegar**: Las acciones nombradas se rechazan de plano.
- **Salidas solo en borrador**: Los envíos y publicaciones salientes se degradan. Una publicación de blog se convierte en borrador, y un envío real (como un correo) se bloquea y se reporta, de modo que un agente no puede hablar con el mundo exterior en tu nombre a menos que lo permitas.

Estas reglas se aplican sobre la acción subyacente, no solo sobre el nombre superficial de la herramienta. Si un agente intenta alcanzar una acción protegida a través de un envoltorio de herramienta de propósito general, la política se aplica igual. En la ruta de voz, la misma compuerta corre antes de que se ejecute cualquier herramienta, y una acción bloqueada se te comunica en voz alta.

## Autoescritura opt-in

Un agente puede ayudar a escribir sus propios skills, pero solo si lo activas en **Avanzado → Aprender habilidades nuevas**. Está **desactivado por defecto**; puedes dejar que sugiera habilidades para tu aprobación o que aprenda por su cuenta con salvaguardas (un agente que puede enviar correo o ejecutar comandos solo sugiere).

Cuando la habilitas para un agente:

1. El agente puede **redactar** un nuevo archivo de skill en un área de preparación confinada que pertenece a ese agente. El borrador es inerte. No se carga, no se adjunta al agente y no puede surtir efecto.
2. El skill redactado aparece en el Bot Builder para revisión. Puedes leerlo, editar el texto y aprobarlo o rechazarlo. Cualquier redacción que pudiera debilitar una salvaguarda se marca para tu atención.
3. Al aprobarlo, Crow promueve el skill a tu biblioteca de skills y lo adjunta al agente. Solo entonces se carga.

Un skill autoescrito es solamente texto de prompt. Aprobar uno no puede otorgarle al agente nuevas herramientas ni cambiar su política de permisos, porque esas vienen de las pestañas Capacidades y Seguridad, no de un skill. La compuerta de aprobación del operador es el límite.

Este es el núcleo de la postura de Crow frente a las plataformas de bots con autoescritura automática: un agente puede proponer, pero un humano aprueba antes de que cualquier cosa que un agente escribió para sí mismo se vuelva real.

## Trabajo profundo

Para tareas que toman más de un turno, un agente puede pasarle trabajo al orquestador de Crow. El agente reconoce la solicitud de inmediato y el resultado llega en un turno posterior, así que una tarea larga de investigación no bloquea la conversación. Pregunta "¿qué encontraste?" en un turno de seguimiento para recogerlo.

## Desplegar y monitorear

La pestaña Actividad muestra si el agente está listo para funcionar y te deja activarlo o desactivarlo. Una vez desplegado, un agente corre contra la misma base de datos de Crow que cualquier otra conexión, así que sus memorias, proyectos, archivos y mensajes son visibles en todas las demás partes de Crow.

## Relacionado

- [Lentes Meta](/es/guide/meta-glasses): Ejecuta un agente manos libres en lentes Ray-Ban Meta
- [Crow Messages](/es/guide/crow-messages): Comparte un bot, explora bots de tus Crows y crea salas grupales
- [Arquitectura del Bot Builder](/es/architecture/bot-builder): El motor, el modelo de datos y los internos del despacho de voz
- [Extensiones](/es/guide/extensions): Instala extensiones que aportan herramientas y skills
- [Escribir Skills](/es/developers/skills): Crea los prompts conductuales que usan los agentes
- [Proveedores de IA (BYOAI)](/es/guide/ai-providers): Configura los modelos en los que corren los agentes
