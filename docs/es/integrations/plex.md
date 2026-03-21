---
title: Plex
---

# Plex

Conecta Crow a tu Plex Media Server para buscar en tu biblioteca, explorar colecciones y controlar la reproduccion a traves de tu asistente de IA.

## Que obtienes

- Buscar en tu biblioteca multimedia (peliculas, series, musica)
- Explorar contenido agregado recientemente y En Espera
- Controlar la reproduccion en clientes Plex conectados
- Ver que se esta reproduciendo actualmente
- Integracion automatica con el panel Media Hub

## Configuracion

### Paso 1: Obtener tu token de Plex

Tu token de Plex autentica a Crow con tu servidor. Para encontrarlo:

1. Abre [app.plex.tv](https://app.plex.tv) en tu navegador e inicia sesion
2. Reproduce cualquier contenido o navega a cualquier pagina de biblioteca
3. Abre las **Herramientas de desarrollador** de tu navegador (F12 o clic derecho > Inspeccionar)
4. Ve a la pestana **Red** (Network)
5. Busca cualquier solicitud a `plex.tv` o tu servidor — encuentra `X-Plex-Token` en los parametros de la URL
6. Copia el valor del token

::: tip
El token es una cadena alfanumerica larga como `abc123DEF456`. Aparece como `?X-Plex-Token=...` al final de las URLs de solicitudes API.
:::

Alternativamente, puedes encontrar el token en los archivos de configuracion de Plex:

- **macOS**: `~/Library/Application Support/Plex Media Server/Preferences.xml` — busca `PlexOnlineToken`
- **Linux**: `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml`
- **Windows**: `%LOCALAPPDATA%\Plex Media Server\Preferences.xml`

### Paso 2: Encontrar la URL de tu servidor Plex

Esta es la direccion de tu Plex Media Server:

- Local: `http://192.168.1.100:32400` o `http://localhost:32400`
- Tailscale: `http://100.x.x.x:32400`

### Paso 3: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o via **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
PLEX_URL=http://tu-servidor-plex:32400
PLEX_TOKEN=tu-token-plex-aqui
```

## Herramientas de IA

Una vez conectado, interactua con tu biblioteca Plex a traves de tu IA:

> "Que peliculas agregue esta semana?"

> "Muestrame lo que esta En Espera"

> "Busca peliculas de ciencia ficcion en mi biblioteca"

> "Reproduce Blade Runner en el cliente Plex de la sala"

> "Que se esta reproduciendo actualmente?"

## Funciones de Plex Pass

Algunas funciones requieren una suscripcion activa a Plex Pass:

| Funcion | Requiere Plex Pass |
|---|---|
| Busqueda en biblioteca | No |
| Explorar colecciones | No |
| En Espera | No |
| Control de reproduccion | No |
| Letras de canciones | Si |
| Transcodificacion por hardware | Si |
| TV en vivo y DVR | Si |

La integracion de Crow funciona con o sin Plex Pass. Las funciones avanzadas como TV en vivo solo estan disponibles si tu suscripcion de Plex las soporta.

## Opcional: Autoalojar Plex con Docker

Si aun no tienes Plex funcionando, puedes instalarlo como contenedor Docker:

```yaml
services:
  plex:
    image: plexinc/pms-docker:latest
    container_name: crow-plex
    ports:
      - "32400:32400"
    environment:
      - PLEX_CLAIM=${PLEX_CLAIM_TOKEN}
      - TZ=${TZ:-America/Chicago}
    volumes:
      - plex-config:/config
      - ${PLEX_MEDIA_PATH:-/media}:/media:ro
    restart: unless-stopped

volumes:
  plex-config:
```

Obtiene un claim token desde [plex.tv/claim](https://www.plex.tv/claim/) y configuralo como `PLEX_CLAIM_TOKEN` en tu `.env` antes de la primera ejecucion.

## Solucion de problemas

### "Conexion rechazada" o tiempo de espera agotado

Asegurate de que la `PLEX_URL` sea accesible desde el servidor de Crow. Plex usa el puerto 32400 por defecto.

### "401 No autorizado"

Tu token de Plex puede haber expirado o sido revocado. Genera uno nuevo siguiendo los pasos anteriores.

### La biblioteca aparece vacia

Plex necesita escanear tus carpetas multimedia. Abre la interfaz web de Plex, ve a tu biblioteca y haz clic en el icono de actualizar para iniciar un escaneo.
