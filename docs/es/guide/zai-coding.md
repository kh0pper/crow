# Z.AI Coding Plan (Zhipu AI)

El [Z.AI Coding Plan](https://docs.z.ai/guides/overview/quick-start) es una suscripción mensual de Zhipu AI que te da acceso a los modelos GLM a través de una API compatible con OpenAI. Los modelos GLM son fuertes en generación de texto, razonamiento profundo y código — y el plan de coding ofrece acceso de tarifa plana para usarlos con herramientas de programación con IA.

## ¿Por qué Z.AI?

- **Familia de modelos GLM** — Acceso a GLM-5, GLM-4.7 y otras variantes
- **Compatible con OpenAI** — Funciona con cualquier herramienta que soporte la API Chat Completions de OpenAI
- **Endpoint internacional** — Acceso global vía `api.z.ai`
- **Optimizado para código** — Suscripción diseñada para integrarse con herramientas de coding

## Modelos disponibles

| Modelo | Capacidades |
|-------|-------------|
| `glm-5` | Generación de texto, razonamiento profundo |
| `glm-4.7` | Generación de texto, razonamiento profundo |
| `glm-4.7-flash` | Generación de texto rápida |
| `glm-4.7-flashx` | Generación de texto rápida |
| `glm-4.6` | Generación de texto |
| `glm-4.6v` | Generación de texto, comprensión visual |
| `glm-4.5` | Generación de texto |
| `glm-4.5-air` | Generación de texto ligera |
| `glm-4.5-flash` | Generación de texto rápida |
| `glm-4.5v` | Generación de texto, comprensión visual |

::: tip Selección de modelo
Para uso general, empieza con `glm-5` — es el modelo más capaz. Para respuestas más rápidas, prueba `glm-4.7-flash`. Los modelos que terminan en `v` soportan comprensión visual (entrada de imágenes).
:::

## Configuración rápida

### Paso 1: Obtén tu clave de API

1. Ve a [Z.AI](https://z.ai) e inicia sesión
2. Navega a tu página de gestión de claves de API
3. Crea una nueva clave de API
4. Copia la clave (formato: `hexstring.Base64string`)

### Paso 2: Configura en el Crow's Nest

1. Abre tu Crow's Nest → **Settings**
2. Busca la sección **AI Provider**
3. Establece:
   - **Provider:** OpenAI (Z.AI usa una API compatible con OpenAI)
   - **API Key:** Tu clave de Z.AI
   - **Model:** `glm-5` (o cualquier modelo de la tabla de arriba)
   - **Base URL:** `https://api.z.ai/api/coding/paas/v4`
4. Haz clic en **Save** y luego en **Test Connection**
5. Ve a **Messages** → la pestaña **AI Chat** ya está activa

### Alternativa: configuración por `.env`

```env
AI_PROVIDER=openai
AI_API_KEY=your-zai-key-here
AI_MODEL=glm-5
AI_BASE_URL=https://api.z.ai/api/coding/paas/v4
```

No hace falta reiniciar el gateway — la configuración se recarga en caliente.

## Cambiar de modelo

Para cambiar de modelo, actualiza `AI_MODEL` en Settings o en `.env` a cualquier modelo de la tabla de arriba. Todos los modelos usan la misma clave de API y la misma base URL — solo cambia el nombre del modelo.

## Referencia de endpoints

| Propósito | URL |
|---------|-----|
| Coding Plan (internacional) | `https://api.z.ai/api/coding/paas/v4` |
| API estándar (internacional) | `https://api.z.ai/api/paas/v4` |
| API estándar (China continental) | `https://open.bigmodel.cn/api/paas/v4` |

::: warning
El endpoint del **Coding Plan** (`/api/coding/paas/v4`) es distinto del endpoint de la API estándar (`/api/paas/v4`). Usa el correcto según tu tipo de suscripción.
:::

## Solución de problemas

### "API key is invalid (401)"
Asegúrate de estar usando una clave del Coding Plan con el endpoint del Coding Plan. Las claves de la API estándar no funcionan con el endpoint del Coding Plan, y viceversa.

### "Model not found (404)"
Verifica que el nombre del modelo coincida exactamente (distingue mayúsculas de minúsculas). Los modelos disponibles dependen de tu nivel de suscripción.

### Las llamadas a herramientas no funcionan
Los modelos GLM en general soportan llamadas a funciones/herramientas. Si las herramientas no funcionan, prueba `glm-5`, que tiene el soporte de llamadas a herramientas más sólido.

## Recursos

- [Inicio rápido de Z.AI](https://docs.z.ai/guides/overview/quick-start)
- [Configuración de claves de API de Z.AI](https://zcode.z.ai/docs/configuration)
- [Documentación de modelos de Z.AI](https://z.ai/model-api)
