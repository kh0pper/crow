# Registro de asignación de puertos

Este documento es la **única fuente de verdad** para cada puerto del host consumido por Crow mismo, por los bundles en `bundles/` y los reservados por la hoja de ruta del MVP. Cualquier PR de un bundle nuevo que introduzca un binding de puerto debe modificar este archivo en el mismo PR. El CI verifica que:

1. Cada puerto del host en cualquier `bundles/**/docker-compose.yml` esté listado aquí.
2. Ningún par de bundles mapee el mismo puerto del host.

## Convenciones

- Todos los puertos de los bundles se vinculan a `127.0.0.1`, a menos que el bundle sea explícitamente un reverse proxy (Caddy) o use `network_mode: host` (browser, companion, coturn, plex, tailscale, crowdsec-firewall-bouncer).
- Las filas "existente" son bundles que ya se publicaron antes de que se introdujera este registro — se registran aquí para que los bundles futuros los eviten.
- Las filas "reservado" están reclamadas por bundles próximos de la Fase 2; no las consumas para trabajo no relacionado.
- Las filas "MVP" están reclamadas por los bundles del plan MVP actual.

## Conflictos conocidos en el `bundles/` actual

Estos son anteriores a este registro y necesitan una resolución de seguimiento fuera del alcance del MVP:

| Puerto | Conflicto |
|---|---|
| 8080 | LocalAI y Nextcloud se vinculan ambos a 127.0.0.1:8080 — no pueden ejecutarse simultáneamente |

## Tabla de asignación

