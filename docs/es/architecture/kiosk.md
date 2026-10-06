# Pantalla kiosk

Un navegador vinculado —hoy un teléfono, después una Raspberry Pi 3 con pantalla táctil de 7"— muestra tu pájaro de Ramble y habla con el asistente de Crow que le asignes. Crow hace todo el trabajo: voz a texto, el turno del asistente y texto a voz. El navegador solo capta audio después de un toque y reproduce la respuesta.

## Piezas
- `bundles/kiosk/` — el paquete: página (`public/`), rutas + WebSocket (`server/runtime.js`, `server/session.js`), vinculación (`server/pairing.js`), ventanas (`server/wm.js`), herramientas MCP (`server/server.js`), panel (`panel/kiosk.js`).
- `servers/gateway/voice/turn.js` — el turno de voz independiente del transporte (asistente vinculado, enrutado con respaldo en frío de 8 s, filtro de razonamiento, interrupción, recuerdos desactivados por defecto).
- `servers/shared/device-store.js` — dispositivos vinculados (`device_kind: kiosk`), solo hashes de tokens.

## Red y autenticación
- Solo tailnet: `https://<host>:8444/display`. Nunca Funnel.
- Vinculación: la pantalla muestra un código de 6 dígitos; la persona propietaria lo aprueba en **Kiosk → Vincular una pantalla** y elige el asistente. La pantalla recoge su token una sola vez con un secreto de sondeo.
- El token del dispositivo solo se acepta en el primer mensaje `hello` de la sesión: nunca en una URL ni en otra ruta.
- Las herramientas MCP llegan a las sesiones por `/api/kiosk/internal/*` (solo loopback) con `$CROW_HOME/kiosk-announce-token`.

- La página se sirve en `/display`, no en `/kiosk`, porque el paquete maker-lab instalado ya usa `/kiosk/*`. La API sigue en `/api/kiosk/*` y el panel en `/dashboard/kiosk`.

## Hablar con Crow en el panel (modo sesión)
El pájaro de la cabecera de Crow's Nest abre la misma página dentro del panel, sin vinculación: toca el pájaro y elige **Hablar con Crow**, o mantén pulsado el pájaro (mantener Enter/Espacio con el pájaro enfocado hace lo mismo). Usa el micrófono y el altavoz del dispositivo en el que estás. La fila y la pulsación larga solo existen mientras la extensión Kiosk está instalada.

- Página: `/display/session`; WebSocket: `/api/kiosk/session/dashboard`. Ambos están tras la misma regla de red que el panel (nunca Funnel) **y** exigen la cookie de sesión del propio panel: el paquete no emite ningún token para esto. Sin sesión la página responde `401` y el socket se rechaza antes de la conexión.
- La conexión del socket debe venir de este mismo origen (`Sec-Fetch-Site: same-origin`, o un `Origin` que nombre el `Host` / `X-Forwarded-Host`), y su primer mensaje `hello` debe repetir la cookie `crow_csrf`: la misma regla de doble envío que cualquier POST del panel. Un proxy inverso delante de Crow debe reenviar `Host` o `X-Forwarded-Host`.
- No se guarda nada: la pantalla existe en memoria mientras dura el socket, con un id derivado de un hash de la sesión. No es un dispositivo vinculado, así que no aparece en **Kiosk**, no recibe anuncios y no se puede reclamar con un id de dispositivo. La sesión se vuelve a comprobar en cada pregunta y una vez por minuto; cerrar sesión cierra la pantalla. Sus ventanas, temporizadores y su breve conversación se descartan dos minutos después de cerrar la superposición.
- Asistente: el elegido en **Kiosk → Hablar con Crow en el panel**; si no (Automático), el primer asistente activo que quepa en el modelo de voz rápido: completo, o si no sin sus habilidades, nunca uno demasiado grande (ver «¿Cabe el asistente?»). El ajuste rechaza un asistente demasiado grande. Funciona con los mismos límites de herramientas, reglas de la herramienta de pantalla y reloj que una pantalla vinculada (el navegador informa de su zona horaria) y los recuerdos siguen desactivados. Si ningún asistente activo cabe —o el elegido ya no cabe—, la página lo indica y enlaza al panel Kiosk.
- Cerrar (el botón de cierre o Esc) detiene el micrófono y el audio al instante y elimina el marco.
- Solo el panel puede enmarcar la página (`frame-ancestors 'self'`); la página vinculada en `/display` sigue rechazando cualquier marco.

