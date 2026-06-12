# Despliegue en la Nube

::: danger Archivado — Ruta de Despliegue Heredada
Esta página documenta el método de despliegue con Render + Turso, que **ya no tiene soporte** y se conserva solo como referencia. El soporte para la base de datos en la nube de Turso fue eliminado de Crow. La sincronización multi-dispositivo ahora se maneja con replicación P2P de Hypercore con SQLite local. Esta guía ya no se mantiene.

Para un servidor gratuito permanente, usa la [guía de Oracle Cloud Free Tier](./oracle-cloud). Para una opción administrada, consulta el [hosting administrado](https://maestro.press/hosting/).
:::

---

## Heredado: Despliegue con Render + Turso

::: warning Limitaciones del Plan Gratuito de Render
- **Se duerme tras 15 minutos** de inactividad — la primera solicitud después de dormir tarda ~30 segundos
- **Disco efímero** — los archivos locales se pierden en cada redespliegue, lo que obliga a usar Turso como base de datos externa
- **Dos dependencias** — necesitas tanto una cuenta de Render como una cuenta de Turso
- **Arranques en frío** — cada vez que el servicio despierta, todas las conexiones MCP deben reconectarse

Para un servidor gratuito que evita todos estos problemas, usa [Oracle Cloud](./oracle-cloud) en su lugar.
:::

### Paso 1: Crea una Base de Datos en Turso

1. Regístrate en [turso.tech](https://turso.tech) (el plan gratuito funciona)
2. Crea una base de datos llamada `crow`
3. Copia tu **Database URL** (empieza con `libsql://`)
4. Crea un token de autenticación y cópialo

> **Nota de seguridad**: Tus credenciales de Turso (URL de la base de datos y token de autenticación) otorgan acceso completo a tu base de datos de Crow. Trátalas como contraseñas — nunca las compartas públicamente ni las subas en tu código. Consulta la [Guía de Seguridad](https://github.com/kh0pper/crow/blob/main/SECURITY.md) para más detalles.

### Paso 2: Despliega en Render

1. Haz un fork del [repositorio de Crow](https://github.com/kh0pper/crow) en GitHub
2. Ve al [panel de Render](https://dashboard.render.com) → **New** → **Blueprint**
3. Conecta tu repositorio bifurcado — Render detectará el `render.yaml`
4. Configura las variables de entorno requeridas:
   - `TURSO_DATABASE_URL` — la URL de tu base de datos de Turso
   - `TURSO_AUTH_TOKEN` — tu token de autenticación de Turso
5. Haz clic en **Apply** — Render desplegará automáticamente

### Paso 3: Inicializa la Base de Datos

Después del despliegue, abre la shell de Render para tu servicio y ejecuta:

```bash
npm run init-db
```

O actívalo a través del endpoint de salud — las tablas de la base de datos se crean automáticamente con la primera solicitud.

### Paso 4: Conecta Tu Plataforma de IA

Una vez desplegado, visita `https://your-service.onrender.com/setup` para ver:

- Qué integraciones están conectadas
- Las URLs de tu endpoint MCP para cada plataforma
- Instrucciones para agregar claves de API

Luego sigue la guía específica de tu plataforma:

- [Claude Web y Móvil](/es/platforms/claude)
- [ChatGPT](/es/platforms/chatgpt)
- [Gemini](/es/platforms/gemini)
- [Grok](/es/platforms/grok)
- [Cursor](/es/platforms/cursor)
- [Windsurf](/es/platforms/windsurf)
- [Cline](/es/platforms/cline)
- [Claude Code](/es/platforms/claude-code)

### Paso 5: Agrega Integraciones (Opcional)

> **Nota de seguridad**: Las claves de API son como contraseñas — cada una otorga acceso a un servicio en tu nombre. Agrega solo las claves de los servicios que realmente necesitas, y nunca las compartas. Si una clave llega a exponerse, revócala de inmediato en el sitio web del servicio y crea una nueva. Consulta la [Guía de Seguridad](https://github.com/kh0pper/crow/blob/main/SECURITY.md) para instrucciones paso a paso.

Agrega claves de API para servicios externos en tu panel de Render, bajo **Environment**:

| Integración | Variable de Entorno | Obtener Clave |
|---|---|---|
| GitHub | `GITHUB_PERSONAL_ACCESS_TOKEN` | [Configuración de GitHub](https://github.com/settings/tokens) |
| Brave Search | `BRAVE_API_KEY` | [API de Brave](https://brave.com/search/api/) |
| Slack | `SLACK_BOT_TOKEN` | [Apps de Slack](https://api.slack.com/apps) |
| Notion | `NOTION_TOKEN` | [Integraciones de Notion](https://www.notion.so/my-integrations) |
| Trello | `TRELLO_API_KEY` + `TRELLO_TOKEN` | [Power-Ups de Trello](https://trello.com/power-ups/admin) |
| Google Workspace | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | [Consola de Google Cloud](https://console.cloud.google.com/apis/credentials) |

Consulta la lista completa en la página de [Integraciones](/es/integrations/).

Después de agregar las claves, Render se reinicia automáticamente. Actualiza tu página `/setup` para confirmar que están conectadas.

::: warning ¿Qué es públicamente accesible después del despliegue?
Cuando se despliega en Render, tu instancia está en la internet pública. Esto es lo que significa:
- **Blog** (`/blog`) — Público, pero solo aparecen los posts que publiques explícitamente con visibilidad `public`
- **Crow's Nest** (`/dashboard`) — Bloqueado para IPs públicas (devuelve 403). Solo accesible desde tu red Tailscale o localhost
- **Endpoints MCP** — Protegidos por OAuth 2.1. Solo los clientes de IA autorizados pueden acceder a tus herramientas
- **Página de configuración** (`/setup`) — Muestra el estado de las conexiones pero nunca expone claves de API

Nada personal es visible a menos que lo publiques. Consulta la [Guía de Seguridad](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default) para más detalles.
:::

### Verifica

```bash
curl https://your-service.onrender.com/health
```

Visita `/setup` en tu URL desplegada para ver el estado de las integraciones y las URLs de los endpoints.

**Pruébalo** — después de conectar tu plataforma de IA, di:

> "Recuerda que hoy es mi primer día usando Crow"
> "¿Qué recuerdas?"

::: tip ¿Muchas integraciones?
Si tienes varias integraciones habilitadas, usa el endpoint `/router/mcp` en lugar de conectar cada servidor individualmente. Consolida toda la superficie de herramientas (más de 126) en 10 herramientas de categoría, una reducción importante de la ventana de contexto. Consulta la [guía de Contexto y Rendimiento](/es/guide/context-performance).
:::

Ahora conecta tu IA: [Claude](/es/platforms/claude) · [ChatGPT](/es/platforms/chatgpt) · [Todas las plataformas](/es/platforms/)
