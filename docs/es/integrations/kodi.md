---
title: Kodi
---

# Kodi

Controla tu centro multimedia Kodi de forma remota a través de Crow — explora bibliotecas, gestiona la reproducción y consulta lo que se está reproduciendo, todo mediante tu asistente de IA.

## Qué obtienes

- Control remoto para la reproducción de Kodi (reproducir, pausar, detener, saltar, volumen)
- Buscar y explorar bibliotecas multimedia
- Ver el contenido en reproducción actual
- Navegación de biblioteca (películas, series, música)
- Pestaña automática de **Control remoto** en el panel Media Hub

## Configuración

### Paso 1: Habilitar el control remoto HTTP en Kodi

1. Abre Kodi en el dispositivo que deseas controlar
2. Ve a **Ajustes** > **Servicios** > **Control**
3. Activa **Permitir control remoto vía HTTP**
4. Configura un **Puerto** (por defecto: 8080)
5. Opcionalmente configura un **Nombre de usuario** y **Contraseña** para autenticación

::: tip
Si configuras un nombre de usuario y contraseña en Kodi, inclúyelos en la URL: `http://usuario:contrasena@192.168.1.100:8080`
:::

### Paso 2: Agregar a Crow

Configura la URL de Kodi en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
KODI_URL=http://192.168.1.100:8080
```

Si configuraste autenticación en Kodi:

```bash
KODI_URL=http://kodi:micontrasena@192.168.1.100:8080
```

## Herramientas de IA

Una vez conectado, controla Kodi a través de tu IA:

> "¿Qué se está reproduciendo en Kodi?"

> "Pausa Kodi"

> "Busca Matrix en Kodi"

> "Reproduce el siguiente episodio"

> "Sube el volumen en Kodi"

> "Explora mi biblioteca de películas de Kodi"

## Panel del dashboard

Cuando Kodi está conectado, el panel Media Hub agrega una pestaña de **Control remoto** con:

- **En reproducción** — contenido actual con miniatura, título y progreso
- **Controles de transporte** — reproducir, pausar, detener, saltar, volumen
- **Explorador de biblioteca** — explora películas, series y música por categoría

## Integración con Media Hub

La pestaña de control remoto de Kodi aparece automáticamente en el Media Hub junto a otras integraciones multimedia (Biblioteca de Jellyfin, Plex, IPTV). Todas tus fuentes multimedia en un solo lugar.

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

- Verifica que el control remoto HTTP esté habilitado en Kodi (Ajustes > Servicios > Control)
- Asegúrate de que el puerto coincida con lo que configuraste (por defecto: 8080)
- Comprueba que el dispositivo Kodi sea accesible desde tu servidor de Crow

### "401 No autorizado"

Si configuraste un nombre de usuario y contraseña en los ajustes HTTP de Kodi, asegúrate de que estén incluidos en la `KODI_URL`.

### Los comandos no funcionan

- Kodi debe estar ejecutándose y no en protector de pantalla ni en modo de espera
- Algunos comandos solo funcionan durante la reproducción (ej., pausar, saltar)
- Si Kodi está en una red diferente, usa Tailscale para conectar las redes
