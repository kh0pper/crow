# Guía multiplataforma

Crow te permite usar **cualquier plataforma de IA** — Claude, ChatGPT, Gemini, Grok, Cursor y más — manteniendo la misma memoria persistente, los mismos proyectos y el mismo contexto de comportamiento en todas.

## El problema

Cada plataforma de IA aísla tu contexto:

- ¿Empiezas un proyecto en Claude? ChatGPT no sabe nada de él.
- ¿Guardas preferencias en ChatGPT? Gemini no puede acceder a ellas.
- ¿Acumulas contexto en Cursor? Se queda en Cursor.

Cada vez que cambias de plataforma, empiezas desde cero.

## Cómo lo resuelve Crow

Crow se ubica entre tú y tus plataformas de IA como una capa compartida:

```
┌─────────┐  ┌──────────┐  ┌────────┐  ┌────────┐
│  Claude  │  │ ChatGPT  │  │ Gemini │  │ Cursor │
└────┬─────┘  └────┬─────┘  └───┬────┘  └───┬────┘
     │             │             │            │
     └──────┬──────┴──────┬──────┘            │
            │             │                   │
       ┌────▼─────────────▼───────────────────▼────┐
       │           Crow Gateway (HTTP)             │
       │   OAuth 2.1 · Streamable HTTP · SSE       │
       └────────────────┬──────────────────────────┘
                        │
       ┌────────────────▼──────────────────────────┐
       │          Shared SQLite             │
       │  Memories · Projects · Context · crow.md    │
       └───────────────────────────────────────────┘
```

**Se comparten tres cosas:**

1. **Memorias** — Todo lo que le pidas recordar a cualquier IA se guarda en una sola base de datos. Pregunta desde cualquier plataforma y obtén la misma respuesta.

2. **Proyectos** — Las fuentes, notas, citas y bibliografías se comparten. Empieza un proyecto de investigación en Claude y continúalo en ChatGPT.

3. **Contexto de comportamiento (crow.md)** — Un documento generado dinámicamente que le dice a cada plataforma de IA cómo comportarse como Crow: identidad, protocolos de memoria, reglas de transparencia y tus personalizaciones.

## Inicio rápido: saltar entre plataformas

::: tip Sincronización multi-instancia
Además de usar Crow desde varias plataformas de IA, puedes ejecutar Crow en varias *máquinas* y encadenarlas. Cada instancia sincroniza las memorias automáticamente vía P2P — tu escritorio, tu servidor en la nube y tu Raspberry Pi se mantienen sincronizados. Consulta [Encadenamiento multi-instancia](./instances) e [Inicio rápido multi-dispositivo](/es/getting-started/multi-device).
:::

### Paso 1: Despliega Crow

Sigue la [guía de primeros pasos](/es/getting-started/) para poner en marcha tu gateway. Obtendrás una URL como:
```
https://your-crow-server
```

### Paso 2: Conecta tu primera plataforma

Elige cualquier plataforma de la [página de plataformas](/es/platforms/) y conéctala. Por ejemplo, [Claude Web](/es/platforms/claude):

1. Ve a claude.ai → Settings → Integrations → Add Custom Integration
2. Pega: `https://your-crow-server/memory/mcp`
3. Autoriza y listo.

### Paso 3: Guarda algo

En Claude, di:
> "Recuerda que mi lenguaje de programación preferido es Python y que estoy trabajando en un proyecto de aprendizaje automático sobre datos climáticos."

Crow lo guarda en la base de datos compartida.

### Paso 4: Conecta otra plataforma

Conecta [ChatGPT](/es/platforms/chatgpt) usando el endpoint SSE:
```
https://your-crow-server/memory/sse
```

### Paso 5: Recuerda desde la otra plataforma

En ChatGPT, di:
> "¿Qué sabes sobre mis proyectos?"

ChatGPT, a través de Crow, recupera la memoria que guardaste desde Claude. Los mismos datos, distinta plataforma.

## crow.md — contexto de comportamiento compartido

Más allá de los datos, Crow comparte **instrucciones de comportamiento** entre plataformas a través de `crow.md`. Es un documento generado dinámicamente que define:

