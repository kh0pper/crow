# Pantalla kiosk

Un navegador vinculado —hoy un teléfono, después una Raspberry Pi 3 con pantalla táctil de 7"— muestra tu pájaro de Ramble y habla con el asistente de Crow que le asignes. Crow hace todo el trabajo: voz a texto, el turno del asistente y texto a voz. El navegador solo capta audio después de un toque y reproduce la respuesta.

**Diseño:** `docs/superpowers/specs/2026-10-03-crow-kiosk-companion-design.md`. **Plan K1:** `docs/superpowers/plans/2026-10-03-kiosk-k1-page-and-voice.md`.

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

## Privacidad
- No se envía nada antes de un toque. No se guarda audio; las transcripciones solo viven en la conversación en memoria de la pantalla (15 min).
- Los recuerdos están desactivados por defecto en una pantalla (`memory_integration`).
