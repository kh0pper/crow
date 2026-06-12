---
title: motionEye
---

# motionEye

Frontend web ligero para el venerable daemon `motion`. Grabación activada por movimiento, superposición de marcas de tiempo, notificaciones por correo — sin detección de objetos con IA. Amigable con la Pi (corre cómodamente en una Pi 3/4/5 o cualquier SBC con Linux).

Este es el bundle de cámaras **simple / nostálgico**. Si quieres IA ("¿hubo una persona en la puerta de entrada?") o herramientas de cámara invocables vía MCP desde tu asistente de IA, instala [Frigate](./frigate) en su lugar.

## Qué obtienes

- Interfaz web para configurar cámaras RTSP/ONVIF y USB (V4L2)
- Grabación activada por movimiento con retención configurable por cámara
- Notificaciones por correo al detectar movimiento
- Superposición predeterminada de zona horaria/marca de tiempo
- Pestaña iframe en el Crow's Nest — acceso en un solo panel junto a tus demás herramientas

## Qué no obtienes

- Detección de objetos con IA (Frigate sí lo hace)
- Herramientas MCP (`list_cameras`, `list_events`, `snapshot`, etc.) — la API de motionEye usa autenticación de administrador con cookie de sesión + CSRF que no vale la pena envolver para la v1
- Notificaciones de eventos en tiempo real hacia el centro de notificaciones de Crow

## Cuándo usarlo vs Frigate

| | motionEye | Frigate |
|---|---|---|
| Webcams USB (V4L2) | Sí | No |
| RTSP / ONVIF | Sí | Sí |
| Detección de objetos con IA | No | Sí |
| Herramientas MCP | No (solo iframe) | Sí (7 herramientas) |
| Hardware | Amigable con equipos clase Pi | x86 preferido (Pi 5 + Coral funciona) |
| Interfaz | Administración web clásica | SPA moderna en React |
| Huella | 256 MB de RAM como base | 2 GB de RAM como base |

Puedes instalar **ambos**. Coexisten bajo la misma categoría "Cámaras" en el Crow's Nest.

## Configuración

### Instalar el bundle

> "Crow, instala el bundle de motionEye"

O vía **Extensiones** en el Crow's Nest → busca motionEye bajo **Cámaras**.

Usa la imagen oficial multi-arquitectura `ghcr.io/motioneye-project/motioneye:latest` (amd64, arm64, armhf, riscv64), versión 0.43.1 al momento de escribir esto.

Expone el puerto `:8765` en loopback. El iframe del Nest carga motionEye desde esa dirección de loopback, así que no hay exposición pública de la interfaz de cámaras.

### Primer inicio de sesión

Credenciales predeterminadas en el primer arranque:

- **Usuario:** `admin`
- **Contraseña:** (vacía)

**Rótala de inmediato** vía Settings → General → Admin Password. Si el bundle queda expuesto a cualquier red no confiable (cosa que no debería ocurrir por defecto — Crow lo enlaza a loopback), una contraseña de administrador vacía es un agujero catastrófico.

### Agregar una cámara

Dentro de la interfaz web (ya sea en la pestaña iframe del Nest o en `http://localhost:8765` en el host):

1. Haz clic en el menú hamburguesa → **add camera**
2. Elige el tipo de cámara:
   - **Network camera** — pega una URL RTSP (ej., `rtsp://user:pass@192.168.1.42:554/stream`)
   - **V4L2 camera** — elige un dispositivo `/dev/videoN` (webcam USB). Necesitarás pasar el dispositivo en `docker-compose.yml`: agrega `devices: - "/dev/video0:/dev/video0"` bajo el servicio y luego reinicia.
3. Haz clic en OK
4. Configura la sensibilidad de detección de movimiento en Settings → Motion Detection
5. Configura la retención en Settings → Movies → **preserve movies** (cantidad de días; el valor predeterminado es ilimitado — configúralo o tu disco se llenará)

### Almacenamiento

Las grabaciones quedan en `~/.crow/data/motioneye/media/` en el host. `post-install.sh` advierte si el espacio libre en disco cae por debajo de 50 GB y aborta por debajo de 10 GB.

La retención por cámara está en los Settings → Movies de cada cámara. Configúrala. motionEye usa ilimitado por defecto.

## Solución de problemas

**Iframe vacío / "conexión rechazada"**
El contenedor no está corriendo. Inícialo:

```bash
cd ~/.crow/bundles/motioneye && docker compose up -d
```

**La webcam USB no se detecta**
motionEye necesita que el dispositivo se le pase explícitamente:

```yaml
# ~/.crow/bundles/motioneye/docker-compose.yml
services:
  motioneye:
    # ...
    devices:
      - "/dev/video0:/dev/video0"
    # haz coincidir el índice del dispositivo con lo que muestra `ls /dev/video*` en el host
```

Luego `crow bundle restart motioneye`.

**Las grabaciones están llenando el disco**
No configuraste la retención por cámara. Abre los Settings → Movies de cada cámara → **preserve movies** → elige una cantidad de días (7, 14, 30).

**La tarjeta no aparece en el panel de Extensiones**
El bundle se instaló en `~/.crow/bundles/motioneye/` pero falta el symlink del panel. Vuelve a ejecutar:

```bash
~/crow/scripts/crow bundle install motioneye
```

Luego reinicia el gateway.

**Necesitas acceso LAN directo a motionEye (ej., para la app de teléfono)**
Por defecto `:8765` es solo loopback. Para exponerlo en la LAN, edita `~/.crow/bundles/motioneye/docker-compose.yml`:

```yaml
ports:
  - "8765:8765"      # todas las interfaces (no solo loopback)
# o a una IP específica del tailnet:
#  - "100.x.x.x:8765:8765"
```

Luego `crow bundle restart motioneye`. Ten en cuenta que la autenticación integrada de motionEye es más débil que la del gateway de Crow; es preferible mantenerlo en loopback y usar el iframe del Nest.

## Notas de seguridad

- La contraseña de administrador predeterminada está vacía — rótala en el primer inicio de sesión, siempre.
- Enlace de puerto solo a loopback en el archivo compose predeterminado.
- Nunca mapees `/dashboard/motioneye` a un prefijo de Tailscale Funnel — el middleware `rejectFunneled` lo impone, y `tests/auth-network.test.js` tiene una prueba de regresión para ello.
- El directorio de configuración de motionEye contiene el hash de la contraseña de administrador; respalda `~/.crow/data/motioneye/config/` si cambias contraseñas.

## Trabajo futuro

- **Wrapper de herramientas MCP** — motionEye tiene endpoints de administración para snapshot/start/stop/config-get detrás de cookies de sesión + CSRF; una futura v2 podría envolverlos para que la IA pueda pedir "lista mis cámaras de motionEye". No está priorizado mientras Frigate cubre la ruta MCP.
- **Autodetección de USB** — el bundle actual requiere editar `devices:` manualmente para cámaras USB. Un post-install futuro podría escanear `/dev/video*` y generar las entradas del compose.
