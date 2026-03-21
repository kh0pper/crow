---
title: IPTV
---

# IPTV

Gestiona listas de reproduccion M3U, explora canales y accede a datos de guia electronica de programas (EPG) a traves de Crow.

## Que obtienes

- Cargar y gestionar listas de reproduccion M3U
- Explorar y buscar canales
- Organizar favoritos y grupos de canales
- Ver la guia de programacion (EPG) desde fuentes XMLTV
- Integracion con Media Hub para explorar canales

## Configuracion

No se requiere contenedor Docker — IPTV se ejecuta como un bundle ligero.

### Instalar el bundle

> "Crow, instala el bundle de IPTV"

O instalalo desde el panel de **Extensiones** en el Crow's Nest.

## Agregar listas de reproduccion

Agrega una URL de lista M3U a traves de tu IA o el panel IPTV:

> "Crow, agrega una lista IPTV: https://ejemplo.com/lista.m3u"

Puedes agregar multiples listas. Los canales de cada lista se combinan en una unica lista navegable.

::: warning
Solo usa listas M3U de servicios a los que tengas una suscripcion legitima. Crow no proporciona ni respalda ningun servicio IPTV especifico.
:::

## Gestion de canales

### Explorar canales

Explora los canales por grupo (segun estan definidos en la lista M3U) o busca por nombre:

> "Muestrame todos los canales de noticias"

> "Busca BBC en mis canales IPTV"

### Favoritos

Marca canales como favoritos para acceso rapido:

> "Crow, agrega CNN a mis favoritos de IPTV"

Los favoritos aparecen en la parte superior de la lista de canales en el panel IPTV.

### Grupos

Los canales se organizan por los grupos definidos en tu lista M3U (ej., Noticias, Deportes, Peliculas). Puedes explorar por grupo en el panel o preguntar:

> "Muestrame mis canales de Deportes"

## Guia electronica de programas (EPG)

Los datos EPG muestran lo que se esta transmitiendo actualmente y los proximos programas de cada canal.

### Agregar una fuente EPG

Proporciona una URL XMLTV junto con tu lista:

> "Crow, configura la fuente EPG a https://ejemplo.com/epg.xml"

O configuralo en **Crow's Nest** > **Ajustes** > **Integraciones**.

### Ver la guia

> "Que hay en CNN ahora mismo?"

> "Muestrame la programacion de esta noche para BBC One"

La guia de programacion tambien esta disponible visualmente en el panel IPTV.

## Planes futuros

- **Grabacion** — Grabacion programada via ffmpeg (planificada para v2)

## Solucion de problemas

### La lista no carga

- Verifica que la URL M3U sea accesible desde tu servidor (intenta abrirla en un navegador)
- Asegurate de que la URL apunte a un archivo `.m3u` o `.m3u8` valido
- Algunos proveedores requieren tokens de autenticacion en la URL

### Faltan datos EPG

- Las URLs de fuentes XMLTV pueden volverse obsoletas — verifica que la URL siga activa
- Los IDs de canal EPG deben coincidir con los atributos `tvg-id` de tu lista M3U
- Los datos EPG pueden tardar unos minutos en descargarse y procesarse la primera vez

### Los canales no se reproducen

Crow gestiona las listas y metadatos. La reproduccion real de los streams depende de tu reproductor multimedia y las condiciones de red. Asegurate de poder reproducir la URL del stream directamente antes de investigar problemas con la integracion de Crow.
