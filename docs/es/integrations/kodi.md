---
title: Kodi
---

# Kodi

Controla tu centro multimedia Kodi de forma remota a traves de Crow — explora bibliotecas, gestiona la reproduccion y consulta lo que se esta reproduciendo, todo mediante tu asistente de IA.

## Que obtienes

- Control remoto para la reproduccion de Kodi (reproducir, pausar, detener, saltar, volumen)
- Buscar y explorar bibliotecas multimedia
- Ver el contenido en reproduccion actual
- Navegacion de biblioteca (peliculas, series, musica)
- Pestana automatica de **Control remoto** en el panel Media Hub

## Configuracion

### Paso 1: Habilitar el control remoto HTTP en Kodi

1. Abre Kodi en el dispositivo que deseas controlar
2. Ve a **Ajustes** > **Servicios** > **Control**
3. Activa **Permitir control remoto via HTTP**
4. Configura un **Puerto** (por defecto: 8080)
5. Opcionalmente configura un **Nombre de usuario** y **Contrasena** para autenticacion

::: tip
Si configuras un nombre de usuario y contrasena en Kodi, incluyelos en la URL: `http://usuario:contrasena@192.168.1.100:8080`
:::

### Paso 2: Agregar a Crow

Configura la URL de Kodi en tu archivo `.env` o via **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
KODI_URL=http://192.168.1.100:8080
```

Si configuraste autenticacion en Kodi:

```bash
KODI_URL=http://kodi:micontrasena@192.168.1.100:8080
```

## Herramientas de IA

Una vez conectado, controla Kodi a traves de tu IA:

> "Que se esta reproduciendo en Kodi?"

> "Pausa Kodi"

> "Busca Matrix en Kodi"

> "Reproduce el siguiente episodio"

> "Sube el volumen en Kodi"

> "Explora mi biblioteca de peliculas de Kodi"

## Panel del dashboard

Cuando Kodi esta conectado, el panel Media Hub agrega una pestana de **Control remoto** con:

- **En reproduccion** — contenido actual con miniatura, titulo y progreso
- **Controles de transporte** — reproducir, pausar, detener, saltar, volumen
- **Explorador de biblioteca** — explora peliculas, series y musica por categoria

## Integracion con Media Hub

La pestana de control remoto de Kodi aparece automaticamente en el Media Hub junto a otras integraciones multimedia (Biblioteca de Jellyfin, Plex, IPTV). Todas tus fuentes multimedia en un solo lugar.

## Solucion de problemas

### "Conexion rechazada" o tiempo de espera agotado

- Verifica que el control remoto HTTP este habilitado en Kodi (Ajustes > Servicios > Control)
- Asegurate de que el puerto coincida con lo que configuraste (por defecto: 8080)
- Comprueba que el dispositivo Kodi sea accesible desde tu servidor de Crow

### "401 No autorizado"

Si configuraste un nombre de usuario y contrasena en los ajustes HTTP de Kodi, asegurate de que esten incluidos en la `KODI_URL`.

### Los comandos no funcionan

- Kodi debe estar ejecutandose y no en protector de pantalla ni en modo de espera
- Algunos comandos solo funcionan durante la reproduccion (ej., pausar, saltar)
- Si Kodi esta en una red diferente, usa Tailscale para conectar las redes
