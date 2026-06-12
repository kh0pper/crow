---
title: Frigate NVR
---

# Frigate NVR

Sistema de cámaras autoalojado con detección de objetos por IA. Frigate procesa los streams de cámaras RTSP/ONVIF localmente, ejecuta la detección de objetos en CPU (u opcionalmente Coral TPU / iGPU con OpenVINO / GPU con CUDA) y graba clips activados por movimiento. Crow expone cámaras, eventos, snapshots y clips a través de herramientas MCP para que tu asistente de IA pueda razonar sobre lo que está pasando en tu propiedad — sin que ninguna grabación salga de tu red doméstica.

## Qué obtienes

- Detección local de objetos por IA (persona, auto, perro, paquete, etc.)
- Grabación activada por movimiento con retención configurable
- API REST autenticada con JWT en el puerto :8971
- Panel "Cameras" en el Crow's Nest: lista de cámaras, eventos recientes con miniaturas, estadísticas del sistema
- Herramientas MCP para cámaras, eventos, snapshots, clips y activación/desactivación de la detección
- La interfaz web propia de Frigate integrada como pestaña en el panel del Nest

## Cuándo usarlo vs MotionEye

| | Frigate | MotionEye |
|---|---|---|
| Detección de objetos por IA | Sí (local, CPU/Coral/OpenVINO/CUDA) | No |
| Cámaras RTSP / ONVIF | Sí | Sí |
| Webcams USB | No | Sí |
| Hardware | Preferible x86 (Pi 5 + Coral funciona) | Apto para clase Pi |
| Interfaz | SPA moderna en React | Administrador web clásico |
| Herramientas MCP de Crow | Completas (eventos, clips, snapshots, activación de detección) | Solo iframe |

Elige **Frigate** si tienes cámaras RTSP y quieres que "¿quién estuvo en la puerta principal a las 9pm?" se responda automáticamente. Elige **MotionEye** para un despliegue ligero en Pi o configuraciones con webcam USB.

## Configuración

### Instalar el bundle

> "Crow, instala el bundle de Frigate"

O vía **Extensiones** en el Crow's Nest → busca Frigate bajo **Cámaras**.

Esto ejecuta Frigate en Docker usando la imagen oficial `ghcr.io/blakeblackshear/frigate:stable` y expone:

- `:8971` — interfaz + API REST autenticadas (solo loopback)
- `:8554` — restreamer RTSP (solo loopback)
- `:8555` — WebRTC para vista en vivo de baja latencia (LAN)

El puerto `5000` (la API interna no autenticada de Frigate) **intencionalmente no se publica**.

### Contraseña de administrador del primer arranque

Frigate genera una contraseña de administrador en el primer inicio. Encuéntrala en los logs del contenedor:

```bash
docker logs crow-frigate 2>&1 | grep "Password:"
```

Configura esto en `~/.crow/bundles/frigate/.env`:

```bash
FRIGATE_URL=http://localhost:8971
FRIGATE_USER=admin
FRIGATE_PASSWORD=<contraseña de los logs>
```

Luego reinicia el bundle para que el servidor MCP pueda autenticarse:

> "Crow, reinicia el bundle de Frigate"

También deberías iniciar sesión en la interfaz web y rotar la contraseña.

### Agregar una cámara

Edita `~/.crow/data/frigate/config/config.yml` (creado a partir de `bundles/frigate/config.yml.example` durante la instalación). Ejemplo de fuente RTSP:

```yaml
cameras:
  front_door:
    enabled: true
    ffmpeg:
      inputs:
        - path: rtsp://user:pass@192.168.1.42:554/stream
          roles:
            - detect
            - record
    detect:
      width: 1280
      height: 720
      fps: 5
    objects:
      track:
        - person
        - car
        - dog
```

Luego:

> "Crow, reinicia el bundle de Frigate"

La cámara debería aparecer en el panel "Cameras" del Crow's Nest y vía `crow_frigate_list_cameras`.

### Disciplina de disco

La retención por defecto es de **7 días de grabaciones activadas por movimiento**. Fórmula aproximada:

```
GB/día ≈ cámaras × bitrate_mbps × 10.8
```

Una cámara 1080p a 2 Mbps → ~22 GB por 7 días de grabación continua, menos si es solo por movimiento. Verifica el espacio disponible en disco antes de aumentar `record.retain.days`:

```bash
df -h ~/.crow/data/frigate/media
```

El script de instalación del bundle aborta si hay menos de 10 GB libres en el sistema de archivos de destino, y advierte por debajo de 50 GB. Una watchlist de limpieza alerta si el directorio de media supera los 30 GB.

