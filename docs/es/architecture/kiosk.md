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

## Servicios de voz
- Voz a texto: el paquete Faster-Whisper (loopback :8004); el kiosk añade un perfil `distil-small.en` en la primera vinculación. Cada pantalla puede cambiar al modelo `tiny.en`, más rápido y menos preciso (Modelo de voz), y ajustar su espera al final del habla (300–900 ms, 450 por defecto). Crow precalienta el modelo de voz de la pantalla al arrancar el gateway, al conectarse y tras cambiar los ajustes, para que la primera pregunta no sea lenta.
- Voz: el paquete Kokoro TTS (loopback :8880) cuando está instalado.

## ¿Cabe el asistente?
El modelo de voz rápido tiene un contexto pequeño (8.192 tokens en el modelo local de serie), y el prompt de sistema de un asistente incluye el texto completo de todas sus habilidades. Antes de cada llamada al modelo, el turno de voz estima la petición (`servers/gateway/voice/prompt-fit.js`) y nunca envía una que no quepa:
- el prompt completo cabe → no cambia nada;
- no cabe → el turno se ejecuta **sin el texto de las habilidades del asistente** (la personalidad y las herramientas se mantienen); las métricas del turno llevan `prompt_fit: "no_skills"`;
- sigue siendo demasiado grande → no se llama al modelo: la pantalla dice que el asistente es demasiado grande y que elijas otro en los ajustes de Kiosk (`failed: "bot_too_large"`).

La conversación guardada se recorta, empezando por el intercambio más antiguo, cuando haría que una petición no cupiera. El panel **Kiosk** muestra el mismo resultado para cada asistente del selector —cabe, funciona sin sus habilidades o demasiado grande— y se niega a vincular uno demasiado grande. Un asistente general con muchas habilidades necesita un modelo mayor; a una pantalla dale un asistente del hogar pequeño.

## Herramienta de pantalla y reloj
- La herramienta de pantalla (`crow_wm`: temporizadores, recetas, una tarjeta de contenido) solo se ofrece al modelo en los turnos que la necesitan: la pregunta pide mostrar, cronometrar, seguir o cerrar algo (listas de palabras en inglés y español en `server/wm.js`, `wantsDisplay`), o ya hay una ventana abierta. Una pregunta normal no recibe la herramienta, así que se responde en voz alta en una sola ronda del modelo.
- Una tarjeta de contenido se rechaza cuando la pregunta no pedía ver nada, y también cualquier tarjeta cuyo título o texto esté vacío o sea un marcador de sintaxis. Una tarjeta de contenido nueva sustituye a la anterior; los temporizadores y las recetas conservan sus propias ventanas.
- Cada turno lleva la fecha, la hora y la zona horaria locales de la pantalla en el mensaje del usuario (la página informa de su zona al conectarse; si no, se usa la del servidor). «¿Qué hora es?» y «¿Qué día es hoy?» se responden directamente, sin el modelo (`server/clock.js`).

## Privacidad
- La página envía el nombre de su zona horaria al conectarse, para que la pantalla pueda decir la hora.
- No se envía nada antes de un toque. No se guarda audio; las transcripciones solo viven en la conversación en memoria de la pantalla (15 min).
- Los recuerdos están desactivados por defecto en una pantalla (`memory_integration`).