## Servicios de voz
- Voz a texto: el paquete Faster-Whisper (loopback :8004); el kiosk añade un perfil `distil-small.en` en la primera vinculación. Cada pantalla puede cambiar al modelo `tiny.en`, más rápido y menos preciso (Modelo de voz), y ajustar su espera al final del habla (300–900 ms, 450 por defecto). Crow precalienta el modelo de voz de la pantalla al arrancar el gateway, al conectarse y tras cambiar los ajustes, para que la primera pregunta no sea lenta.
- Voz: el paquete Kokoro TTS (loopback :8880) cuando está instalado.

## ¿Cabe el asistente?
El modelo de voz rápido tiene un contexto pequeño (8.192 tokens en el modelo local de serie), y el prompt de sistema de un asistente incluye el texto completo de todas sus habilidades. Antes de cada llamada al modelo, el turno de voz estima la petición (`servers/gateway/voice/prompt-fit.js`) y nunca envía una que no quepa:
- el prompt completo cabe → no cambia nada;
- no cabe → el turno se ejecuta **sin el texto de las habilidades del asistente** (la personalidad y las herramientas se mantienen); las métricas del turno llevan `prompt_fit: "no_skills"`;
- sigue siendo demasiado grande → no se llama al modelo: la pantalla dice que el asistente es demasiado grande y que elijas otro en los ajustes de Kiosk (`failed: "bot_too_large"`).

La conversación guardada se recorta, empezando por el intercambio más antiguo, cuando haría que una petición no cupiera. El panel **Kiosk** muestra el mismo resultado para cada asistente del selector —cabe, funciona sin sus habilidades o demasiado grande— y se niega a vincular uno demasiado grande. Un asistente general con muchas habilidades necesita un modelo mayor; a una pantalla dale un asistente del hogar pequeño.

## Cómo se resuelve una petición hablada

Una petición pasa por el paso más barato que pueda responderla, y todos los pasos terminan en el mismo ejecutor (`server/executor.js`) con la misma forma de resultado.

1. **Una frase de control con un objetivo presente** (`server/phrases.js`): "cierra eso", "siguiente paso", "close that". Una tabla fija de frases completas en inglés y español, comparadas palabra por palabra. Solo actúa cuando su objetivo existe (una ventana que cerrar, una receta que avanzar) y nombra una ventana por su título completo o por palabras completas de él; si no, la petición sigue adelante.
2. **Un patrón anclado cuyo hueco se resuelve en esta pantalla** (`server/patterns.js`): el verbo al principio de la frase y luego un nombre que debe coincidir con algo que la pantalla tiene. Sin coincidencia no se hace nada aquí.
3. **El asistente, con las herramientas de pantalla** (`server/tools.js`, `server/display-tools.js`): `crow_show` (una tarjeta: texto, una lista, pasos, un temporizador), `crow_wm` (cerrar ventanas, avanzar por los pasos) y, cuando la pantalla tiene algo que reproducir o abrir, `crow_play` y `crow_open`. Cada una tiene como máximo tres argumentos planos, y cada lista de opciones se construye en el servidor para esta pantalla.

El reloj responde sin modelo: la hora, la fecha de hoy, mañana y ayer, el día de la semana de una fecha nombrada y los días que faltan para ella (`server/clock.js`).

**Ofrecida y obligatoria.** Una herramienta de pantalla se ofrece al modelo solo en un turno cuyas palabras tratan de ella (o, para `crow_wm`, mientras hay una ventana abierta). Es *obligatoria* cuando la persona lo está pidiendo ahora: contenido nuevo, un cambio en la tarjeta abierta, una petición de reproducir o abrir. En un turno obligatorio el texto del modelo se retiene hasta que la llamada ha tenido éxito; un turno que termina sin ella recibe una ronda correctiva y, después, la pantalla dice con sus propias palabras que no pudo, en lugar de afirmar que lo hizo. Una frase con dos peticiones ("cierra el temporizador y luego muéstrame una lista") se entrega entera al modelo, con todas las herramientas que correspondan.

