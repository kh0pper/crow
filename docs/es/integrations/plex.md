---
title: Plex
---

# Plex

Conecta Crow a tu Plex Media Server para buscar en tu biblioteca, explorar colecciones y controlar la reproducción a través de tu asistente de IA.

## Qué obtienes

- Buscar en tu biblioteca multimedia (películas, series, música)
- Explorar contenido agregado recientemente y En Espera
- Controlar la reproducción en clientes Plex conectados
- Ver qué se está reproduciendo actualmente
- Integración automática con el panel Media Hub

## Configuración

### Paso 1: Obtener tu token de Plex

Tu token de Plex autentica a Crow con tu servidor. Para encontrarlo:

1. Abre [app.plex.tv](https://app.plex.tv) en tu navegador e inicia sesión
2. Reproduce cualquier contenido o navega a cualquier página de biblioteca
3. Abre las **Herramientas de desarrollador** de tu navegador (F12 o clic derecho > Inspeccionar)
4. Ve a la pestaña **Red** (Network)
5. Busca cualquier solicitud a `plex.tv` o tu servidor — encuentra `X-Plex-Token` en los parámetros de la URL
6. Copia el valor del token

::: tip
El token es una cadena alfanumérica larga como `abc123DEF456`. Aparece como `?X-Plex-Token=...` al final de las URLs de solicitudes API.
:::

Alternativamente, puedes encontrar el token en los archivos de configuración de Plex:

- **macOS**: `~/Library/Application Support/Plex Media Server/Preferences.xml` — busca `PlexOnlineToken`
- **Linux**: `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml`
- **Windows**: `%LOCALAPPDATA%\Plex Media Server\Preferences.xml`

### Paso 2: Encontrar la URL de tu servidor Plex

Esta es la dirección de tu Plex Media Server:

- Local: `http://192.168.1.100:32400` o `http://localhost:32400`
- Tailscale: `http://100.x.x.x:32400`

### Paso 3: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
PLEX_URL=http://tu-servidor-plex:32400
PLEX_TOKEN=tu-token-plex-aqui
```

## Herramientas de IA

Una vez conectado, interactúa con tu biblioteca Plex a través de tu IA:

> "¿Qué películas agregué esta semana?"

> "Muéstrame lo que está En Espera"

> "Busca películas de ciencia ficción en mi biblioteca"

> "Reproduce Blade Runner en el cliente Plex de la sala"

> "¿Qué se está reproduciendo actualmente?"

## Funciones de Plex Pass

Algunas funciones requieren una suscripción activa a Plex Pass:

| Función | Requiere Plex Pass |
|---|---|
| Búsqueda en biblioteca | No |
| Explorar colecciones | No |
| En Espera | No |
| Control de reproducción | No |
| Letras de canciones | Sí |
| Transcodificación por hardware | Sí |
| TV en vivo y DVR | Sí |

La integración de Crow funciona con o sin Plex Pass. Las funciones avanzadas como TV en vivo solo están disponibles si tu suscripción de Plex las soporta.

## Opcional: Autoalojar Plex con Docker

Si aún no tienes Plex funcionando, Crow puede ejecutar uno por ti: abre **Extensiones → Plex** e inícialo allí. Crow lo ejecuta desde el archivo compose de la propia extensión de Plex, así que no hay nada que copiar. Lo que conviene saber:

- **Red del host.** El servidor usa la red del host (lo que recomienda Plex), para que los dispositivos de tu red local puedan descubrirlo. Escucha en el puerto 32400 y en los puertos de descubrimiento de Plex en todas las interfaces de red de esta máquina.
- **`PLEX_MEDIA_PATH` es obligatorio.** Apúntalo a la carpeta que guarda tus medios antes de instalar. Se monta en el servidor en `/data`.
- **Reclama el servidor antes de su primer inicio.** Obtén un claim token en [plex.tv/claim](https://www.plex.tv/claim/) y configúralo como `PLEX_CLAIM_TOKEN`. Hasta que el servidor esté reclamado, la primera persona que lo abra puede reclamarlo.
- **Dónde guarda el servidor su configuración.** En el volumen de Docker `plex-config`, salvo que configures `PLEX_CONFIG_PATH` con una carpeta.
- **`PLEX_ADVERTISE_URL` (opcional).** La URL que usan otros dispositivos para llegar a este servidor, por ejemplo `http://192.168.1.10:32400`. Déjalo vacío para que Plex la descubra.

Si un Plex autoalojado anterior anuncia una dirección rota `http://http://…`, borra **Custom server access URLs** (URL personalizadas de acceso al servidor) en Plex → Settings → Network.

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `PLEX_URL` sea accesible desde el servidor de Crow. Plex usa el puerto 32400 por defecto.

### "401 No autorizado"

Tu token de Plex puede haber expirado o sido revocado. Genera uno nuevo siguiendo los pasos anteriores.

### La biblioteca aparece vacía

Plex necesita escanear tus carpetas multimedia. Abre la interfaz web de Plex, ve a tu biblioteca y haz clic en el icono de actualizar para iniciar un escaneo.
