# Opciones de IA Gratuita en la Nube

El asistente de configuración de Crow ofrece tres formas de configurar la IA que impulsa el **AI Chat de BYOAI** (la pestaña Mensajes → AI Chat en el Crow's Nest): descargar un modelo local, pegar la clave API de un proveedor en la nube, o omitir la configuración de IA por ahora. Esta página cubre la segunda opción — pegar una clave de un proveedor en la nube — y lo que realmente cuesta.

Si prefieres correr todo localmente sin ninguna clave API y sin que ningún dato salga de tu máquina, usa la ruta de descarga local del asistente, o consulta la [guía Trae Tu Propio Proveedor de IA (BYOAI)](/es/guide/ai-providers) para el panorama completo de modelos locales (incluyendo Ollama).

## Qué Hace la Opción de Nube del Asistente

Cuando eliges "pegar una clave" en el paso de IA del asistente de configuración, seleccionas uno de cinco proveedores curados, pegas una clave API que generas en el sitio propio de ese proveedor, y el asistente la escribe directamente en la tabla `providers` de Crow — sin necesidad de editar `.env`. Estos cinco coinciden exactamente con lo que trae el asistente (`servers/gateway/dashboard/panels/onboarding/cloud-presets.js`); Crow soporta proveedores adicionales (Ollama, Meta AI, DashScope, Z.AI) también, pero esos no están en el asistente rápido — consulta la [guía BYOAI](/es/guide/ai-providers) para la lista completa y la configuración manual vía `.env`.

::: warning Datos verificados en 2026-07
Los términos de los niveles gratuitos, los montos de crédito y los límites de tasa cambian con frecuencia y quedan enteramente a discreción de cada proveedor — Crow no tiene control sobre ellos ni rastrea cambios automáticamente. Todo lo de abajo fue verificado en **julio de 2026**; trátalo como un punto de partida, no como una garantía, y revisa la página de precios propia del proveedor antes de confiar en un nivel "gratuito" para algo real. Si algo aquí está desactualizado, la página de precios del proveedor siempre es la fuente de verdad.
:::

## OpenAI

- **Regístrate**: [platform.openai.com](https://platform.openai.com/signup)
- **Obtén tu clave**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys) (Dashboard → API keys)
- **Nivel gratuito (verificado 2026-07)**: No confiable. El crédito automático de prueba para cuentas nuevas de OpenAI ha sido inconsistente desde mediados de 2025 — algunas cuentas nuevas todavía reciben un pequeño crédito único, muchas no. Trata a OpenAI como una opción exclusivamente de pago: agrega un método de pago en [platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing) antes de esperar que la API funcione. Modelo por defecto en el asistente: `gpt-4o-mini` (edítalo en el formulario si quieres otro).

## Anthropic

- **Regístrate**: [console.anthropic.com](https://console.anthropic.com)
- **Obtén tu clave**: [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
- **Nivel gratuito (verificado 2026-07)**: Las cuentas nuevas de Console reciben un pequeño crédito único de prueba gratuita tras verificación por SMS. Es pequeño y con tiempo limitado (la ventana para reclamarlo y su vencimiento son ambos cortos — reclámalo y empieza a usarlo el mismo día que creas la cuenta, no esperes), útil para pruebas pero no para uso continuo. Anthropic también tiene un programa de créditos para startups que califiquen, separado de esta prueba por cuenta. Modelo por defecto en el asistente: `claude-sonnet-5`.

## Google AI Studio

- **Regístrate**: [aistudio.google.com](https://aistudio.google.com) (inicia sesión con cualquier cuenta de Google — no hay registro separado)
- **Obtén tu clave**: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) (botón "Get API key")
- **Nivel gratuito (verificado 2026-07)**: Sí — Google AI Studio en sí es gratuito, y las claves API generadas ahí incluyen un nivel gratuito real de la API de Gemini (actualmente las variantes de modelo Flash y Flash-Lite; los modelos de nivel Pro fueron retirados del nivel gratuito a principios de 2026). Tiene límites de tasa (solicitudes por minuto y por día, ambos bastante bajos) en lugar de límites de crédito, y el tráfico del nivel gratuito puede ser usado por Google para mejorar sus modelos — si eso te importa, esa garantía solo aplica al nivel de pago. Modelo por defecto en el asistente: `gemini-2.5-flash`.

## Groq

- **Regístrate**: [console.groq.com](https://console.groq.com)
- **Obtén tu clave**: [console.groq.com/keys](https://console.groq.com/keys)
- **Nivel gratuito (verificado 2026-07)**: Sí, y es el más generoso de los cinco — un nivel de desarrollador genuinamente gratuito, sin tarjeta de crédito, limitado solo por tasas (solicitudes/minuto, tokens/minuto, solicitudes/día), no por un crédito que se agota. Los límites exactos varían según el modelo. Agregar un método de pago eleva los límites y desbloquea un descuento, pero no es necesario para usar el nivel gratuito indefinidamente. Modelo por defecto en el asistente: `llama-3.3-70b-versatile`.

## OpenRouter

- **Regístrate**: [openrouter.ai](https://openrouter.ai)
- **Obtén tu clave**: [openrouter.ai/keys](https://openrouter.ai/keys)
- **Nivel gratuito (verificado 2026-07)**: Sí — OpenRouter ofrece un conjunto rotativo de modelos con sufijo `:free` a costo cero por token, sin tarjeta de crédito requerida. Los límites diarios de solicitudes son bajos hasta que hayas comprado al menos $10 en créditos en algún momento (después de lo cual el límite diario de modelos gratuitos sube considerablemente), y los modelos gratuitos específicos disponibles cambian con el tiempo — revisa [openrouter.ai/models](https://openrouter.ai/models) (filtra por precio) para ver qué es gratuito actualmente antes de elegir uno por defecto. El modelo por defecto en el asistente es `openrouter/auto` (un enrutador automático que elige un modelo adecuado por solicitud, no fijado al nivel gratuito — cámbialo por un modelo específico con sufijo `:free` en el campo de modelo del asistente si quieres garantizar costo cero).

## ¿Cuál Debería Elegir?

- **Solo quiero algo gratis que funcione hoy, sin tarjeta de crédito**: Groq u OpenRouter.
- **Quiero la mejor calidad de razonamiento/código en un nivel gratuito**: Google AI Studio (Gemini Flash) es una opción sólida y genuinamente gratuita.
- **Ya tengo créditos o una suscripción en otro lado** (p. ej. ya pagas por Claude o ChatGPT): Anthropic u OpenAI tienen sentido una vez que agregues facturación, aunque la API se factura por separado de una suscripción de consumidor.
- **No estoy seguro / solo estoy explorando**: elige Groq o Google — ambos funcionan sin costo de configuración, así que puedes cambiar a otro proveedor después sin costo hundido. Cambiar después es solo volver a ejecutar el paso de IA del asistente o editar el proveedor en Ajustes → Proveedor de IA.

## Dónde se Guardan las Claves

Sea cual sea el proveedor para el que pegues una clave, Crow la guarda en la tabla `providers` local de la base de datos de tu Crow's Nest (`~/.crow/data/crow.db` por defecto) — nunca sale de tu máquina excepto en solicitudes hacia la propia API de ese proveedor. Consulta la [sección de Seguridad de la guía BYOAI](/es/guide/ai-providers#seguridad) para el panorama completo, y Ajustes → Proveedor de IA en el panel para cambiar o eliminar una clave más tarde.
