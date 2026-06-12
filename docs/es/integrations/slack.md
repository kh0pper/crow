---
title: Slack
---

# Slack

Conecta Crow a Slack para leer mensajes, publicar actualizaciones e interactuar con canales e hilos a través de tu asistente de IA.

## Qué obtienes

- Leer mensajes de canales e hilos
- Enviar mensajes a canales
- Listar canales y explorar el historial de canales
- Consultar perfiles de usuarios

## Configuración

### Paso 1: Crear una app de Slack

1. Ve a [api.slack.com/apps](https://api.slack.com/apps)
2. Haz clic en **Create New App** → **From scratch**
3. Ponle un nombre (ej., "Crow") y selecciona tu workspace
4. Haz clic en **Create App**

### Paso 2: Agregar scopes de Bot Token

1. En la configuración de tu app, ve a **OAuth & Permissions** en la barra lateral izquierda
2. Desplázate hasta **Scopes** → **Bot Token Scopes**
3. Haz clic en **Add an OAuth Scope** y agrega cada scope listado en **Permisos requeridos** más abajo
4. Desplázate hacia arriba y haz clic en **Install to Workspace**
5. Autoriza la app cuando se te solicite
6. Copia el **Bot User OAuth Token** (empieza con `xoxb-`)

### Paso 3: Invitar el bot a los canales

En Slack, ve a cada canal al que quieras que Crow tenga acceso y escribe `/invite @Crow` (o el nombre que le hayas dado a la app).

### Paso 4: Agregar a Crow

Pega tu bot token en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

La variable de entorno es `SLACK_BOT_TOKEN`.

## Permisos requeridos

| Scope | Por qué |
|---|---|
| `channels:history` | Leer mensajes en canales públicos |
| `channels:read` | Listar canales públicos y sus detalles |
| `chat:write` | Enviar mensajes a los canales donde está el bot |
| `users:read` | Consultar nombres y perfiles de usuarios |

Scopes opcionales para acceso ampliado:

| Scope | Por qué |
|---|---|
| `groups:history` | Leer mensajes en canales privados |
| `groups:read` | Listar canales privados |
| `im:history` | Leer mensajes directos |
| `reactions:read` | Ver reacciones de emoji en los mensajes |

## Solución de problemas

### Error "not_in_channel"

El bot debe ser invitado a cada canal antes de poder leer o publicar mensajes. Usa `/invite @Crow` en el canal.

### Error "missing_scope"

Necesitas agregar el scope faltante en **OAuth & Permissions** y reinstalar la app en tu workspace. Slack requiere la reinstalación después de agregar nuevos scopes.

### El bot no puede ver mensajes anteriores a su ingreso

Los bots de Slack solo pueden acceder al historial de mensajes de los canales a los que fueron invitados. No pueden acceder retroactivamente a mensajes anteriores a la invitación.
