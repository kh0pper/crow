---
title: Jellyfin
---

# Jellyfin

Conecta Crow a Jellyfin para explorar tu biblioteca multimedia, buscar contenido y controlar la reproduccion a traves de tu asistente de IA.

## Que obtienes

- Buscar en tu biblioteca multimedia (peliculas, series, musica, audiolibros)
- Explorar colecciones y contenido agregado recientemente
- Controlar la reproduccion en dispositivos conectados
- Ver que se esta reproduciendo actualmente
- Pestana automatica de **Biblioteca** en el panel Media Hub

## Configuracion

Crow soporta dos modos para Jellyfin: autoalojamiento via Docker o conexion a una instancia existente.

### Opcion A: Docker (autoalojado)

Instala Jellyfin como un bundle de Crow. Esto ejecuta Jellyfin en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Jellyfin"

O instalalo desde el panel de **Extensiones** en el Crow's Nest.

Despues de la instalacion, configura la ruta a tus archivos multimedia:

```bash
# En tu archivo .env
JELLYFIN_MEDIA_PATH=/ruta/a/tus/multimedia
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Jellyfin"

Jellyfin estara disponible en `http://tu-servidor:8096` para la configuracion inicial (crea una cuenta de administrador y configura las bibliotecas).

### Opcion B: Conectar a Jellyfin existente

Si ya tienes un servidor Jellyfin funcionando, conecta Crow directamente a el.

#### Paso 1: Obtener tu clave de API

1. Abre la interfaz web de Jellyfin
2. Ve a **Panel de control** > **Claves de API** (en la seccion Avanzado)
3. Haz clic en **Agregar** (el boton `+`)
4. Ponle un nombre (ej., "Crow")
5. Copia la clave de API generada

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o via **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
JELLYFIN_URL=http://tu-servidor-jellyfin:8096
JELLYFIN_API_KEY=tu-clave-api-aqui
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Jellyfin a traves de tu IA:

> "Que peliculas he agregado recientemente?"

> "Busca documentales en mi biblioteca"

> "Que se esta reproduciendo ahora?"

> "Reproduce el siguiente episodio de The Expanse en la TV de la sala"

## Integracion con Media Hub

Cuando Jellyfin esta instalado, una pestana de **Biblioteca** aparece automaticamente en el panel Media Hub del Crow's Nest. Esto te da una interfaz visual para explorar tu biblioteca junto a otras fuentes multimedia.

## Referencia de Docker Compose

Si prefieres una configuracion manual de Docker en lugar del instalador de bundles:

```yaml
services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    container_name: crow-jellyfin
    ports:
      - "8096:8096"
    volumes:
      - jellyfin-config:/config
      - jellyfin-cache:/cache
      - ${JELLYFIN_MEDIA_PATH:-/media}:/media:ro
    restart: unless-stopped

volumes:
  jellyfin-config:
  jellyfin-cache:
```

## Solucion de problemas

### "Conexion rechazada" o tiempo de espera agotado

Asegurate de que la `JELLYFIN_URL` sea accesible desde la maquina que ejecuta Crow. Si Jellyfin esta en otra maquina, usa la IP o el nombre de host correcto.

### "401 No autorizado"

Es posible que la clave de API haya sido eliminada. Crea una nueva desde Panel de control > Claves de API en Jellyfin.

### Los archivos multimedia no aparecen

Jellyfin necesita escanear tu biblioteca multimedia despues de configurar `JELLYFIN_MEDIA_PATH`. Abre la interfaz web de Jellyfin y activa un escaneo de biblioteca desde Panel de control > Bibliotecas.
