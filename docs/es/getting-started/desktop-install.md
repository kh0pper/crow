# Instalación de Escritorio

Ejecuta Crow localmente en tu computadora personal. Sin nube, sin servidor — todo se ejecuta en tu máquina y se conecta directamente a tus herramientas de IA mediante transporte stdio.

## Lo Que Obtienes

- Todas las funciones básicas de Crow: memoria, proyectos, compartir, blog
- Conexión directa con Claude Desktop, Claude Code, Cursor, Windsurf, Cline y más
- Base de datos SQLite local — tus datos se quedan en tu máquina
- No necesitas cuentas ni claves API para las funciones básicas

## Requisitos Previos

::: code-group

```bash [macOS]
# Instalar Homebrew si no lo tienes
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Instalar Node.js y Git
brew install node git
```

```bash [Linux (Ubuntu/Debian)]
# Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
```

```powershell [Windows]
# Descargar e instalar Node.js desde https://nodejs.org (versión LTS)
# Git: descargar desde https://git-scm.com/download/win
# O usar winget:
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

:::

Verifica tu instalación:

```bash
node --version   # Debería ser 18.x o posterior
npm --version
git --version
```

## Instalar Crow

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
npm run setup
```

Esto instala las dependencias y crea una base de datos SQLite local. No necesitas claves API ni servicios externos.

## Generar Configuración MCP

```bash
npm run mcp-config
```

Esto crea `.mcp.json` con las rutas de tus servidores locales.

## Conectar a Tu Plataforma de IA

### Claude Desktop

```bash
npm run desktop-config
```

Copia el JSON resultante en tu archivo de configuración de Claude Desktop:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Reinicia Claude Desktop. Busca los iconos de servidor MCP en el área de entrada.

### Claude Code

Claude Code lee automáticamente `.mcp.json` de tu proyecto:

```bash
cd crow
claude
```

### Cursor / Windsurf / Cline

Estos editores leen `.mcp.json` del directorio de tu proyecto. Abre la carpeta `crow` en tu editor y los servidores MCP estarán disponibles.

Consulta la [guía de Plataformas](../../platforms/) para instrucciones detalladas de cada herramienta de IA.

## Opcional: Agregar Integraciones Externas

Edita `.env` para agregar claves API de servicios externos:

```bash
cp .env.example .env
# Edita .env con tu editor preferido
```

Después de editar, regenera la configuración MCP:

```bash
npm run mcp-config
```

## Opcional: Acceso Multi-Dispositivo con Tailscale

Por defecto, tu instalación de escritorio solo funciona en la máquina que ejecuta los servidores. Para acceder a Crow desde tu teléfono u otros dispositivos:

1. Inicia el gateway: `node servers/gateway/index.js`
2. Instala [Tailscale](https://tailscale.com) en esta máquina y tus otros dispositivos
3. Accede a tu Crow en `http://<nombre-tailscale>:3001` desde cualquier dispositivo

## Limitaciones

- Solo accesible desde esta máquina (a menos que agregues Tailscale o el gateway)
- Sin Crow's Nest basado en web (requiere el gateway)
- Sin blog público (requiere el gateway + HTTPS)
- Para acceso remoto desde cualquier dispositivo, consulta [Oracle Cloud](./oracle-cloud) o [Servidor en Casa](./home-server)
