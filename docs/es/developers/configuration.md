# Referencia de configuración

Cada variable de entorno que Crow lee, en un solo lugar. Crow sigue una filosofía de **cero configuración primero**: el gateway arranca sin ningún `.env`, usando los valores predeterminados de abajo. Define variables solo cuando necesites la función que desbloquean.

La configuración vive en `.env` en la raíz del repositorio (copiado desde `.env.example` por `npm run setup`). Después de editarlo, ejecuta `npm run mcp-config` para regenerar la configuración del cliente MCP, y reinicia el gateway.

::: tip Esenciales del día 1
Un operador recién llegado normalmente solo toca estas: `CROW_GATEWAY_URL` (acceso remoto), `MINIO_ENDPOINT` + `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (almacenamiento de archivos) y una o dos claves de API de integraciones. Todo lo demás tiene un valor predeterminado funcional.
:::

## Núcleo (rutas, puertos, identidad)

| Variable | Predeterminado | Propósito |
|---|---|---|
| `CROW_HOME` | `~/.crow` | Directorio base de configuración/datos. Una segunda instancia en la misma máquina usa el suyo propio (p. ej. `~/.crow-mpa`). |
| `CROW_DATA_DIR` | `~/.crow/data` | Raíz de los datos SQLite. |
| `CROW_DB_PATH` | `~/.crow/data/crow.db` | Archivo de base de datos principal. |
| `CROW_GATEWAY_PORT` / `PORT` | `3001` | Puerto de escucha del gateway. |
| `CROW_GATEWAY_BIND` | `0.0.0.0` | Dirección de enlace del gateway. |
| `CROW_GATEWAY_URL` | *(sin definir = solo local)* | URL pública de esta instancia (p. ej. tu dirección HTTPS `*.ts.net`). Requerida para clientes MCP remotos y OAuth. |
| `CROW_DEVICE_ID` | *(sin definir)* | Identidad del dispositivo para los overrides de crow.md por dispositivo (p. ej. `laptop`). |
| `CROW_FILES_PATH` | `/home` | Raíz a la que puede acceder el servidor MCP de sistema de archivos (usada por `npm run mcp-config`). |
| `CROW_JOURNAL_MODE` | auto | Modo de journal de SQLite. Sin definir, Crow elige `WAL`, o `DELETE` en hosts con poca RAM (memoria total ≤ `CROW_WAL_MIN_RAM_GB`, predeterminado 2 GiB — p. ej. VMs de nube de capa gratuita). Defínela explícitamente para anular la selección automática; de lo contrario, déjala en paz. El resolutor lee primero el modo actual de la base de datos y solo lo cambia cuando difiere, así que un cambio de modo nunca traba las conexiones. |
| `NODE_ENV` | `development` | Define `production` en instancias desplegadas. |

## Gateway, autenticación y acceso

| Variable | Predeterminado | Propósito |
|---|---|---|
| `CROW_DASHBOARD_PUBLIC` | `false` | Válvula de escape que permite que el tráfico por Funnel llegue al dashboard. **Déjala apagada** — el invariante de exposición de red depende de ella. |
| `CROW_ALLOWED_IPS` | *(sin definir)* | Lista CIDR adicional de direcciones permitidas para el acceso al dashboard (p. ej. un proxy inverso). |
| `CROW_SETUP_TOKEN` | *(sin definir)* | Token requerido para la configuración inicial de la contraseña cuando está definido. |
| `CROW_CSRF_STRICT` | habilitado | Define `0` solo como interruptor de emergencia para desactivar CSRF. |
| `CORS_ALLOWED_ORIGINS` | *(sin definir)* | Lista de orígenes CORS permitidos, separados por comas. |
| `CROW_ENROLL_ENABLED` | `0` | Permite la inscripción de nuevas instancias (emparejamiento). Habilítala solo mientras emparejas. |
| `CROW_ENROLL_OTC` | *(sin definir)* | Código de un solo uso requerido para la inscripción cuando está definido. |
| `CROW_HOSTED` / `CROW_HOSTING_API_URL` / `CROW_HOSTING_AUTH_TOKEN` | *(sin definir)* | Solo para el modo de hosting administrado. |
| `CROW_CROWDSEC_BOUNCER_KEY` / `CROW_CROWDSEC_LAPI_URL` | *(sin definir)* / `http://127.0.0.1:8091` | Integración con el bouncer de CrowdSec (bundle opcional). |