| Puerto | Binding | Bundle / Servicio | Estado |
|---|---|---|---|
| 22 | host | sshd del host | reservado (sistema) |
| 25 | — | correo SMTP | reservado (correo, Fase 2) |
| 53 | host | DNS del host / systemd-resolved | reservado (sistema) |
| 80 | 0.0.0.0 | Caddy (reverse proxy + ACME HTTP-01) | MVP PR 0.5 |
| 143 | — | correo IMAP | reservado (correo, Fase 2) |
| 443 | 0.0.0.0 | Caddy | MVP PR 0.5 |
| 465 | — | correo SMTPS | reservado (correo, Fase 2) |
| 587 | — | correo submission | reservado (correo, Fase 2) |
| 993 | — | correo IMAPS | reservado (correo, Fase 2) |
| 2222 | — | (evitar: puerto sshd anti-escaneo común en hosts) | evitar |
| 2019 | 127.0.0.1 | API de administración de Caddy (local del host) | MVP PR 0.5 |
| 2223 | 127.0.0.1 | gitea (SSH) | MVP PR 5 |
| 2224 | 127.0.0.1 | forgejo (SSH) | MVP PR 5 |
| 2283 | 127.0.0.1 | immich (existente — verificar en el compose) | existente |
| 3001 | 127.0.0.1 | gateway de Crow (HTTPS) | core |
| 3002 | 127.0.0.1 | gateway de Crow (alterno) | core |
| 3004 | 127.0.0.1 | gateway de Crow (alterno) | core |
| 3007 | 127.0.0.1 | uptime-kuma | MVP PR 1 |
| 3020 | 127.0.0.1 | adguard-home (UI de administración) | MVP PR 3 |
| 3030 | 127.0.0.1 | homepage | MVP PR 1 |
| 3040 | 127.0.0.1 | gitea (web) | MVP PR 5 |
| 3050 | 127.0.0.1 | forgejo (web) | MVP PR 5 |
| 3080 | 127.0.0.1 | romm (existente) | existente |
| 3456 | 127.0.0.1 | vikunja (existente) | existente |
| 4533 | 127.0.0.1 | navidrome (existente) | existente |
| 5000 | 127.0.0.1 | kavita (existente) | existente |
| 5006 | 127.0.0.1 | actual-budget (existente) | existente |
| 5010 | 127.0.0.1 | changedetection | MVP PR 1 |
| 5042 | — | rotki (web/API) | reservado (finanzas, Fase 2) |
| 5080 | — | plausible | reservado (analítica, Fase 2) |
| 5335 | 127.0.0.1 | adguard-home (DNS, TCP+UDP) | MVP PR 3 |
| 5336 | — | pi-hole (DNS) | reservado (DNS, Fase 2) |
| 5337 | — | technitium (DNS) | reservado (DNS, Fase 2) |
| 6080 | 127.0.0.1 | browser (noVNC, existente) | existente |
| 6875 | 127.0.0.1 | bookstack (existente) | existente |
| 8000 | 127.0.0.1 | paperless (existente) | existente |
| 8004 | 127.0.0.1 | faster-whisper-server (STT local) | existente |
| 8080 | 127.0.0.1 | localai (existente) — **también nextcloud, conflicto** | existente |
| 8081 | 127.0.0.1 | calibre-server (existente) | existente |
| 8083 | 127.0.0.1 | calibre-web (existente) | existente |
| 8084 | 127.0.0.1 | wallabag (existente) | existente |
| 8085 | 127.0.0.1 | miniflux (existente) | existente |
| 8086 | 127.0.0.1 | shiori (existente) | existente |
| 8088 | 127.0.0.1 | trilium (existente) | existente |
| 8091 | 127.0.0.1 | crowdsec (LAPI) | MVP PR 4 |
| 8092 | 127.0.0.1 | stirling-pdf | MVP PR 1 |
| 8094 | 127.0.0.1 | gatus | MVP PR 2 |
| 8095 | 127.0.0.1 | dozzle | MVP PR 2 |
| 8096 | 127.0.0.1 | jellyfin (existente) | existente |
| 8097 | 127.0.0.1 | vaultwarden | MVP PR 5 |
| 8098 | 127.0.0.1 | searxng | MVP PR 5 |
| 8530 | 127.0.0.1 | adguard-home (DNS-over-TLS) | MVP PR 3 |
| 8554 | 127.0.0.1 | frigate (retransmisión RTSP) | existente |
| 8555 | 127.0.0.1 | frigate (WebRTC) | existente |
| 8765 | 127.0.0.1 | motioneye | existente |
| 8880 | 127.0.0.1 | kokoro-tts (TTS local) | existente |
| 8971 | 127.0.0.1 | frigate (UI autenticada) | existente |
| 9000 | 127.0.0.1 | minio (API S3, existente) | existente |
| 9001 | 127.0.0.1 | minio (consola, existente) | existente |
| 9090 | 127.0.0.1 | linkding (existente) | existente |
| 11434 | 127.0.0.1 | ollama (existente) | existente |
| 13378 | 127.0.0.1 | audiobookshelf (existente) | existente |
| 18789 | 127.0.0.1 | openclaw-old-docker (proceso externo preexistente) | existente |
| 19999 | 127.0.0.1 | netdata | MVP PR 2 |
| 32400 | host | plex (red del host, existente) | existente |

## Bundles con red del host (sin binding a 127.0.0.1 — usan el stack del host directamente)

Estos bundles usan `network_mode: host`. Consumen directamente en el host los puertos que su servicio upstream espera:

- `browser` (Chrome DevTools — verificar puertos)
- `companion` (verificar)
- `coturn` (3478 UDP, más los puertos de escucha de turnserver)
- `plex` (32400, más los puertos de descubrimiento)
- `tailscale` (MagicDNS, conexiones con peers)
- `crowdsec-firewall-bouncer` (aplazado al PR 4.5 — el upstream no publica una imagen de Docker; necesita un Dockerfile propio y un comando de reversión probado y verificado en un host desechable) — necesitará la red del host para manipular iptables/nftables

## Proceso para modificar este archivo

1. Elige un puerto sin asignar en un rango razonable (UIs de administración en 3000-3099, APIs de backend en 8000-8099, métricas en 19000-19999).
2. Agrega una fila a la tabla con el nombre del bundle y el PR/estado.
3. La verificación de colisión de puertos del CI (`.github/workflows/port-allocation.yml`) comprueba que tu puerto nuevo no choque con otro.
4. Referencia este archivo en la descripción del PR de tu bundle.
