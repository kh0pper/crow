---
title: Modo kiosco
---

# Modo kiosco

El modo kiosco convierte una pantalla de Crow en un [Compañero de IA](/es/architecture/companion) a pantalla completa — un avatar animado con el que puedes hablar. Es la forma en que una tablet en el mostrador, una pantalla en el estudio o un display de pared se convierte en una superficie de Crow manos libres.

## Iniciar

En [Crow's Nest](/es/architecture/dashboard), haz clic en el botón **Compañero** del encabezado (visible cuando hay un compañero disponible). El avatar se abre a pantalla completa en un overlay; presiona **Esc** o el botón de salida para salir. El estado se recuerda, así que un kiosco dedicado vuelve a entrar al compañero automáticamente al cargar.

Por debajo, el overlay carga el compañero (`:12393`) en un iframe con micrófono/cámara/autoplay concedidos. Si el host del compañero no responde, un error visible reemplaza el marco en blanco y el botón de salida sigue disponible.

## Personalización por dispositivo

Un kiosco es un **dispositivo** vinculado a un agente del [Bot Builder](/es/architecture/bot-builder) — el mismo modelo de vinculación que los [lentes Meta](/es/guide/meta-glasses). Pantallas distintas pueden ejecutar bots distintos:

```
kitchen-tablet → "Chef"  (avatar A · voz A · social desactivado)
studio-display → "Aide"  (avatar B · voz B · social activado)
```

Vincula un dispositivo en la pestaña **Gateways** del bot → tipo **Compañero de IA**:

1. **Dispositivo emparejado** — elige el dispositivo kiosco, o simplemente **escribe un nombre** en el campo "…o empareja un quiosco nuevo" y pulsa Guardar: Crow crea y conecta el dispositivo por ti en un solo paso (sin necesidad del bundle de Lentes Meta). Los dispositivos emparejados en el panel de Lentes Meta también aparecen aquí; los kioscos reutilizan ese almacén, etiquetados con `device_kind:"companion"`.
2. **Avatar** — el modelo Live2D que se renderiza para este kiosco.
3. **Estilo de escucha** — pulsar para hablar, palabra de activación o escucha permanente.
4. **Tiempo de inactividad de voz** — segundos de silencio antes de la animación de mascota/inactividad.
5. **Funciones** — activa o desactiva la animación del avatar/sincronización labial, el modo mascota/inactivo, las funciones sociales (sala de chat y DM) y la integración automática de memoria.

Al guardar se establece el `bound_bot_id` del dispositivo y los toggles se almacenan como `companion_features`. La persona y el avatar surten efecto en la siguiente sesión del kiosco. Los toggles de funciones se aplican en dos capas distintas: las funciones de configuración de dispositivo (`social_chat`, `face_tracking`, estilo de escucha, tiempo de inactividad de voz) se obtienen y aplican en cada carga de página del kiosco, mientras que las funciones de generación de config (`avatar_model`, `memory_integration`) se incorporan a la config generada del compañero y solo surten efecto tras regenerar la config y reiniciar el contenedor. Consulta la [tabla de semántica de `companion_features`](/es/architecture/companion) para el desglose completo.

### Qué es por dispositivo y qué no

| Por dispositivo | Compartido en todo el contenedor |
|------------|-----------------------------|
| Persona, avatar, voz | El **par de modelos** rápido→escalado |
| `companion_features` (animación del avatar, modo mascota, social/chat, memoria) | Los puentes MCP base (`crow-wm`, `crow-storage`) |
| El puente de memoria `crow` (opt-in por bot vía `memory_integration`) | |
| Bot vinculado | |

El par de modelos se comparte porque un contenedor de compañero tiene un único `base_url` de LLM (el [router `/llm/v1` del gateway](/es/architecture/companion)). El conjunto de herramientas MCP se comparte *en su mayor parte* — todos los personajes reciben `crow-wm` y `crow-storage` — pero el puente de memoria `crow` se añade por bot cuando su función `memory_integration` está habilitada (un ajuste de generación de config; consulta [Puentes MCP](/es/architecture/companion)). Un kiosco que de verdad necesite un par de modelos *distinto* necesita su **propio contenedor de compañero** (puerto propio + `conf.yaml`).

## Funciones sociales / de chat

La sala de chat y los DM del compañero están controlados por el toggle por dispositivo `social_chat`, de modo que un kiosco de cara al público puede funcionar solo con el avatar (sin UI social) mientras una pantalla personal conserva el chat completo. Actívalo o desactívalo en la pestaña Gateways.

## Relacionado

- [Arquitectura del Compañero de IA](/es/architecture/companion) — el motor, el router de modelos y el escalamiento
- [Bot Builder](/es/guide/bot-builder) — definir el agente que ejecuta un kiosco
- [Lentes Meta](/es/guide/meta-glasses) — el canal de voz hermano y el flujo de emparejamiento de dispositivos
