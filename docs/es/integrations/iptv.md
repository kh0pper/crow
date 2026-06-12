---
title: IPTV
---

# IPTV

Gestiona listas de reproducción M3U, explora canales y accede a datos de guía electrónica de programas (EPG) a través de Crow.

## Qué obtienes

- Cargar y gestionar listas de reproducción M3U
- Explorar y buscar canales
- Organizar favoritos y grupos de canales
- Ver la guía de programación (EPG) desde fuentes XMLTV
- Integración con Media Hub para explorar canales

## Configuración

No se requiere contenedor Docker — IPTV se ejecuta como un bundle ligero.

### Instalar el bundle

> "Crow, instala el bundle de IPTV"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

## Agregar listas de reproducción

Agrega una URL de lista M3U a través de tu IA o el panel IPTV:

> "Crow, agrega una lista IPTV: https://ejemplo.com/lista.m3u"

Puedes agregar múltiples listas. Los canales de cada lista se combinan en una única lista navegable.

::: warning
Solo usa listas M3U de servicios a los que tengas una suscripción legítima. Crow no proporciona ni respalda ningún servicio IPTV específico.
:::

## Gestión de canales

### Explorar canales

Explora los canales por grupo (según están definidos en la lista M3U) o busca por nombre:

> "Muéstrame todos los canales de noticias"

> "Busca BBC en mis canales IPTV"

### Favoritos

Marca canales como favoritos para acceso rápido:

> "Crow, agrega CNN a mis favoritos de IPTV"

Los favoritos aparecen en la parte superior de la lista de canales en el panel IPTV.

### Grupos

Los canales se organizan por los grupos definidos en tu lista M3U (ej., Noticias, Deportes, Películas). Puedes explorar por grupo en el panel o preguntar:

> "Muéstrame mis canales de Deportes"

## Guía electrónica de programas (EPG)

Los datos EPG muestran lo que se está transmitiendo actualmente y los próximos programas de cada canal.

### Agregar una fuente EPG

Proporciona una URL XMLTV junto con tu lista:

> "Crow, configura la fuente EPG a https://ejemplo.com/epg.xml"

O configúralo en **Crow's Nest** > **Ajustes** > **Integraciones**.

### Ver la guía

> "¿Qué hay en CNN ahora mismo?"

> "Muéstrame la programación de esta noche para BBC One"

La guía de programación también está disponible visualmente en el panel IPTV.

## Planes futuros

- **Grabación** — Grabación programada vía ffmpeg (planificada para v2)

## Solución de problemas

### La lista no carga

- Verifica que la URL M3U sea accesible desde tu servidor (intenta abrirla en un navegador)
- Asegúrate de que la URL apunte a un archivo `.m3u` o `.m3u8` válido
- Algunos proveedores requieren tokens de autenticación en la URL

### Faltan datos EPG

- Las URLs de fuentes XMLTV pueden volverse obsoletas — verifica que la URL siga activa
- Los IDs de canal EPG deben coincidir con los atributos `tvg-id` de tu lista M3U
- Los datos EPG pueden tardar unos minutos en descargarse y procesarse la primera vez

### Los canales no se reproducen

Crow gestiona las listas y metadatos. La reproducción real de los streams depende de tu reproductor multimedia y las condiciones de red. Asegúrate de poder reproducir la URL del stream directamente antes de investigar problemas con la integración de Crow.