## IA y modelos

| Variable | Predeterminado | Propósito |
|---|---|---|
| `CROW_ORCHESTRATOR_PROVIDER` / `CROW_ORCHESTRATOR_MODEL` | *(primero la tabla `providers` de la BD)* | Proveedor/modelo predeterminado para el orquestador. Es preferible configurar los proveedores en Configuración → IA. |
| `COMPANION_FAST_MODEL` | `crow-voice/qwen3.5-4b` | Modelo rápido para los turnos de voz del AI Companion. |
| `COMPANION_ESCALATION_MODEL` | `crow-chat/qwen3.6-35b-a3b` | Modelo de escalación (turnos con `!escalate` / herramientas). |
| `COMPANION_FAST_DISABLE_THINKING` | `1` | Desactiva la cadena de razonamiento en los turnos de voz. |
| `COMPANION_TOOL_ESCALATION` | `1` | Escala automáticamente cuando se detecta uso de herramientas. |
| `COMPANION_TOOL_CONTEXT_LOOKBACK` | `8` | Mensajes que se escanean en busca de intención de usar herramientas. |
| `COMPANION_PORT` | `12393` | Puerto del servidor del Companion (Open-LLM-VTuber). |
| `SDXL_SERVICE_URL` | `http://127.0.0.1:3005` | Servicio de generación de imágenes para las herramientas de almacenamiento. |
| `GPU_IDLE_CHECK_INTERVAL_MS` / `GPU_IDLE_REVERT_MS` | `120000` / `1200000` | Sondeo de inactividad del orquestador de GPU / ventana de reversión. |

## Almacenamiento (MinIO / S3)

| Variable | Predeterminado | Propósito |
|---|---|---|
| `MINIO_ENDPOINT` | *(sin definir = almacenamiento desactivado)* | Host de MinIO (o host:puerto). |
| `MINIO_PORT` | del endpoint | Override del puerto. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `crowadmin` / *(requerida)* | Credenciales. |
| `MINIO_USE_SSL` | `false` | TLS hacia MinIO. |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | *(sin definir)* | Cualquier alternativa a MinIO compatible con S3. |
| `MAX_UPLOAD_SIZE` | `104857600` (100 MB) | Límite de subida HTTP (bytes). |
| `STORAGE_QUOTA_MB` | `5120` | Cuota por usuario. |

## Notificaciones y push

| Variable | Predeterminado | Propósito |
|---|---|---|
| `NTFY_HOST` / `NTFY_PORT` | `localhost` / `2586` | Servidor ntfy para push al teléfono. |
| `NTFY_TOPIC` | *(sin definir = desactivado)* | Tema (topic) al que publicar. |
| `NTFY_AUTH_TOKEN` / `NTFY_EXTERNAL_URL` / `NTFY_EXTRA_TOPICS` | *(sin definir)* | Autenticación, URL externa para los enlaces, temas adicionales. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(sin definir = push de PWA desactivado)* | Claves de Web Push (`npx web-push generate-vapid-keys`). |
| `VAPID_EMAIL` | `mailto:admin@localhost` | Contacto VAPID. |
| `RESEND_API_KEY` / `MPA_EMAIL_FROM` / `MPA_EMAIL_TO` | *(sin definir)* | Notificaciones por correo vía Resend. |

## Compartición, P2P y llamadas

| Variable | Predeterminado | Propósito |
|---|---|---|
| `CROW_UNIFIED_DASHBOARD` | habilitado | Dashboard federado entre instancias emparejadas (`0` lo desactiva). |
| `CROW_PEER_TOKENS_PATH` | por `CROW_HOME` | Override del archivo de credenciales de peers (hosts con varios gateways). |
| `CROW_CALLS_ENABLED` | `0` | Función de llamadas WebRTC. |
| `CROW_CALLS_MAX_PEERS` | `4` | Máximo de peers por sala de llamada. |
| `WEBRTC_TURN_URL` / `TURN_SECRET` | *(sin definir)* | Relay TURN para atravesar NAT. |

## Respaldo y operaciones

