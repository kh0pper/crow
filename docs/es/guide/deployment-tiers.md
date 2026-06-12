---
title: Niveles de despliegue
---

# Niveles de despliegue

Crow corre en todo, desde una Raspberry Pi Zero 2 W de $15 hasta un servidor en la nube. Esta guía te ayuda a elegir el hardware adecuado y a entender qué puede manejar cada opción.

## Comparación

| Despliegue | RAM | Disco | Ideal para | Limitaciones |
|---|---|---|---|---|
| Raspberry Pi Zero/3 | 512MB–1GB | SD de 16–32GB | Memoria + blog, 1–2 complementos ligeros | Sin Immich, sin Ollama, almacenamiento limitado |
| Raspberry Pi 4/5 | 2–8GB | SD/SSD de 32GB+ | La mayoría de los complementos, almacenamiento moderado | Ollama solo con modelos pequeños, SSD recomendado; ten en cuenta que la escasez de memoria de 2025–26 elevó los precios de la Pi 5 (4GB ≈ $75) |
| Nube gratuita (Render) *(legado)* | 512MB | Efímero | Solo pruebas | Sin complementos Docker, el almacenamiento se reinicia con cada deploy, se duerme por inactividad |
| Oracle Cloud Free Tier | 1–24GB | 50–200GB | Plataforma completa con complementos | Límites de egreso de red, arquitectura ARM |
| Servidor en casa | 4–32GB | 500GB+ | Todo | Depende de la energía y la red |

---

## Raspberry Pi Zero / Pi 3

**Ideal para:** Memoria y blog básicos, con un consumo de energía mínimo.

Estas placas tienen 512MB–1GB de RAM, lo cual basta para correr los servidores centrales de Crow pero no mucho más en simultáneo. Limítate a memoria, proyectos, blog y compartir — son ligeros.

**Complementos a instalar:** memory, blog, sharing
**Complementos a evitar:** Immich (requiere 2GB+ de RAM), Ollama (demasiado lento/grande), Nextcloud (pesado)

**Almacenamiento:** Usa una tarjeta SD Class 10 o con clasificación A1, y monta el directorio de datos (`~/.crow/data/`) en una unidad USB externa si planeas acumular archivos. Las tarjetas SD se desgastan con las escrituras constantes a la base de datos — un SSD vía adaptador USB es muy preferible para cualquier uso más allá del ligero.

**Red:** Tailscale es la forma más fácil de acceder a tu Pi de forma remota sin abrir puertos en el firewall. Para un blog público, combina Crow con Caddy como proxy inverso y un dominio propio. Si estás monetizando un blog o podcast, usa Caddy + un dominio propio — Tailscale Funnel está pensado para uso personal/de hobby y no es apropiado para tráfico comercial.

---

## Raspberry Pi 4 / Pi 5

**Ideal para:** Correr la mayor parte de la plataforma Crow en casa, incluyendo complementos más pesados.

La Pi 4 y la Pi 5 son máquinas capaces. Con 4–8GB de RAM puedes correr Immich, Nextcloud e incluso Ollama con modelos pequeños (del rango de 7B parámetros). La Pi 5 es notablemente más rápida para inferencia de IA en el dispositivo.

**Complementos a instalar:** Todos los complementos centrales. Ollama funciona con modelos 7B en 4GB de RAM, y con modelos más grandes en 8GB.
**Complementos a limitar:** Immich funciona bien pero necesita espacio de disco dedicado para las fotos. No corras varios complementos pesados en simultáneo en un modelo de 2GB.

**Almacenamiento:** Un SSD conectado vía USB 3.0 (o la ranura PCIe de la Pi 5 con un hat M.2) es muy recomendable sobre la SD. SQLite rinde mucho mejor en SSD, y la diferencia de fiabilidad para un servidor en casa es significativa.

**Red:** Igual que la Pi Zero/3 — Tailscale para acceso remoto, Caddy para un blog o podcast de cara al público. El contenido monetizado requiere un dominio propio y un proxy inverso, no Tailscale Funnel.

---

## Nube gratuita (Render) — Legado

