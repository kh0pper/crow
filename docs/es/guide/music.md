---
title: Música
---

# Música

Panel de reproductor de música nativo de Crow. Explora tu biblioteca de Funkwhale, reproduce pistas en tu navegador o en tus lentes Meta emparejados, y recibe notificaciones multimedia estándar al estilo Android en la app de Crow para Android — todo controlado por una sola barra de reproducción persistente que te sigue mientras navegas entre los paneles de Crow's Nest.

::: tip ¿Por qué un panel de Música dedicado?
La interfaz web propia de Funkwhale es capaz, pero vive en su propio origen y no se integra con la barra de reproducción de Crow, los lentes ni los controles multimedia de Android. El panel de Música es una UI delgada y nativa de Crow sobre la API de Funkwhale que se conecta con el resto de la plataforma.
:::

## Qué obtienes

- **Explorar:** artistas → álbumes → pistas, con vistas de cuadrícula + lista aptas para móvil
- **Búsqueda:** búsqueda con debounce entre artistas, álbumes y pistas
- **Escuchas recientes:** pistas que has reproducido en todas las superficies de Crow (incluida la reproducción iniciada por voz en tus lentes)
- **Reproducción en el navegador:** streaming `<audio>` vía un proxy del mismo origen — sin dolores de cabeza por CORS, con soporte completo de seek mediante solicitudes HTTP Range
- **Reproducción en los lentes:** el botón "Reproducir en los lentes" de un toque transmite a través del complemento meta-glasses a tus Ray-Ban Meta (Gen 2) emparejados
- **Barra de reproducción persistente:** inicia la reproducción, navega a cualquier otro panel — la barra permanece visible con controles de reproducir/pausar/siguiente/anterior/detener
- **Controles multimedia de Android:** cuando el panel de Música corre dentro del WebView de la app de Crow para Android, la tarjeta de notificación multimedia estándar de Android aparece en el panel de notificaciones y en la pantalla de bloqueo — con carátula del álbum, título, artista y reproducir/pausar/siguiente/detener. Las teclas multimedia de los audífonos Bluetooth funcionan automáticamente. No se requiere código nativo.

## Configuración

### Requisitos previos

- Un servidor Funkwhale con contenido de audio (instala el complemento **Funkwhale**, o apunta a una instancia externa de Funkwhale). La v1 del panel de Música es solo para Funkwhale; el soporte de Subsonic/Navidrome está planeado como un seguimiento.
- `FUNKWHALE_URL` y `FUNKWHALE_ACCESS_TOKEN` configurados en tu entorno de Crow (heredados del complemento de Funkwhale).

### Instalación

1. Abre **Crow's Nest → Extensiones**.
2. Busca **Música** (bajo Multimedia) y haz clic en **Instalar**.
3. La ficha de Música aparece en la pantalla de inicio del Nest y en la barra lateral.
4. Ábrela — si Funkwhale está accesible, la vista de exploración carga automáticamente. Si no, verás un CTA de **Configurar Funkwhale**.

## Reproducir música

### En tu navegador

Toca el botón **▶ Reproducir** junto a cualquier pista. El audio se transmite a través del gateway (mismo origen; el token bearer de Funkwhale se queda del lado del servidor) y se reproduce en la barra de reproducción persistente en la parte inferior de la pantalla.

Avanzar/retroceder funciona — el proxy de streaming reenvía las solicitudes HTTP Range al upstream.

### En tus lentes

Si tienes lentes Meta emparejados (vía el complemento **Meta Glasses**), aparece un botón **👓 Reproducir en los lentes** en cada pista. Tócalo → el audio se enruta a tu teléfono vía WebSocket → se decodifica y se reproduce por los altavoces de tus lentes.

Si los lentes ya están reproduciendo algo, verás **"Lentes ocupados — detén la reproducción actual primero"** en lugar de un estado engañoso de "en cola". Di "stop" o presiona Detener en la barra de reproducción, y luego vuelve a tocar Reproducir en los lentes.

Consulta [Meta Glasses → Reproducción de música](/es/guide/meta-glasses) para las opciones de control por voz.

### Poner pistas en cola

- **+ Cola** en cualquier pista la agrega a la cola actual
- **Reproducir todo** en el encabezado de un álbum pone en cola cada pista en orden
- La barra de reproducción muestra ⏮ ⏭ cuando la cola tiene más de una entrada
- La cola es local del cliente para la reproducción en el navegador; gestionada por el servidor para la reproducción en los lentes (así el encadenado de álbumes sobrevive a las recargas de página del lado de los lentes)

## Controles multimedia de Android

Cuando abres el panel de Música dentro de la app de Crow para Android (no solo en un navegador móvil), la reproducción de música se registra automáticamente con la API `MediaSession` de Android. Obtienes:

