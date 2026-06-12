---
title: Arquitectura del AI Companion
---

# AI Companion

El AI Companion es el front end de voz y avatar de Crow — un personaje animado de [Live2D](https://www.live2d.com/) con voz de entrada y salida, que ejecuta el motor [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) (OLVV) en el contenedor Docker `crow-companion` (puerto `12393`). Es la superficie detrás del [modo kiosko](/es/guide/kiosk-mode) y está vinculado a un agente del [Bot Builder](/es/architecture/bot-builder), lo que lo convierte en el **canal** companion junto a Gmail, Discord y Meta Glasses.

## Diseño: OLVV conserva su bucle; un proxy elige el modelo

A diferencia de los canales de correo/Discord (que enrutan los turnos a través del runtime pi en `bridge.mjs`), el companion **conserva el propio bucle LLM de OLVV**. Ese bucle ya hace tres cosas de las que el companion depende:

- **Herramientas MCP** — OLVV se conecta a los puentes MCP del gateway y ejecuta las llamadas a herramientas por sí mismo.
- **Gestor de ventanas del lado del cliente** — `crow_wm_open` / `crow_wm_media` son herramientas MCP cuyo *efecto* lo entrega `crow-wm.js` (inyectado en el navegador de OLVV) escuchando los eventos `tool_call_status` que **emite el bucle de OLVV**. Enrutar los turnos a través de pi rompería el control de ventanas/medios por voz.
- **Streaming de tokens** — OLVV transmite la respuesta al TTS oración por oración.

Así que, en lugar de reemplazar el bucle, un **proxy de enrutamiento de modelos** delgado se sitúa en el `base_url` de OLVV y solo elige *qué modelo local responde*:

```
Voz/texto → OLVV (STT · bucle LLM · herramientas MCP · Live2D · TTS)
   base_url de OLVV → model-proxy del companion (127.0.0.1:11435/v1)   [global, sin alcance por dispositivo]
        reenvía messages + tools sin cambios · canaliza el stream SSE directo de vuelta
        por turno:  qwen3.5-4b (rápido)  --"!escalate" inicial-->  qwen3.6-35b-a3b
   OLVV ejecuta el bucle de herramientas → emite tool_call_status → crow-wm.js abre ventanas
```

El proxy (`scripts/companion/model-proxy.mjs`, `companion-model-proxy.service`):

- expone `/v1/chat/completions` y `/v1/models` en loopback `:11435` (el contenedor es `network_mode: host`, así que `localhost` lo alcanza);
- enruta cada turno al modelo **rápido** por defecto, cambiando al modelo de **escalado** cuando el último mensaje del usuario comienza con `!escalate` (el token se elimina antes de reenviar);
- **reenvía `messages` + `tools` sin cambios** y canaliza el SSE del upstream de vuelta, de modo que el bucle de herramientas de OLVV, `tool_call_status` y el streaming quedan intactos;
- deshabilita la cadena de pensamiento visible en la ruta rápida (`chat_template_kwargs.enable_thinking=false`) para que el avatar no hable su razonamiento; el escalado conserva el razonamiento para el trabajo agéntico;
- corre globalmente (no por dispositivo): el `base_url` de OLVV es fijo por contenedor, así que **el par de modelos se comparte entre todos los dispositivos de un mismo contenedor companion**.

`generate-config.py` apunta el `base_url` de OLVV al proxy cuando `COMPANION_PROXY_URL` está definida (predeterminado `http://localhost:11435/v1`); quítala para hablar directamente con un modelo.

## Modelos: voz rápida, escalar para trabajo agéntico

| Rol | Proveedor / modelo | Motor | Notas |
|------|------------------|--------|-------|
| Voz rápida (predeterminado) | `crow-voice/qwen3.5-4b` (`:8011`) | vLLM-ROCm | Solo texto. Qwen3.5-4B es nativamente visión-lenguaje, pero su encoder ViT se queda sin memoria (OOM, 256 GiB) bajo el perfilado multimodal de vLLM-ROCm en gfx1151, así que la entrada de imagen/video está deshabilitada (`--limit-mm-per-prompt`). Registrado `alwaysResident` **sin grupo de mutex**, de modo que coexiste con el 35B y nunca puede desalojarlo. |
| Escalado (agéntico) | `crow-chat/qwen3.6-35b-a3b` (`:8003`) | llama.cpp Vulkan | El MoE de uso diario; **multimodal** (mmproj). Los turnos con visión escalan aquí (o a `grackle-vision`). |

La visión en este nodo la sirven el 35B multimodal (estable en Vulkan) y el modelo bajo demanda `grackle-vision` — **no** el 4B rápido — así que un modelo rápido de solo texto no pierde ninguna capacidad; los turnos con imágenes simplemente escalan. Consulta la [orquestación de GPU](/es/architecture/gateway) para el modelo de desalojo por `mutexGroup`.

### Tres registros de modelos

El companion resuelve los modelos a través de `servers/gateway/ai/resolve-profile.js` (`resolveProviderConfig`), que es **primero la tabla `providers` de la BD, con respaldo en `models.json`** — registra un modelo en ambos. Esto es distinto del bridge de pi (`~/.pi/agent/models.json`) y del orquestador (`models.json`).

## Vincular un bot (el canal companion)

Un **dispositivo** companion (una tablet kiosko / pantalla de sala) se vincula a un agente del Bot Builder exactamente igual que un dispositivo Meta Glasses: el registro del dispositivo (`device-store.js`, etiquetado `device_kind:"companion"`) lleva `bound_bot_id`, y el kiosko muestra la persona/avatar de ese bot más los toggles `companion_features` por dispositivo. Configúralo en la pestaña **Gateways** del bot (tipo *AI Companion*). El par de modelos es global (el proxy); la variación por dispositivo es solo persona/avatar/voz/funciones. Consulta el [modo kiosko](/es/guide/kiosk-mode).

## Solución de problemas

- **"error calling the chat endpoint…"** — el `conf.yaml` generado está apuntando OLVV a un endpoint que rechaza la solicitud. Revisa `docker logs crow-companion` para ver el error del upstream. Causas comunes: un perfil de nube que rechaza un arreglo `tools: []` vacío (usa un modelo local, que lo tolera), o un fallo del puente MCP por el que no se carga ninguna herramienta. El puente apunta a los montajes MCP del gateway (`/router`, `/storage`, `/wm`) en `CROW_MCP_BRIDGE_PORT` (predeterminado `3001`); `/router`, `/storage` y `/wm` requieren un token MCP local (genéralo en el panel Connect del dashboard; `generate-config.py` lo lee de la variable de entorno `CROW_LOCAL_MCP_TOKEN` y lo incrusta en `mcp_servers.json` — si no está definida, los puentes reciben 401).
- **El avatar habla su razonamiento** — asegúrate de que la ruta rápida deshabilite el pensamiento (`COMPANION_FAST_DISABLE_THINKING=1`, el predeterminado).
- **Los comandos de ventana/medios no hacen nada** — el puente MCP `crow_wm` no está conectado; verifica `ToolManager initialized with N OpenAI tools` (N>0) en los logs del contenedor.

## Archivos

| Ruta | Rol |
|------|------|
| `bundles/companion/` | contenedor OLVV, `generate-config.py`, `crow-wm.js`, inyectores |
| `scripts/companion/model-proxy.mjs` | proxy de enrutamiento de modelos (rápido → escalado) |
| `scripts/companion/companion-model-proxy.service` | unidad systemd para el proxy |
| `bundles/vllm-rocm-qwen35-4b/` | el bundle del modelo rápido `crow-voice` |
| `bundles/meta-glasses/server/device-store.js` | vinculación de dispositivos (`device_kind`, `companion_features`) |
| `servers/gateway/dashboard/panels/bot-builder.js` | la pestaña de gateway *AI Companion* |