**Resultados.** El resultado de una herramienta es `{ ok, outcome, say, final }`. Un resultado final termina el turno con `say`, una frase en el idioma de la pantalla, así que no hace falta una segunda ronda del modelo para confirmar lo ocurrido. Si el modelo ya dijo una frase y la llamada cambió algo, `say` no se añade encima. Si la llamada no cambió nada o falló, `say` siempre se dice. Un resultado no final vuelve al modelo con la corrección que debe hacer.

**Llamada forzada.** Una llamada forzada solo se envía a un motor del que se sabe que la respeta (se lee de la lista de modelos del propio servidor). A un motor que la ignora no se le envía ninguna, y la ronda correctiva hace el trabajo. `"required"` nunca se envía a un motor del que no se sabe que lo respeta.

**Otras herramientas.** Las demás familias de herramientas del asistente (proyectos, mensajes, archivos, noticias, complementos) se ofrecen al modelo rápido solo en un turno cuyas palabras las piden, o en el turno inmediatamente posterior a uno que las usó. Una familia que no se ofrece nunca se ejecuta, llame a lo que llame el modelo. La línea de registro de cada turno y la lista de Diagnóstico dicen qué familias no se ofrecieron. La memoria conserva su propia regla (cuando se pide recordar).

**Tipos de pantalla.** Cada pantalla tiene un tipo (pantalla de pared pequeña, teléfono, tableta, computadora). Lo que una pantalla puede mostrar es lo menor entre su tipo y lo que su página dice que puede dibujar. Una pantalla sin tipo se trata como la pantalla de pared pequeña: audio primero. El tipo no se guarda hasta que alguien lo elige en el panel de Kiosk o la primera conexión de la pantalla lo deduce de lo que informa su página (un teléfono dice que es móvil; una pantalla pequeña en un navegador Linux ARM es una pantalla de pared); un tipo deducido aparece marcado como deducido en el panel.

## Herramienta de pantalla y reloj
- Una pregunta normal se responde en voz alta en una sola ronda del modelo, sin ninguna herramienta de pantalla ofrecida. Mientras hay una ventana abierta, en un turno así solo se ofrece `crow_wm` (cerrar y pasos).
- Una tarjeta se rechaza cuando la pregunta no pidió ver nada, y cualquier tarjeta cuyo título o texto esté vacío o sea un marcador se rechaza, con la corrección. Una tarjeta enviada con el título de la tarjeta abierta la actualiza; una tarjeta de contenido nueva reemplaza a la anterior; un temporizador siempre tiene su propia ventana, así que poner uno nunca cancela otro.
- Cada turno lleva la fecha, la hora y la zona horaria locales de la pantalla en el mensaje del usuario (la página informa de su zona al conectarse; sin ella se usa la del servidor).
- El resultado de cada llamada se registra como `nombre:resultado` (`shown`, `updated`, `placeholder`, `no_intent`, `not_offered`, `refused_policy`, …), nunca sus argumentos ni su texto; la lista de depuración de la página (pulsación larga sobre el reloj) muestra la misma línea.
- `POST /api/kiosk/internal/turn-check` (solo desde la propia máquina y con el token de anuncios) pasa tres frases fijas por el mismo turno que usa una pantalla, en una pantalla que no existe, e informa de lo ocurrido. Nunca pasa al modelo grande (así nunca puede arrancarlo) y solo se da por buena cuando la tarjeta que pide está de verdad en la pantalla (esa frase se intenta hasta tres veces). Es la comprobación que se ejecuta después de una actualización.

## Privacidad
- La página envía el nombre de su zona horaria al conectarse, para que la pantalla pueda decir la hora.
- No se envía nada antes de un toque. No se guarda audio; las transcripciones solo viven en la conversación en memoria de la pantalla (15 min).
- Los recuerdos están desactivados por defecto en una pantalla (`memory_integration`). Cuando están activados, la herramienta de recuerdos solo se ofrece cuando la pregunta pide recordar, consultar u olvidar algo (`server/memory-intent.js`): el asistente usa los recuerdos cuando se le pide, no en cada pregunta.