| Variable | Predeterminado | Propósito |
|---|---|---|
| `CROW_BACKUP_DIR` | `~/.crow/backups` | Salida de `POST /api/admin/backup` (endpoint solo de localhost). |
| `CROW_BACKUP_KEEP_DAYS` | `7` | Retención. |
| `CROW_BACKUP_TOKEN` | *(sin definir)* | Requisito adicional de bearer para el endpoint de respaldo. |
| `CROW_AUTO_UPDATE` | habilitado | Auto-actualización basada en pull (`0` la desactiva). |
| `CROW_SSE_MAX` | `200` | Tope de streams SSE abiertos simultáneamente entre todos los endpoints de streaming; por encima del tope, las solicitudes reciben `503` + `Retry-After: 5`. |
| `CROW_SHUTDOWN_DRAIN_MS` | `3000` | Cuánto espera el apagado ordenado a las solicitudes en curso antes de cortar las conexiones restantes. |
| `CROW_WAL_MIN_RAM_GB` | `2` | Umbral de RAM (GiB) por debajo del cual el modo de journal selecciona automáticamente `DELETE` en lugar de `WAL` (ver `CROW_JOURNAL_MODE`). |
| `CROW_FILEVIEW_ROOT` | directorio home | Raíz que el visor de markdown del dashboard puede leer. |
| `CROW_BUNDLES_DIR` | `~/.crow/bundles` | Directorio de bundles instalados. |

## Avanzado / desarrollador

Estas, de forma intencional, **no** están en `.env.example` — defínelas solo si sabes por qué:
`CROW_DISABLE_ROUTER` (=1 sirve las herramientas crudas por servidor en lugar de las herramientas de categoría), `CROW_ENABLE_TURBO` (=0 desactiva Turbo Drive), `CROW_DEFAULT_SERVER`, `CROW_SKIP_CONFIRM_GATES`, `CROW_SYNC_PROVIDERS`, `CROW_BUNDLE_HOST_ALLOW_ALL`, `STRICT_PANEL_MOUNT`, `CROW_PIPELINE_TRACE`, `CROW_PIPELINE_SUBPROCESS`, `CROW_REFCOUNT_PATH`, `CROW_PET_MODE`, `CROW_PET_SOCKET`, `BLOG_FIGURE_GATEWAY_URL`, `BLOG_FIGURE_PYTHON`, `RENDER_EXTERNAL_URL` (despliegues legados en Render), `CROW_TASKS_DB_PATH`, `MPA_PROSPECTUS_INBOX`/`MPA_PROSPECTUS_OUT`, `JELLYFIN_URL`, `PLEX_URL`, `ROMM_PORT`, `BRAVE_API_KEY` (búsqueda del gestor de ventanas). Overrides de tiempos de espera HTTP (en milisegundos, leídos una sola vez al arrancar): `CROW_HTTP_LLM_CONNECT_TIMEOUT_MS` (predeterminado 20000 — plazo hasta el primer byte para LLM en streaming), `CROW_HTTP_AI_TIMEOUT_MS` (predeterminado 60000 — tope total para llamadas de embeddings con búfer), `CROW_HTTP_TTS_TIMEOUT_MS` (predeterminado 10000 — plazo hasta el primer byte para la síntesis TTS), `CROW_HTTP_VOICELIST_TIMEOUT_MS` (predeterminado 5000 — tope total para obtener las listas de voces).

## Claves de API de integraciones

Las claves de integraciones de terceros (GitHub, Slack, Notion, Google Workspace, Discord, Trello, Canvas, Zotero, …) están documentadas en línea en [`.env.example`](https://github.com/kh0pper/crow/blob/main/.env.example) con enlaces de configuración por servicio, y en cada [página de integración](/es/integrations/). Agrégalas de una en una; todas son opcionales.

## Variables de bundles

Los bundles de autoalojamiento (Caddy, AdGuard, Gitea, Vaultwarden, SearXNG, Netdata, Uptime Kuma, …) leen sus propias variables `*_PORT`/de credenciales, documentadas en las secciones de bundles de `.env.example` y en el manifiesto de cada bundle.

---

*Esta página se mantiene a mano contra el código. Si encuentras una variable en el código que no está listada aquí (o una listada que ya no existe), eso es un bug — repórtalo, por favor.*
