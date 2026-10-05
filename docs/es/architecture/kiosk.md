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
- Asistente: el elegido en **Kiosk → Hablar con Crow en el panel**; si no, el primer asistente activo. Funciona con los mismos límites de herramientas que una pantalla vinculada y los recuerdos siguen desactivados. Si no hay ningún asistente activo, la página lo indica y enlaza al panel Kiosk.
- Cerrar (el botón de cierre o Esc) detiene el micrófono y el audio al instante y elimina el marco.
- Solo el panel puede enmarcar la página (`frame-ancestors 'self'`); la página vinculada en `/display` sigue rechazando cualquier marco.

## Servicios de voz
- Voz a texto: el paquete Faster-Whisper (loopback :8004); el kiosk añade un perfil `distil-small.en` en la primera vinculación. Cada pantalla puede cambiar al modelo `tiny.en`, más rápido y menos preciso (Modelo de voz), y ajustar su espera al final del habla (300–900 ms, 450 por defecto). Crow precalienta el modelo de voz de la pantalla al arrancar el gateway, al conectarse y tras cambiar los ajustes, para que la primera pregunta no sea lenta.
- Voz: el paquete Kokoro TTS (loopback :8880) cuando está instalado.

## Privacidad
- No se envía nada antes de un toque. No se guarda audio; las transcripciones solo viven en la conversación en memoria de la pantalla (15 min).
- Los recuerdos están desactivados por defecto en una pantalla (`memory_integration`).