- **Identidad**: Quién es Crow, qué hace
- **Protocolo de memoria**: Cuándo y cómo guardar/recuperar memorias
- **Protocolo de proyectos**: Reglas de citación, gestión de proyectos
- **Protocolo de sesión**: Qué hacer al inicio, durante y al final de las sesiones
- **Reglas de transparencia**: Cómo informar sobre las acciones autónomas
- **Referencia de skills**: Tabla de enrutamiento de capacidades
- **Principios clave**: Reglas de comportamiento fundamentales

### Entrega automática

Cuando cualquier IA se conecta a Crow vía MCP, recibe automáticamente una versión condensada de crow.md durante el handshake de conexión. Esto incluye tu identidad, el protocolo de sesión, las reglas de memoria, las pautas de transparencia y la referencia de capacidades — todo antes de que ocurra cualquier llamada a herramientas. No requiere ninguna acción del usuario.

### Prompts bajo demanda

Para una orientación detallada de los flujos de trabajo, la IA puede solicitar prompts MCP:

| Prompt | Descripción |
|---|---|
| `session-start` | Protocolo de inicio/fin de sesión |
| `crow-guide` | crow.md completo (acepta el argumento `platform`) |
| `research-guide` | Orientación del flujo de investigación |
| `blog-guide` | Flujo de publicación del blog |
| `sharing-guide` | Flujo de compartición P2P |

### Acceso manual

| Método | Cuándo usarlo |
|---|---|
| Herramienta `crow_get_context` | Documento completo con datos dinámicos desde cualquier plataforma MCP |
| Recurso `crow://context` | Lectura de recurso MCP |
| `GET /crow.md` | Endpoint HTTP (para plataformas sin MCP) |
| `GET /crow.md?platform=chatgpt` | Formato específico por plataforma |

### Personalizar crow.md

Puedes adaptar el comportamiento de Crow a tus necesidades:

```
"Agrega una sección personalizada de crow.md llamada 'coding_style' que diga
que prefiero la programación funcional, TypeScript y funciones cortas."
```

Crow la guardará como una nueva sección, y aparecerá en el documento de contexto para todas las plataformas.

**Herramientas de gestión:**
- `crow_list_context_sections` — Ver todas las secciones
- `crow_update_context_section` — Modificar cualquier sección
- `crow_add_context_section` — Agregar secciones personalizadas
- `crow_delete_context_section` — Eliminar secciones personalizadas

## Consejos por plataforma

### Claude → ChatGPT
- Las memorias se comparten al instante — sin retraso de sincronización
- ChatGPT usa transporte SSE (no Streamable HTTP)
- Los marcadores de transparencia usan `[corchetes]` en lugar de *cursiva*/*negrita*

### Claude → Cursor/IDE
- Ideal para trabajo enfocado en código con acceso completo a la memoria
- Las plataformas IDE minimizan la salida de transparencia
- Usa `crow_get_context` con `platform: "cursor"` para obtener contexto optimizado para IDE

### Cualquier plataforma → cualquier plataforma
- Todas las plataformas comparten la misma base de datos
- Las memorias guardadas en una están disponibles de inmediato en otra
- Los proyectos, fuentes y notas funcionan igual en todas partes
- crow.md garantiza un comportamiento consistente entre plataformas

## Seguridad

- Cada plataforma se autentica de forma independiente vía OAuth 2.1
- Ninguna plataforma puede acceder a los tokens OAuth de otra
- Todas las plataformas leen y escriben los mismos datos — esa es justamente la idea
- Tú controlas lo que se guarda y puedes eliminar cualquier cosa en cualquier momento

### Clientes locales: el token de conexión

Los clientes en tu propia red (Claude Code, Cursor, una app de escritorio) no necesitan el baile de OAuth. Abre **Conectar** en el dashboard del Crow's Nest para generar un **token MCP local**: se muestra una sola vez, se guarda solo como hash y se verifica del lado del servidor en cada solicitud. Pégalo en la configuración de tu cliente como token bearer, y rótalo o revócalo desde el mismo panel cuando quieras. Un token por instancia — revocarlo desconecta a todos los clientes que lo usan.
