# Claude Web y Móvil

Conecte Crow a Claude en la web (claude.ai) o en la aplicación móvil de Claude mediante Integraciones Personalizadas.

## Requisitos previos

- Gateway de Crow desplegado y funcionando ([Guía de despliegue en la nube](../getting-started/cloud-deploy))
- Un plan Claude Pro, Team o Enterprise (las Integraciones Personalizadas requieren un plan de pago)

## Pasos de configuración

1. Vaya a [claude.ai/settings](https://claude.ai/settings) → **Integrations**
2. Haga clic en **Add Custom Integration**
3. Ingrese un nombre (por ejemplo, "Crow Memory")
4. Pegue la URL de su gateway:
   ```
   https://your-crow-server/memory/mcp
   ```
5. Haga clic en **Save** — Claude iniciará el flujo de OAuth
6. Autorice la conexión cuando se le solicite

Repita el proceso para cada servidor que desee conectar:

| Servidor | URL |
|---|---|
| Memory | `https://your-crow-server/memory/mcp` |
| Projects | `https://your-crow-server/projects/mcp` |
| Sharing | `https://your-crow-server/sharing/mcp` |
| Storage | `https://your-crow-server/storage/mcp` |
| Blog | `https://your-crow-server/blog-mcp/mcp` |
| External Tools | `https://your-crow-server/tools/mcp` |

> **Nota:** El endpoint de storage requiere que MinIO esté configurado. Consulte la [Guía de Storage](/guide/storage) para la configuración.

## Transporte

- **Tipo**: Streamable HTTP
- **Protocolo**: `2025-03-26`
- **Autenticación**: OAuth 2.1 (automática)

## Verificación

Después de conectar, pruebe preguntándole a Claude:

> "Guarda un recuerdo de que Crow ya está conectado."

Si funciona, verá las herramientas de memoria de Crow en acción. Puede verificar los recuerdos almacenados preguntando:

> "¿Qué recuerdas?"

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento durante el handshake de la conexión MCP. Cuando Claude se conecta a cualquier servidor de Crow, recibe la identidad de Crow, los protocolos de memoria, el protocolo de sesión, las reglas de transparencia y la referencia de capacidades, sin necesidad de acción por parte del usuario.

Esto significa que Claude sabe cómo recuperar recuerdos relevantes al inicio de cada conversación, almacenar información importante y seguir las reglas de transparencia desde el primer mensaje.

Para obtener orientación más detallada, Claude puede solicitar prompts de MCP:

- **session-start** — Protocolo detallado de inicio y cierre de sesión
- **crow-guide** — Documento completo de crow.md con todas las secciones de comportamiento
- **research-guide** / **blog-guide** / **sharing-guide** — Guías de flujo de trabajo para funciones específicas

Estos prompts funcionan como equivalentes de skills, proporcionando instrucciones detalladas de flujo de trabajo a Claude bajo demanda sin consumir espacio en la ventana de contexto de antemano.

También puede cargar manualmente el contexto completo:

> "Carga tu contexto de crow.md"

Consulte la [Guía multiplataforma](/guide/cross-platform) para más detalles.

## Optimización de contexto

Claude Code admite notificaciones `toolListChanged`, lo que hace que `crow-core` sea una buena opción para uso local, ya que activa servidores bajo demanda en lugar de cargar todas las herramientas de entrada.

Para Claude a través del gateway, el endpoint `/router/mcp` reduce la cantidad de herramientas de más de 49 a 7 herramientas de categoría consolidadas, lo que reduce significativamente el uso de la ventana de contexto. En lugar de conectar cada servidor individualmente, puede conectar un solo endpoint del router:

```
https://your-crow-server/router/mcp
```

Consulte la guía de [Contexto y rendimiento](/guide/context-performance) para más detalles.

::: tip Compartido con Claude Code CLI
Las Integraciones Personalizadas que agregue aquí también están disponibles en las sesiones de Claude Code CLI, ya que comparten la misma configuración de conectores dentro del ecosistema de Anthropic. Si configura Crow en claude.ai, funciona en Claude Code sin configuración adicional. Este uso compartido entre plataformas es específico de Claude; otras plataformas (ChatGPT, Gemini) gestionan sus conexiones MCP de forma independiente.
:::

## Consejos

- Puede conectar los cinco servidores (memory, projects, sharing, storage, blog) más las herramientas externas simultáneamente
- La aplicación móvil utiliza las mismas Integraciones Personalizadas que la web
- Las herramientas de integraciones externas (GitHub, Slack, etc.) aparecen a través del endpoint `/tools/mcp`
- Los recuerdos almacenados aquí son accesibles instantáneamente desde ChatGPT, Gemini o cualquier otra plataforma conectada
