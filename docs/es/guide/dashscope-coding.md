# DashScope Coding Plan (Alibaba Cloud)

El [DashScope Coding Plan de Alibaba Cloud](https://www.alibabacloud.com/help/en/model-studio/coding-plan-quickstart) es una suscripción mensual que te da acceso a múltiples modelos de IA de distintos proveedores a través de una sola clave de API. Incluye modelos de Qwen, Zhipu (GLM), Kimi y MiniMax — todos accesibles mediante una API compatible con OpenAI.

## ¿Por qué DashScope?

- **Acceso multimodelo** — Una sola suscripción cubre los modelos de Qwen, GLM, Kimi y MiniMax
- **Compatible con OpenAI** — Funciona con cualquier herramienta que soporte la API Chat Completions de OpenAI
- **Endpoint internacional** — Endpoint con sede en Singapur para acceso global
- **Asequible** — Precio por suscripción en lugar de facturación por token

## Modelos disponibles

| Modelo | Proveedor | Capacidades |
|-------|----------|-------------|
| `qwen3.5-plus` | Qwen | Generación de texto, razonamiento profundo, comprensión visual |
| `qwen3-max-2026-01-23` | Qwen | Generación de texto, razonamiento profundo |
| `qwen3-coder-next` | Qwen | Generación de texto (enfocado en código) |
| `qwen3-coder-plus` | Qwen | Generación de texto (enfocado en código) |
| `glm-5` | Zhipu | Generación de texto, razonamiento profundo |
| `glm-4.7` | Zhipu | Generación de texto, razonamiento profundo |
| `kimi-k2.5` | Kimi | Generación de texto, razonamiento profundo, comprensión visual |
| `MiniMax-M2.5` | MiniMax | Generación de texto, razonamiento profundo |

::: tip Selección de modelo
Para uso general, empieza con `qwen3.5-plus` — es el modelo más capaz en general. Para tareas de programación, prueba `qwen3-coder-next`. Para razonamiento profundo, `glm-5` y `kimi-k2.5` son opciones sólidas.
:::

## Configuración rápida

### Paso 1: Obtén tu clave de API

1. Ve a la [página de claves de API de DashScope](https://dashscope.console.aliyun.com/apiKey)
2. Haz clic en **Create API Key**
3. Selecciona tu cuenta y el workspace predeterminado
4. Copia la clave (empieza con `sk-sp-`)

::: warning Claves del Coding Plan
Las claves del Coding Plan empiezan con `sk-sp-` y usan un endpoint distinto al de las claves estándar de DashScope (`sk-`). No las confundas — no son intercambiables.
:::

### Paso 2: Configura en el Crow's Nest

1. Abre tu Crow's Nest → **Settings**
2. Busca la sección **AI Provider**
3. Establece:
   - **Provider:** OpenAI (DashScope usa una API compatible con OpenAI)
   - **API Key:** Tu clave `sk-sp-...`
   - **Model:** `qwen3.5-plus` (o cualquier modelo de la tabla de arriba)
   - **Base URL:** `https://coding-intl.dashscope.aliyuncs.com/v1`
4. Haz clic en **Save** y luego en **Test Connection**
5. Ve a **Messages** → la pestaña **AI Chat** ya está activa

### Alternativa: configuración por `.env`

```env
AI_PROVIDER=openai
AI_API_KEY=sk-sp-your-key-here
AI_MODEL=qwen3.5-plus
AI_BASE_URL=https://coding-intl.dashscope.aliyuncs.com/v1
```

No hace falta reiniciar el gateway — la configuración se recarga en caliente.

## Cambiar de modelo

Para cambiar de modelo, actualiza `AI_MODEL` en Settings o en `.env` a cualquier modelo de la tabla de arriba. Todos los modelos usan la misma clave de API y la misma base URL — solo cambia el nombre del modelo.

## Referencia de endpoints

| Propósito | URL |
|---------|-----|
| Compatible con OpenAI (Coding Plan) | `https://coding-intl.dashscope.aliyuncs.com/v1` |
| Compatible con Anthropic (Coding Plan) | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` |
| DashScope estándar (pago por uso) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |

::: warning
El endpoint del **Coding Plan** (`coding-intl.dashscope.aliyuncs.com`) es distinto del endpoint estándar de **pago por uso** (`dashscope-intl.aliyuncs.com`). Usa el correcto según tu tipo de suscripción.
:::

## Solución de problemas

### "API key is invalid (401)"
Asegúrate de estar usando una clave del Coding Plan (`sk-sp-...`) con el endpoint del Coding Plan. Las claves estándar de DashScope no funcionan con el endpoint del Coding Plan, y viceversa.

### "Model not found (404)"
Verifica que el nombre del modelo coincida exactamente (distingue mayúsculas de minúsculas). Los modelos disponibles dependen de tu nivel de suscripción.

### "Rate limited (429)"
El Coding Plan tiene cuotas de uso. Revisa tu [consola de DashScope](https://dashscope.console.aliyun.com) para ver tu uso y límites actuales.

### Las llamadas a herramientas no funcionan
La mayoría de los modelos de DashScope soportan llamadas a funciones/herramientas. Si las herramientas no funcionan, prueba `qwen3.5-plus` o `qwen3-coder-next`, que tienen el soporte de llamadas a herramientas más sólido.

## Recursos

- [Inicio rápido del Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan-quickstart)
- [Gestión de claves de API de DashScope](https://dashscope.console.aliyun.com/apiKey)
- [Referencia de compatibilidad con OpenAI](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)
- [Documentación de Model Studio](https://www.alibabacloud.com/help/en/model-studio/)
