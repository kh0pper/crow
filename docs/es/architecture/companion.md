---
title: Arquitectura del AI Companion
---

# AI Companion

El AI Companion es el front end de voz y avatar de Crow — un personaje animado de [Live2D](https://www.live2d.com/) con voz de entrada y salida, que ejecuta el motor [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) (OLVV) en el contenedor Docker `crow-companion` (puerto `12393`). Es la superficie detrás del [modo kiosko](/es/guide/kiosk-mode) y está vinculado a un agente del [Bot Builder](/es/architecture/bot-builder), lo que lo convierte en el **canal** companion junto a Gmail, Discord y Meta Glasses.

## Diseño: OLVV conserva su bucle; el gateway elige el modelo

A diferencia de los canales de correo/Discord (que enrutan los turnos a través del runtime pi en `bridge.mjs`), el companion **conserva el propio bucle LLM de OLVV**. Ese bucle ya hace tres cosas de las que el companion depende:

- **Herramientas MCP** — OLVV se conecta a los puentes MCP del gateway y ejecuta las llamadas a herramientas por sí mismo.
- **Gestor de ventanas del lado del cliente** — `crow_wm_open` / `crow_wm_media` son herramientas MCP cuyo *efecto* lo entrega `crow-wm.js` (inyectado en el navegador de OLVV) escuchando los eventos `tool_call_status` que **emite el bucle de OLVV**. Enrutar los turnos a través de pi rompería el control de ventanas/medios por voz.
- **Streaming de tokens** — OLVV transmite la respuesta al TTS oración por oración.

Así que, en lugar de reemplazar el bucle, el `base_url` de OLVV apunta al **router `/llm/v1`** en proceso del gateway, que solo elige *qué modelo local responde*:

```
Voz/texto → OLVV (STT · bucle LLM · herramientas MCP · Live2D · TTS)
   base_url de OLVV → router /llm/v1 del gateway (http://localhost:3001/llm/v1)   [global, sin alcance por dispositivo]
        reenvía messages + tools sin cambios · canaliza el stream SSE directo de vuelta
        por turno:  qwen3.5-4b (rápido)  --"!escalate" inicial-->  qwen3.6-35b-a3b
   OLVV ejecuta el bucle de herramientas → emite tool_call_status → crow-wm.js abre ventanas
```

El enrutamiento de modelos corre en proceso dentro del gateway: `servers/gateway/routes/llm-router.js` sirve `/llm/v1` (compatible con OpenAI), enrutando cada turno primero al modelo rápido con escalado por `!escalate`. El contenedor companion lo alcanza vía `COMPANION_PROXY_URL` (predeterminado `http://localhost:3001/llm/v1`, ver `bundles/companion/docker-compose.yml`). El router:

- expone `/llm/v1/chat/completions` y `/llm/v1/models`, compatible con OpenAI;
- enruta cada turno al modelo **rápido** por defecto, cambiando al modelo de **escalado** cuando el último mensaje del usuario comienza con `!escalate` (el token se elimina antes de reenviar);
- **reenvía `messages` + `tools` sin cambios** y canaliza el SSE del upstream de vuelta, de modo que el bucle de herramientas de OLVV, `tool_call_status` y el streaming quedan intactos;
- deshabilita la cadena de pensamiento visible en la ruta rápida (`chat_template_kwargs.enable_thinking=false`) para que el avatar no hable su razonamiento; el escalado conserva el razonamiento para el trabajo agéntico;
- corre globalmente (no por dispositivo): el `base_url` de OLVV es fijo por contenedor, así que **el par de modelos se comparte entre todos los dispositivos de un mismo contenedor companion**.

`generate-config.py` apunta el `base_url` de OLVV al router cuando `COMPANION_PROXY_URL` está definida (predeterminado `http://localhost:3001/llm/v1`); quítala para hablar directamente con un modelo.

## Modelos: voz rápida, escalar para trabajo agéntico

| Rol | Proveedor / modelo | Motor | Notas |
|------|------------------|--------|-------|
| Voz rápida (predeterminado) | `crow-voice/qwen3.5-4b` (`:8011`) | vLLM-ROCm | Solo texto. Qwen3.5-4B es nativamente visión-lenguaje, pero su encoder ViT se queda sin memoria (OOM, 256 GiB) bajo el perfilado multimodal de vLLM-ROCm en gfx1151, así que la entrada de imagen/video está deshabilitada (`--limit-mm-per-prompt`). Registrado `alwaysResident` **sin grupo de mutex**, de modo que coexiste con el 35B y nunca puede desalojarlo. |
| Escalado (agéntico) | `crow-chat/qwen3.6-35b-a3b` (`:8003`) | llama.cpp Vulkan | El MoE de uso diario; **multimodal** (mmproj). Los turnos con visión escalan aquí (o a `grackle-vision`). |

La visión en este nodo la sirven el 35B multimodal (estable en Vulkan) y el modelo bajo demanda `grackle-vision` — **no** el 4B rápido — así que un modelo rápido de solo texto no pierde ninguna capacidad; los turnos con imágenes simplemente escalan. Consulta la [orquestación de GPU](/es/architecture/gateway) para el modelo de desalojo por `mutexGroup`.

### Tres registros de modelos

El companion resuelve los modelos a través de `servers/gateway/ai/resolve-profile.js` (`resolveProviderConfig`), que es **primero la tabla `providers` de la BD, con respaldo en `models.json`** — registra un modelo en ambos. Esto es distinto del bridge de pi (`~/.pi/agent/models.json`) y del orquestador (`models.json`).

## Vincular un bot (el canal companion)

Un **dispositivo** companion (una tablet kiosko / pantalla de sala) se vincula a un agente del Bot Builder exactamente igual que un dispositivo Meta Glasses: el registro del dispositivo (`device-store.js`, etiquetado `device_kind:"companion"`) lleva `bound_bot_id`, y el kiosko muestra la persona/avatar de ese bot más los toggles `companion_features` por dispositivo. Configúralo en la pestaña **Gateways** del bot (tipo *AI Companion*). El par de modelos es global (el router `/llm/v1` del gateway); la variación por dispositivo es solo persona/avatar/voz/funciones. Consulta el [modo kiosko](/es/guide/kiosk-mode).

### Semántica de `companion_features`

Las casillas/campos de *AI Companion* en la pestaña Gateways no son uniformes — cada una está conectada en una capa distinta:

| Función | Capa | Predeterminado | Efecto |
|---------|------|-----------------|--------|
| `social_chat` | runtime | apagado | `crow-device-config.js` oculta el panel `#crow-voice-panel` (voz/pares) salvo que sea `true`. |
| `avatar_model` | generación de config | avatar configurado del bot, o el predeterminado | `generate-config.py` elige el modelo Live2D para el preset de personaje del bot. |
| `memory_integration` | generación de config | **apagado — opt-in por bot** | `true` añade el puente `crow` del router (herramientas de categoría memoria/proyectos/blog/compartir) a `mcp_enabled_servers` de ese bot (`bot_mcp_servers()` en `generate-config.py`). Apagado por defecto: el personaje predeterminado de un kiosko compartido no debe buscar en la memoria del propietario a menos que se habilite deliberadamente. El modo hogar (más abajo) lo activa globalmente sin importar la configuración propia de cada bot. |
| `face_tracking` | runtime | **encendido** (solo `=== false` lo deshabilita) | Es una compuerta de disponibilidad, no un opt-in: `false` oculta el botón `#crow-face-tracking-toggle`, bloquea que `toggle()` abra la cámara y — como las funciones se cargan mediante un fetch asíncrono que un clic puede adelantar — desmonta de inmediato una cámara/seguimiento ya en marcha en cuanto llega la bandera `false` (`crow-face-tracking.js` + `crow-device-config.js`). |
| `hearing_style` / `voice_idle_timeout` | plomería de device-config | `push_to_talk` / 30s | Se configuran en la pestaña Gateways del bot (`gw_hearing_style`, `gw_voice_idle_timeout`), se guardan en la fila del gateway y se transmiten a la config del dispositivo. |
| `pet_mode` / `avatar_animation` | almacenado | mascota apagada / animación encendida | `crow-device-config.js` refleja ambos como atributos `data-crow-pet` / `data-crow-anim`; los valores se guardan y se aplican como atributos hoy, pero el comportamiento de modo mascota en el kiosko que deberían impulsar aún no se ha verificado de extremo a extremo en un kiosko real. |

`proactive_speak_prompt` se consideró pero se eliminó — nunca existió un disparador que lo activara, así que quedaba como config muerta.

### Perfiles del hogar

Los perfiles del hogar son un mecanismo **separado y global**, distinto de las funciones por bot: varios usuarios con nombre (hasta 9), cada uno con su propio avatar y voz TTS, compartiendo un mismo contenedor/kiosko companion. Se configuran en **Ajustes → Companion → Hogar** (`bundles/companion/settings-section.js`), no por bot, mediante las variables de entorno `COMPANION_PROFILE_N_NAME` / `_AVATAR` / `_TTS_PROFILE_ID` / `_TTS_VOICE`, leídas por `get_household_profiles()` en `generate-config.py`. Cada perfil se convierte en su propio personaje de OLVV (`crow_profile_<slug>`) cuya persona lleva instrucciones de alcance de memoria por usuario añadidas automáticamente (etiqueta `profile:<slug>` al guardar/buscar, no leer las memorias de otros miembros salvo que se pregunte por ellas).

Definir cualquier perfil del hogar activa un interruptor **global**: `global_mcp_servers()` habilita el puente de memoria `crow` para el personaje predeterminado sin importar el toggle `memory_integration` de ningún bot individual, porque las personas del hogar ya llevan su propio alcance de memoria por perfil en el prompt. Los cambios en las variables de entorno requieren reiniciar el contenedor para aplicarse — `generate-config.py` se ejecuta una sola vez al iniciar el contenedor, no se recarga en caliente.

### Puentes MCP

Todo personaje del companion recibe `crow-wm` (gestor de ventanas) y `crow-storage` (subidas) incondicionalmente — siempre están en `mcp_enabled_servers`. El puente `crow` (herramientas de categoría del router, incluida memoria/proyectos/blog/compartir) es opt-in, controlado de dos formas:

- **Por bot**: solo cuando la función `memory_integration` de ese bot es `true`. El preset de personaje del bot recibe una anulación mínima de `agent_config` con `crow` añadido a `mcp_enabled_servers`, emitida solo cuando difiere del valor global predeterminado.
- **Globalmente**: cuando hay perfiles del hogar definidos, todos los personajes (no solo los bots que optaron por entrar) reciben `crow`.

La razón de privacidad es la misma en ambos casos: el personaje predeterminado de un kiosko compartido no debe poder buscar en la memoria del propietario solo por ejecutarse sobre la infraestructura de Crow — o bien un bot debe activarse deliberadamente, o la persona del perfil del hogar debe llevar su propio alcance de memoria por usuario.

## Solución de problemas

- **"error calling the chat endpoint…"** — el `conf.yaml` generado está apuntando OLVV a un endpoint que rechaza la solicitud. Revisa `docker logs crow-companion` para ver el error del upstream. Causas comunes: un perfil de nube que rechaza un arreglo `tools: []` vacío (usa un modelo local, que lo tolera), o un fallo del puente MCP por el que no se carga ninguna herramienta. El puente apunta a los montajes MCP del gateway (`/router`, `/storage`, `/wm`) en `CROW_MCP_BRIDGE_PORT` (predeterminado `3001`); `/router`, `/storage` y `/wm` requieren un token MCP local (genéralo en el panel Connect del dashboard; `generate-config.py` lo lee de la variable de entorno `CROW_LOCAL_MCP_TOKEN` y lo incrusta en `mcp_servers.json` — si no está definida, los puentes reciben 401).
- **El avatar habla su razonamiento** — asegúrate de que la ruta rápida deshabilite el pensamiento (`COMPANION_FAST_DISABLE_THINKING=1`, el predeterminado).
- **Los comandos de ventana/medios no hacen nada** — el puente MCP `crow_wm` no está conectado; verifica `ToolManager initialized with N OpenAI tools` (N>0) en los logs del contenedor.

## Archivos

| Ruta | Rol |
|------|------|
| `bundles/companion/` | contenedor OLVV, `generate-config.py`, `crow-wm.js`, inyectores |
| `servers/gateway/routes/llm-router.js` | router `/llm/v1` de enrutamiento de modelos en proceso (rápido → escalado) |
| `bundles/vllm-rocm-qwen35-4b/` | el bundle del modelo rápido `crow-voice` |
| `bundles/meta-glasses/server/device-store.js` | vinculación de dispositivos (`device_kind`, `companion_features`) |
| `bundles/companion/scripts/crow-device-config.js` | lado cliente: aplica `companion_features` al kiosko en ejecución (visibilidad de paneles, atributos, desmontaje de cámara) |
| `bundles/companion/scripts/crow-face-tracking.js` | seguimiento facial por cámara + la compuerta de disponibilidad `face_tracking` |
| `bundles/companion/settings-section.js` | Ajustes → Companion del dashboard, incluidos los slots de perfiles del hogar |
| `servers/gateway/dashboard/panels/bot-builder.js` | la pestaña de gateway *AI Companion* |
| `servers/gateway/dashboard/panels/bot-builder/editor.js` | la UI de la pestaña Gateways para `companion_features` (integración de memoria, seguimiento facial, estilo de escucha, etc.) |