## Herramientas MCP

| Herramienta | Propósito |
|---|---|
| `crow_frigate_list_cameras` | Lista de cámaras con estado de detección/grabación |
| `crow_frigate_list_events` | Eventos filtrados por cámara, etiqueta, ventana de tiempo |
| `crow_frigate_latest_by_label` | Evento más reciente para una etiqueta (ej., "la persona más reciente") |
| `crow_frigate_snapshot` | URL del snapshot de un evento o el más reciente de una cámara |
| `crow_frigate_clip_url` | URL del clip MP4 de un evento |
| `crow_frigate_set_detect` | Activar/desactivar la detección por cámara (destructivo — requiere `confirm: true`) |
| `crow_frigate_stats` | Versión, uptime, tiempo de inferencia del detector, cantidad de procesos |

### Ejemplos de prompts

> "¿Qué cámaras de Frigate tengo?"
> → llama a `crow_frigate_list_cameras`

> "¿Hubo alguien en la puerta principal entre las 8pm y las 10pm de anoche?"
> → llama a `crow_frigate_list_events` con filtros de cámara, label=person, after/before

> "Muéstrame la detección de auto más reciente"
> → llama a `crow_frigate_latest_by_label` con label=car

> "Dame la URL del clip del evento abc123"
> → llama a `crow_frigate_clip_url`

### Compartir snapshots/clips fuera del tailnet

Las URLs de Frigate están autenticadas y funcionan solo desde el gateway de Crow o el iframe del panel del Nest. **NO compartas URLs crudas de Frigate fuera del tailnet** — no funcionarán (el receptor no tiene sesión) y, aunque funcionaran, eso expondría la interfaz de Frigate externamente.

Para compartir externamente: primero sube el archivo vía `crow_upload_file` y luego comparte la URL de almacenamiento de Crow resultante.

## Solución de problemas

**"Cannot reach Frigate"**
El contenedor no está en ejecución. Inícialo:

```bash
cd ~/.crow/bundles/frigate && docker compose up -d
```

**"Frigate authentication expired or invalid"**
`FRIGATE_USER` / `FRIGATE_PASSWORD` en `.env` están mal o faltan. Vuelve a revisar los logs del contenedor para encontrar la contraseña del primer arranque, o usa un usuario que hayas creado en la interfaz web. Reinicia el bundle después de editar `.env`.

**"Frigate endpoint not found"**
Desfase de versiones. Nuestro bundle apunta a `:stable`, que actualmente resuelve a Frigate 0.17. Si una versión futura cambia las rutas de los endpoints, abre un issue.

**El tile no aparece en el panel de Extensiones**
El bundle está instalado en `~/.crow/bundles/frigate/` pero faltan `panels.json` / los symlinks del panel. Vuelve a ejecutar:

```bash
~/crow/scripts/crow bundle install frigate
```

y verifica que `~/.crow/panels/frigate.js` exista. Luego reinicia el gateway.

**No se puede acceder a la pestaña de la interfaz web en el panel del Nest**
La cookie JWT de Frigate es de primera parte para `:8971`. El iframe debe cargarse desde el mismo host donde Frigate está publicado. Si el iframe del panel muestra una página en blanco, confirma que `FRIGATE_URL` apunte a una URL accesible desde el navegador.

## Trabajo futuro

- **Aceleración con Coral TPU** — requiere `libedgetpu1-std` en el host, reglas udev, montar `/dev/bus/usb` y un workaround conocido de re-enumeración USB3. No está cableado en v1.
- **Stream de eventos MQTT** — Frigate puede enviar eventos a MQTT en tiempo real. Conectar esto a las notificaciones de Crow (para que "persona detectada en la puerta principal" se convierta en una notificación push) necesita un broker mosquitto y un puente de eventos a notificaciones.
- **Auto-vinculación con Home Assistant** — funciona en la capa MQTT. Instala tanto el bundle de Home Assistant como un broker para conectarlo.

## Notas de seguridad

- El puerto interno 5000 de Frigate no está autenticado y **deliberadamente no se publica**. No lo expongas.
- El puerto 8971 (interfaz autenticada) está vinculado a loopback por defecto. El panel del Nest hace proxy a través del límite de autenticación del gateway de Crow.
- Nunca mapees `/dashboard/frigate`, `/api/frigate/*` ni `/frigate/*` a un prefijo de Tailscale Funnel — el middleware `rejectFunneled` lo impide, y `tests/auth-network.test.js` tiene una prueba de regresión para ello.