**Ideal para:** Ya no se recomienda. Usa el [Oracle Cloud Free Tier](#oracle-cloud-free-tier) en su lugar.

El nivel gratuito de Render te da un servicio web persistente con 512MB de RAM, pero tiene disco efímero — cualquier archivo subido vía el servidor de almacenamiento se pierde cuando la instancia se redespliega. La ruta de despliegue Render + Turso que antes resolvía esta limitación ha sido eliminada. Los despliegues en Render ahora requieren SQLite local en disco efímero, lo que hace que la persistencia de datos no sea fiable.

**Complementos a instalar:** Ninguno — los complementos basados en Docker no están disponibles en el nivel gratuito de Render.

**Almacenamiento:** Solo disco efímero. Los datos no persisten entre redespliegues.

**Inactividad:** Los servicios gratuitos de Render se duermen tras 15 minutos sin solicitudes, lo que agrega una demora de arranque en frío. Pasa a un plan de pago para mantenerlo siempre activo.

**Red:** Render provee una URL HTTPS pública de fábrica. No se necesita Tailscale ni Caddy para el gateway en sí.

---

## Oracle Cloud Free Tier

**Ideal para:** Un despliegue completo de Crow con almacenamiento y complementos, sin costo.

El nivel Always Free de Oracle ofrece hasta 4 núcleos ARM y 24GB de RAM en instancias Ampere, más 50–200GB de almacenamiento en bloque. Es la opción gratuita más capaz. Puedes correr la plataforma completa, incluyendo Immich, Nextcloud y Ollama con modelos medianos.

**Complementos a instalar:** Todos los complementos son viables. Ollama con modelos 13B funciona bien en configuraciones de 16GB+.

**Limitaciones:** Arquitectura ARM — la mayoría de las imágenes Docker soportan ARM64, pero verifica antes de instalar algo inusual. El egreso de red de Oracle es gratuito dentro de la red de la nube, pero el tráfico saliente a internet se cobra más allá de la cuota gratuita (actualmente 10TB/mes, pero verifica los límites vigentes en tu panel de Oracle).

**Almacenamiento:** Los volúmenes en bloque persisten entre reinicios. Adjunta un volumen a `~/.crow/data/` para tu base de datos y archivos.

**Red:** Asigna una IP pública always-free. Usa Caddy como proxy inverso para HTTPS y dominios propios. Para blogs o podcasts monetizados, configura un dominio en regla — Tailscale Funnel no es apropiado para este caso de uso.

---

## Servidor en casa

**Ideal para:** Correr todo sin depender de la nube, con máximo almacenamiento y rendimiento.

Un servidor en casa con 8–32GB de RAM puede correr la plataforma Crow completa más varios complementos pesados en simultáneo. Es la mejor opción si tienes el hardware y quieres control total.

**Complementos a instalar:** Todos. Ollama con modelos grandes (30B+) es viable en máquinas de 16GB+.

**Almacenamiento:** Sin preocupaciones de tarjeta SD. Usa las unidades locales que tengas. Considera un volumen separado para las fotos de Immich si planeas usarlo como tu biblioteca de fotos principal.

**Red:** El ancho de banda de subida de tu internet doméstico es el factor limitante para los visitantes externos. Usa Tailscale para acceso remoto seguro desde tus propios dispositivos. Para un blog o podcast público con dominio propio, corre Caddy en el servidor y configura el reenvío de puertos (o usa Cloudflare Tunnel para evitar exponer puertos directamente). El contenido monetizado requiere una URL pública estable — Tailscale Funnel no es apropiado para este caso de uso.

**Energía y disponibilidad:** Los servidores en casa se caen con los cortes de energía y las interrupciones de internet. Considera un UPS si la disponibilidad importa. Los datos de Crow viven en SQLite y sobreviven sin problemas a los apagados limpios.

---

## Requisitos de recursos por complemento

| Complemento | RAM mín. | Disco mín. | Notas |
|---|---|---|---|
| Ollama | 2GB+ | 5–50GB | Los modelos pequeños (3B) caben en 2GB; los 7B necesitan 4GB+; los 13B+ necesitan 8GB+ |
| Nextcloud | 512MB | 1GB+ | Más el espacio de almacenamiento para tus archivos |
| Immich | 2GB+ | 5GB+ | Más espacio para tu biblioteca de fotos; las funciones de ML necesitan RAM adicional |
| Home Assistant | 256MB | 500MB | Ligero; crece con el número de integraciones |
| Obsidian | 128MB | Mínimo | Solo el servidor MCP — la bóveda vive en disco |

::: tip
La plataforma base de Crow (memoria, proyectos, compartir, blog, gateway) usa aproximadamente 100–200MB de RAM y un espacio de disco mínimo más allá de tus datos. La mayor parte de tu presupuesto de recursos se va en complementos.
:::

## Migrar entre niveles

La ruta de migración es directa: respalda tu directorio `~/.crow/data/` con `npm run backup`, configura Crow en el nuevo hardware y restaura tus datos con `npm run restore`. Tu base de datos, tus archivos y tu identidad viajan contigo.
