---
title: Lentes Meta
---

# Lentes Meta (Ray-Ban Meta Gen 2)

Empareja tus lentes inteligentes **Meta Ray-Ban (Gen 2)** con tu instalación de Crow
y contrólalos con tu propio BYOAI. Los turnos de voz capturados en los lentes fluyen
por la app Android de Crow → tu STT configurado → IA → perfiles de TTS →
de vuelta a los altavoces de los lentes.

Puedes llevar esto más lejos **vinculando los lentes a un agente del
[Bot Builder](/es/guide/bot-builder)**. Cuando un dispositivo está vinculado a un agente,
ese agente dirige el turno de voz: su persona, sus skills, sus herramientas delimitadas
y su política de permisos, hablados a través de las voces del dispositivo. Un dispositivo
sin vincular recurre a un perfil de IA simple, descrito más abajo. La vinculación es la
ruta más rica y se configura desde la pestaña Gateways del Bot Builder.

Sin jailbreak de firmware. Sin ingeniería inversa. La integración usa el
[**Wearables Device Access Toolkit**](https://wearables.developer.meta.com/docs)
(DAT) oficial de Meta, que le da a una app Android acompañante acceso a la cámara y
al audio de los lentes emparejados a través de un SDK soportado.

## Compatibilidad

| Modelo | Lanzamiento | Soportado |
|---|---|---|
| Ray-Ban Meta (Gen 2 / AR1) | 2023 | ✅ |
| Ray-Ban Stories (Gen 1) | 2021 | ❌ — DAT no expone las primitivas necesarias |

También necesitarás:

- El **gateway de Crow** en ejecución (cualquier plataforma)
- La **app Android de Crow 1.4.0+** en un teléfono con Android 14 (API 34) o más reciente
- Un perfil de **STT** (`Configuración → Voz a texto`)
- Un perfil de **IA** (`Configuración → Perfiles de IA`)
- Un perfil de **TTS** (`Configuración → Texto a voz`)
- Tus lentes ya emparejados al teléfono en la app acompañante Meta AI

## Arquitectura

```
  ┌───────────────────────────┐
  │  Ray-Ban Meta (Gen 2)     │
  │  mic / altavoz / cámara   │
  └──────────┬────────────────┘
             │  DAT (cámara) + BT A2DP/HFP estándar (audio)
  ┌──────────▼────────────────┐
  │  Crow Android app          │
  │   GlassesService (fg svc) │  ←— mantiene el WebSocket /session
  │   PairingActivity         │
  └──────────┬────────────────┘
             │  WSS + HTTPS (compatible con Tailscale)
  ┌──────────▼────────────────┐
  │  Crow gateway             │
  │   bundles/meta-glasses/   │  ←— rutas REST + WebSocket
  │   ai/stt/ (plataforma)    │
  │   ai/provider.js (BYOAI)  │
  │   ai/tts/ (plataforma)    │
  └───────────────────────────┘
```

## Configuración (paso a paso)

### 1. Configura tus perfiles

Si nunca los has configurado, hazlo primero — emparejar no servirá de mucho
hasta que el pipeline tenga adónde enviar el audio.

**Voz a texto** — Abre `Configuración → Voz a texto` y agrega un perfil.
Para que los turnos de voz se sientan ágiles, prefiere:

- **Groq Whisper** (`whisper-large-v3-turbo`) — la opción en la nube más rápida
- **Deepgram** (`nova-3`) — la única opción con streaming real (transcripciones parciales)
- **faster-whisper** en tu grackle / GPU local — totalmente local

**Perfiles de IA (BYOAI)** — Ya tienes esto si has usado la función de
Mensajes de Crow. Un dispositivo sin vincular usa tu perfil de IA predeterminado a
menos que lo sobrescribas por dispositivo. Si vinculas el dispositivo a un agente
(consulta [Vincular los lentes a un agente](#vincular-los-lentes-a-un-agente) más
abajo), el agente reemplaza este perfil y aporta el modelo, la persona, las
herramientas delimitadas y los permisos del turno de voz.

**Texto a voz** — Abre `Configuración → Texto a voz` y elige un proveedor.

- **OpenAI TTS** (`tts-1`) — buena calidad, ~200 ms hasta el primer fragmento
- **ElevenLabs** — la mayor calidad, se factura por carácter
- **Piper** en tu grackle — gratuito, rápido, todo local
- **Kokoro** en tu grackle — mejor calidad que Piper, igual de local

### 2. Instala el complemento de Lentes Meta

Desde el dashboard de Crow: **Extensiones → Meta Glasses → Instalar**. El
complemento es pequeño — no incluye servicios Docker, solo el servidor MCP + el panel
+ las rutas REST.

### 3. Instala la app Android de Crow 1.4.0+

Instala (sideload) el APK más reciente desde la página de lanzamientos de Crow en tu teléfono.
La distribución por Play Store está supeditada a la disponibilidad general (GA) del DAT de Meta.

En el primer arranque:

- Acepta los permisos de **Bluetooth** y **Cámara** (necesarios para emparejar los lentes)
- Acepta la notificación de servicio en primer plano de **Dispositivo conectado**
- Si tu teléfono es un Samsung, Xiaomi, OnePlus o Huawei — desactiva la
  optimización de batería para la app de Crow (los OEM matan agresivamente
  los servicios en primer plano de dispositivos conectados por defecto)

### 4. Empareja tus lentes

- Abre la app de Crow. Navega a **Lentes Meta**.
- Toca **Emparejar lentes nuevos**. La app abre la hoja de emparejamiento DAT de Meta.
- Confirma en tus lentes cuando se te solicite.

Si tiene éxito, la app:

- Recibe un handle de dispositivo de DAT
- Registra el dispositivo en tu gateway de Crow (`POST /api/meta-glasses/pair`)
- Recibe un token bearer y lo guarda en SharedPreferences cifradas
- Inicia el servicio en primer plano `GlassesService`, que abre un WebSocket a
  `wss://.../api/meta-glasses/session?device_id=X`

Deberías ver un punto pulsante junto al nombre de tus lentes en la página de
Lentes Meta del dashboard cuando la sesión esté activa.

### 5. Haz tu primer turno de voz

El disparador predeterminado es un botón de pulsar para hablar dentro de la app (DAT
no expone el botón físico de captura de los lentes a apps de terceros al momento de
escribir esto).

- Mantén presionado el botón PTT en la app Android de Crow.
- Habla.
- Suelta.

Tu voz se transmite como PCM por el WebSocket. El gateway la pasa por
STT, envía la transcripción a tu perfil de IA, transmite la respuesta
por TTS y la reproduce en los altavoces de los lentes.

Espera la primera respuesta audible en **1.5–3 segundos** según tu latencia de STT +
IA + TTS. Groq Whisper + un modelo de chat rápido + OpenAI TTS queda
cerca de los 1.5 s.

## Usar los lentes

### Vincular los lentes a un agente

Abre el [Bot Builder](/es/guide/bot-builder), elige o crea un agente y, en su
pestaña **Gateways**, elige el gateway de **Lentes Meta** y selecciona tu dispositivo
emparejado. Elige el modelo de voz rápido del agente y sus perfiles de habla, texto a
voz y visión, y guarda. El dispositivo queda vinculado a ese agente.

A partir de entonces, un turno de voz en esos lentes lo dirige el agente:

- Habla con la **persona** del agente y sigue los **skills** del agente.
- Solo puede llamar a las **herramientas que el agente seleccionó**. Una herramienta
  que el agente no seleccionó está ausente, y una herramienta seleccionada que no tiene
  equivalente de voz se marca en el editor al guardar.
- Aplica la **política de permisos** del agente antes de ejecutar cualquier herramienta.
  Una publicación se degrada a borrador, un envío real se bloquea, y una acción que
  requiere confirmación o está denegada se te dice de viva voz en lugar de ejecutarse
  en silencio.

La vinculación es de un dispositivo a un agente. Elegir un nuevo agente para un
dispositivo libera el vínculo anterior. Para volver al comportamiento simple dirigido
por perfiles, borra la vinculación del dispositivo.

### Haz una pregunta

Presiona el botón PTT. *"¿Qué tengo en el calendario mañana?"* Las herramientas
del agente de Crow (calendario, memoria, etc.) están disponibles para el perfil de
chat, así que los lentes pueden alcanzar todo lo que Crow alcanza.

### "Mira esto" (visión)

Toca el botón de captura de foto en la app. Los lentes capturan una foto vía
DAT, la suben al almacenamiento S3 de Crow y la adjuntan como URL de imagen a
tu siguiente turno de chat. Cualquier perfil de IA con capacidad de visión (`gpt-4o`,
`claude-sonnet-4`, `gemini-2.5-flash`, `llama-4-vision`) la verá.

### Envía una línea para que la digan

Desde la página de Lentes Meta del dashboard, usa el campo **Herramientas de
desarrollador → Say**. Útil para scripts que quieran notificarte a través de los lentes.

```bash
curl -X POST http://localhost:3000/api/meta-glasses/say \
  -H 'Content-Type: application/json' \
  --cookie "$CROW_COOKIE" \
  -d '{"text":"Reminder: stand up"}'
```

### Reproducir música (Funkwhale "manos libres")

Si instalaste el complemento de Funkwhale (disponible en Extensiones)
y configuraste almacenamiento compartido MinIO/S3, los lentes pueden reproducir tu
biblioteca por sus altavoces de conducción ósea sin que jamás saques el teléfono.

Instala y configura una sola vez:

1. Agrega la configuración de MinIO en **Configuración → Multi-instancia →
   Almacenamiento compartido** (un solo endpoint, aplica a cada instancia de Crow
   emparejada).
2. Instala el complemento de Funkwhale desde Extensiones. El gateway inyecta
   automáticamente las credenciales `AWS_*` en el contenedor de Funkwhale, así que
   las subidas de audio aterrizan en el MinIO compartido en lugar del disco local.
3. Define `PROXY_MEDIA=False` en `~/.crow/bundles/funkwhale/.env` (ya es
   el valor predeterminado de instalación para las nuevas instalaciones con
   almacenamiento compartido) para que Funkwhale redirija a URLs prefirmadas de S3
   en lugar de usar X-Accel de nginx.
4. Genera un token de acceso personal en la interfaz web de Funkwhale
   (Settings → Your applications → Register one, con los scopes
   `read write read:libraries read:listenings`), colócalo en
   `~/crow/.env` como `FUNKWHALE_ACCESS_TOKEN` y reinicia el gateway.

Luego di:

> "Reproduce *Comfy in Nautica* de Panda Bear desde mi biblioteca."

La cadena corre completamente del lado del servidor — `fw_search` → `fw_play(track_uuid)`
→ Funkwhale responde 302 hacia una URL prefirmada de MinIO → el gateway la descarga con
`Authorization: Bearer <token>` (el token nunca sale del servidor) → frames binarios
por el WebSocket del dispositivo → `MediaCodec` de Android decodifica →
el `AudioTrack` de `musicTrack` reproduce por los altavoces de los lentes.

El **ducking de TTS** es automático: hazle una pregunta a Crow a mitad de la
reproducción y el volumen de la música baja a 0.25 mientras Crow habla, y vuelve a 1.0
al terminar. Los mensajes TTS encadenados no quitan el ducking a mitad de la locución
(contador `pendingTtsDucks` por dispositivo).

El mismo sobre `_audio_stream` funciona para cualquier productor de audio futuro —
complementos de pódcast, narración TTS de artículos largos, etc. — solo emite
`{ _audio_stream: { url, codec, auth: "<sentinel>" } }` desde tu herramienta.

```bash
# Push directo del operador para diagnósticos:
curl -X POST http://localhost:3000/api/meta-glasses/stream \
  -H 'Content-Type: application/json' \
  --cookie "$CROW_COOKIE" \
  -d '{"device_id":"<id>","url":"https://...mp3","codec":"mp3"}'
```

## Reproducción de música

Los lentes son un destino completo de reproducción de música. Cuando tú (o la IA)
piden una pista, el audio se transmite desde el gateway a tu teléfono por el WebSocket
de la sesión, se decodifica en el dispositivo vía MediaCodec y se reproduce por los
altavoces de los lentes vía A2DP.

### Comandos de voz

- **"Reproduce Person Pitch de Panda Bear"** → la IA llama a `fw_play_album`,
  pone el álbum en cola y la música comienza.
- **"Reproduce Comfy in Nautica"** → la IA llama a `fw_play` para la pista individual.
- **"Stop"** / **"Pause"** / **"Resume"** / **"Next"** / **"Skip"** — los comandos
  de medios simples se reconocen por una vía rápida que evita el LLM por completo
  (~800 ms de tiempo de respuesta vs ~5–8 s para los comandos mediados por el LLM
  completo).

### Controles táctiles

Instala el [panel de Música](/es/guide/music) para una experiencia de explorar y tocar.
Cada fila de pista tiene un botón **👓 Reproducir en los lentes** que envía el audio a
los lentes con un solo toque — sin necesidad de voz.

### Notificación de medios de Android

Mientras suena la música, aparece una **notificación de medios estándar de Android**
en el área de notificaciones del teléfono y en la pantalla de bloqueo, mostrando:

- La carátula del álbum (obtenida a través de un proxy de carátulas del lado del
  gateway; con protección contra SSRF)
- El título de la pista y el artista
- Botones de reproducir/pausar, siguiente y detener
- Botón de cerrar

La notificación está respaldada por `MediaSessionCompat` + `MediaStyle`, así que:

- Las teclas físicas de reproducir/pausar de los audífonos Bluetooth funcionan
  automáticamente
- En Android 13+, la **tarjeta de medios enriquecida de Quick Settings** aparece junto
  a la notificación del área de notificaciones
- Los toques en los botones de la notificación y los eventos de teclas de medios se
  sincronizan de vuelta al gateway, de modo que el estado de reproducción del lado del
  servidor y la barra de medios persistente del Crow's Nest se mantienen consistentes
  — sin bucles de retroalimentación

### Historial de escucha

Cada pista reproducida por los lentes se registra automáticamente en el historial de
escuchas de Funkwhale. La pestaña **Recientes** del panel de Música y la sección
**Escuchas recientes** del panel de Funkwhale se llenan a partir de esto.

La escucha se registra **después de que la descarga upstream tiene éxito** (no al
solicitarla), así que las descargas fallidas no registran escuchas fantasma. Una
escucha por inicio de pista (no al nivel de scrobble de "50% + 4 minutos").

## Perfiles del hogar

Si compartes tu Crow con la familia, empareja los lentes de cada persona por separado
y asocia cada par con un **perfil de hogar** del Compañero. Así, los lentes de cada
miembro tienen su propia voz (override del perfil de TTS), su propia persona y su
propio alcance de memoria.

En el panel de Lentes Meta, haz clic en **Editar** junto a un dispositivo emparejado y
elige un perfil de hogar + overrides de STT / IA / TTS por dispositivo.

Para un asistente completo por persona, vincula los lentes de cada quien a su propio
agente del [Bot Builder](/es/guide/bot-builder). Cada miembro obtiene entonces una
persona, un conjunto de skills, herramientas delimitadas y una política de permisos
distintos, además de su propia voz, todo desde un mismo Crow compartido.

## Solución de problemas

**El botón "Emparejar lentes nuevos" está deshabilitado.**
Estás viendo la página en un navegador en lugar de la app Android de Crow, o
tu app es anterior a 1.4.0. El banner de compatibilidad en la parte superior de la
página te dice cuál de los dos.

**"No hay sesión activa" cuando presiono el botón PTT.**
Los lentes están desconectados del Bluetooth del teléfono. Reconéctalos
en la app acompañante Meta AI y vuelve a Crow.

**La primera respuesta audible tarda > 5 segundos.**
Revisa tu perfil de STT. OpenAI Whisper agrega ~1 s sobre Groq, y
whisper.cpp autoalojado en CPU puede agregar fácilmente 2–4 s. Asegúrate también de
que tu perfil de TTS transmita en streaming (OpenAI TTS, ElevenLabs y Kokoro lo
hacen; Edge TTS devuelve un solo búfer).

**La opción de palabra de activación se dispara mal todo el tiempo.**
Desactívala. El audio Bluetooth SCO es de banda angosta (16 kHz con artefactos de
códec) y la precisión de la palabra de activación sufre significativamente. Pulsar
para hablar sigue siendo el valor predeterminado confiable.

**La app Android de Crow muere en segundo plano una y otra vez.**
El administrador de batería de tu OEM es agresivo. Desactiva la optimización de
batería para la app de Crow y permítele ejecutarse en segundo plano sin restricciones.

## Referencia de API (protegida por dashboardAuth)

| Método | Ruta | Propósito |
|---|---|---|
| `GET` | `/api/meta-glasses/devices` | Lista los dispositivos emparejados (tokens ocultos) |
| `POST` | `/api/meta-glasses/pair` | Empareja un dispositivo, devuelve `{device, token}` una sola vez |
| `DELETE` | `/api/meta-glasses/devices/:id` | Desempareja |
| `POST` | `/api/meta-glasses/devices/:id` | Actualiza los overrides de perfil por dispositivo |
| `POST` | `/api/meta-glasses/say` | TTS hacia todas las sesiones activas o hacia una |
| `GET` | `wss://.../api/meta-glasses/session` | WebSocket de audio/control por dispositivo |

El protocolo de `/session` está documentado en el `README.md` del complemento.

## Guías relacionadas

- [Música](/es/guide/music) — panel de música nativo de Crow con explorar/buscar/cola y un botón "Reproducir en los lentes"
- [Integración con Funkwhale](/es/integrations/funkwhale) — configuración del servidor y federación
- [Proveedores de IA (BYOAI)](/es/guide/ai-providers)
- La configuración de voz a texto vive en `Configuración → Voz a texto` en tu dashboard de Crow
- La configuración de texto a voz vive en `Configuración → Texto a voz` en tu dashboard de Crow
- El complemento **Companion** comparte los mismos perfiles de TTS — si ya tienes voces del Compañero configuradas, los lentes pueden usarlas tal cual

## Licencias y aspectos legales

- El **Meta Wearables Device Access Toolkit** lo distribuye Meta
  bajo sus términos de desarrollador; acéptalos en el flujo de licenciamiento del
  SDK de DAT cuando habilites la versión preliminar en tu cuenta de desarrollador de Meta.
- Este complemento no incluye código de DAT en sí — la app Android depende de
  los artefactos Maven publicados por Meta (`com.meta.wearables:mwdat-*`).
- El firmware de Ray-Ban Meta es propiedad de Meta; esta integración usa solo
  superficies soportadas del SDK.