- Tarjeta en el **panel de notificaciones** con carátula del álbum, título/artista y botones de transporte
- Controles de reproducción en la **pantalla de bloqueo** (la misma tarjeta, a pantalla completa)
- Tarjeta de reproductor multimedia en los **Ajustes rápidos** en Android 13+
- Las teclas físicas de reproducir/pausar/siguiente de los **audífonos Bluetooth** se enrutan por la misma sesión

No hay que instalar una app aparte ni otorgar permisos — este es el comportamiento estándar de Chromium WebView + `navigator.mediaSession`, controlado por la barra de reproducción de Crow.

## Cómo se registran las escuchas

Cada vez que una pista comienza a reproducirse (en el navegador O en los lentes), el gateway dispara un POST fire-and-forget al endpoint `/api/v1/history/listenings/` de Funkwhale. Tanto la pestaña **Recientes** del panel de Música como la sección **Escuchas recientes** del panel de Funkwhale muestran el resultado.

Esto es por-pista-al-iniciar, no con calidad de scrobble ("50% o 4 minutos"). Suficiente para casos de uso tipo "¿qué escuché hoy?"; no es ideal para compartir conteos de escuchas públicamente. Una política más sofisticada queda fuera del alcance de la v1.

## Solución de problemas

**Aparece el CTA "La música necesita una biblioteca"** → El panel de Funkwhale no está accesible o `FUNKWHALE_URL` no está configurada. Instala el complemento de Funkwhale o revisa `.env`.

**Las pistas se reproducen pero no hay carátula de álbum** → Puede que tu biblioteca de Funkwhale no tenga carátulas subidas. El panel recurre a marcadores de posición con la letra inicial. Subir las carátulas en la UI de administración de Funkwhale lo arreglará automáticamente.

**Falta el botón "Reproducir en los lentes"** → El complemento Meta Glasses no está instalado, o no hay lentes emparejados actualmente. Revisa **Configuración → Meta Glasses**.

**El seek no funciona** → Verifica que tu navegador haya enviado una solicitud Range. Chrome/Firefox lo hacen automáticamente para `<audio>`. Si el upstream de Funkwhale está detrás de un proxy que elimina los encabezados Range, el seek recurre a volver a descargar desde el byte 0.

**No hay controles multimedia de Android en el panel de notificaciones** → Asegúrate de estar viendo el panel dentro de la app de Crow para Android (no en una pestaña de navegador móvil). `navigator.mediaSession` necesita un contexto WebView del mismo documento.

**El audio se detiene cuando navego a otro panel** → Turbo Drive está activado por defecto; verifica que no se haya desactivado con `CROW_ENABLE_TURBO=0` en el gateway (consulta [Turbo Drive](/es/developers/platform-capabilities)). Con la bandera apagada, cada clic en la barra lateral es una recarga completa de la página que destruye el `<audio>`; la política de autoplay de Chrome entonces bloquea la reanudación de la reproducción. Con Turbo activado, la barra de reproducción es `data-turbo-permanent`, así que tanto ella como el elemento de audio sobreviven a cada navegación entre paneles.

**Reproducir todo no hace nada, silenciosamente** → El endpoint de streaming está devolviendo 502, normalmente porque falló el fetch upstream del gateway hacia Funkwhale o MinIO. Revisa `docker ps` para los contenedores de Funkwhale y MinIO, y confirma que el MinIO compartido en el host `crow` emparejado (si usas uno) esté sano — las URLs prefirmadas de medios que entrega Funkwhale apuntan a MinIO, y un MinIO muerto produce una respuesta `{"error":"fetch failed"}`. Consulta la [configuración de Tailscale](/es/getting-started/tailscale-setup) si el almacenamiento compartido dejó de estar accesible tras un reinicio.

## Hoja de ruta

- **Backend Subsonic/Navidrome:** Replicar los endpoints bajo `/api/subsonic/*` para que el panel de Música funcione con Navidrome o cualquier servidor compatible con OpenSubsonic. La misma UI, distinto backend. Seguimiento planeado.
- **Playlists, favoritos, calificaciones:** Funkwhale los soporta vía API. Próxima pasada de pulido.
- **Caché sin conexión:** Service worker + caché nativa para la app de Crow para Android. A más largo plazo.

## Ver también

- [Meta Glasses](/es/guide/meta-glasses) — reproducción de música por voz + lentes
- [Integración con Funkwhale](/es/integrations/funkwhale) — configuración del servidor y federación
- [Navidrome](/es/integrations/navidrome) — servidor de música alternativo (compatible con Subsonic; soporte del panel de Música planeado)
