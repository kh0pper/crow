# Configuración de Escritorio (Claude Desktop)

Ejecuta Crow localmente con Claude Desktop usando transporte stdio. No necesitas despliegue en la nube — todo corre en tu máquina.

## Requisitos Previos

- [Claude Desktop](https://claude.ai/download) instalado
- [Node.js](https://nodejs.org) 18 o posterior
- Git

## Paso 1: Clona e Instala

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
npm run setup
```

Esto instala las dependencias y crea la base de datos SQLite local en `data/crow.db`.

## Paso 2: Configura las Claves de API

Copia el archivo env de ejemplo y agrega tus claves:

```bash
cp .env.example .env
```

Edita `.env` y agrega claves para los servicios que quieras. Todos los servidores principales (memoria, investigación, compartición, blog) funcionan sin ninguna clave de API — solo el almacenamiento (requiere MinIO) y las integraciones externas necesitan claves.

> **Nota de seguridad**: Tu archivo `.env` contiene claves de API que funcionan como contraseñas. Nunca lo compartas, lo subas a GitHub ni publiques su contenido en ningún lugar. El archivo ya está incluido en `.gitignore` para que git no lo rastree, pero siempre verifica antes de hacer push de tu código. Consulta la [Guía de Seguridad](https://github.com/kh0pper/crow/blob/main/SECURITY.md) para más información sobre cómo mantener tus claves seguras.

## Paso 3: Genera la Configuración de Claude Desktop

```bash
npm run desktop-config
```

Esto genera un bloque JSON para tu configuración de Claude Desktop. Cópialo y agrégalo a:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Paso 4: Reinicia Claude Desktop

Cierra y vuelve a abrir Claude Desktop. Deberías ver los íconos de servidores MCP en el área de entrada, lo que indica que Crow está conectado.

## Verifica y Conecta Tu IA

Comprueba que todo esté funcionando:

```bash
npm run check
```

**Pruébalo** — en Claude Desktop, di:

> "Recuerda que hoy es mi primer día usando Crow"
> "¿Qué recuerdas?"

## Reducir el Uso de Contexto

Por defecto, cada servidor de Crow es una entrada separada en tu configuración de Claude Desktop. Para consumir menos tokens de contexto, usa `npm run mcp-config -- --combined` para generar una sola entrada `crow-core` que activa los servidores bajo demanda. Consulta la [guía de Contexto y Rendimiento](/es/guide/context-performance) para más detalles.

## Limitaciones

- Solo funciona con Claude Desktop (transporte stdio)
- Solo accesible desde la máquina que ejecuta los servidores
- Sin OAuth — conexión directa por proceso
- Para acceso móvil/web, usa el [Despliegue en la Nube](./cloud-deploy) en su lugar

::: tip ¿Quieres acceso remoto?
Encadena esta instancia de escritorio con una instancia en la nube para tener acceso remoto y sincronización. Configura [Oracle Cloud](./oracle-cloud) o [Google Cloud](./google-cloud), y luego [encadénalas](./multi-device) — tus memorias se mantienen sincronizadas en ambas.
:::
