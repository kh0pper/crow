---
title: Discord
---

# Discord

Conecta Crow a Discord para leer y enviar mensajes en tus servidores a través de tu asistente de IA.

## Qué obtienes

- Leer mensajes de los canales de tus servidores
- Enviar mensajes a canales
- Listar servidores, canales y miembros
- Explorar el historial de mensajes

## Configuración

### Paso 1: Crear una aplicación de Discord

1. Ve al [Portal de desarrolladores de Discord](https://discord.com/developers/applications)
2. Haz clic en **New Application**
3. Ponle un nombre (ej., "Crow") y haz clic en **Create**

### Paso 2: Crear un bot y obtener el token

1. En tu aplicación, ve a **Bot** en la barra lateral izquierda
2. Haz clic en **Reset Token** (o **Add Bot** si es una aplicación nueva)
3. Copia el token del bot — Discord solo lo muestra una vez
4. Bajo **Privileged Gateway Intents**, activa **Message Content Intent**

### Paso 3: Invitar el bot a tu servidor

1. Ve a **OAuth2** → **URL Generator** en la barra lateral izquierda
2. Bajo **Scopes**, marca `bot`
3. Bajo **Bot Permissions**, marca: `Read Messages/View Channels`, `Send Messages`, `Read Message History`
4. Copia la URL generada en la parte inferior y ábrela en tu navegador
5. Selecciona el servidor al que quieres agregar el bot y haz clic en **Autorizar**

### Paso 4: Agregar a Crow

Pega el token de tu bot en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

La variable de entorno es `DISCORD_BOT_TOKEN`.

## Permisos requeridos

| Permiso | Por qué |
|---|---|
| **Message Content Intent** | Leer el contenido de texto de los mensajes (intent privilegiado, debe activarse en los ajustes de Bot) |
| `Read Messages/View Channels` | Ver los canales y sus mensajes |
| `Send Messages` | Publicar mensajes en los canales |
| `Read Message History` | Acceder a mensajes antiguos de los canales |

## Solución de problemas

### El bot está en línea pero no puede leer mensajes

El **Message Content Intent** debe estar activado en el Portal de desarrolladores bajo **Bot** → **Privileged Gateway Intents**. Sin él, el bot recibe los eventos de mensajes pero el campo de contenido llega vacío.

### Error "Missing Access"

El bot no tiene permiso para acceder a ese canal. Revisa las anulaciones de permisos del canal en los ajustes del servidor de Discord para asegurarte de que el rol del bot no tenga el acceso denegado.

### El bot no aparece en el servidor

Vuelve al URL Generator de OAuth2, asegúrate de que el scope `bot` esté seleccionado y vuelve a autorizar con el servidor correcto.
