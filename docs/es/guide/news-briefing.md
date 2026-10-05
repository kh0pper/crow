---
title: Resumen de noticias
---

# Resumen de noticias

La extensión Media Hub puede hacer un resumen de noticias hablado cada día: un guion corto y fechado con las noticias más recientes de tus fuentes de sitios, leído en voz alta por tu voz **local**, listo a la hora que elijas. Un programa al que estés suscrito puede reproducirse justo después.

## Qué necesitas

- La extensión **Media Hub**, con al menos una fuente de sitio (RSS o Atom).
- Un **perfil de voz local** en Configuración → Texto a voz: un motor autoalojado (por ejemplo la extensión Kokoro) en este equipo o en tu propia red. El resumen nunca usa una voz en la nube, aunque tu perfil predeterminado sea uno en la nube. Sin voz local el resumen se escribe igual y se te avisa que está listo para leer, con el motivo por el que no hay audio.

## Configurarlo

Abre **Media → Briefings**.

- **Resumen diario**: elige la hora, cuántas noticias, y enciéndelo. La hora está en la zona horaria que aparece al lado (la de tu equipo, por nombre, así que se mantiene a la misma hora local cuando cambia el horario). El trabajo empieza 15 minutos antes para que el resumen esté listo a tiempo.
- **Después reproducir**: opcionalmente elige uno de tus programas (una fuente de podcast). De lunes a viernes su episodio del día se pone en cola después del resumen. Si el episodio aún no se publica cuando termina la narración, la reproducción se detiene, la tarjeta dice que se sigue revisando y recibes un aviso cuando llega.
- **Hacer un resumen ahora**: hace uno de inmediato, opcionalmente sobre un tema.

También puedes pedírselo a tu asistente: "programa mi resumen de noticias a las 8" (`crow_media_schedule_briefing`) o "dame un resumen de noticias" (`crow_media_briefing`).

## Qué contiene un resumen

- Solo fuentes de sitios. Las fuentes de búsqueda (tipo Google News), los canales de video y los programas nunca se leen en un resumen.
- Las noticias más recientes desde el último resumen diario, primero una por fuente, como máximo dos por fuente, y el mismo titular una sola vez.
- Cada noticia nombra su fuente y usa las primeras frases de la propia fuente. Ningún modelo escribe ni reescribe nada.
- La primera frase dice el día y la fecha.

## Escuchar

Pulsa **Reproducir** en la tarjeta de un resumen: la narración suena en la barra del reproductor al pie de cada página, seguida del programa cuando lo hay. **Leer** muestra el guion y los enlaces a las noticias.

## Cuando falta algo

| Ves | Significa |
|---|---|
| "Listo para leer. Sin audio: …" | El guion se hizo; la voz local no estaba disponible. No se envió nada a ningún otro lugar. |
| "aún no se publica, revisando hasta las …" | El episodio del día todavía no aparece en la fuente del programa. |
| "El resumen de … se omitió" | Crow no estuvo funcionando en las cuatro horas posteriores a la hora programada. |
| "El programador no ha revisado desde …" | El proceso en segundo plano del complemento Media no está funcionando. Reinicia el gateway. |

## Para otras partes de Crow

El resumen más reciente está disponible de tres maneras con la misma respuesta: la función `getLatestBriefing(db, { withAudio, maxAgeHours, kind })` del paquete, `GET /api/media/briefings/latest` (sesión del panel) y la propia tabla `media_briefings`, donde `audio_path` solo tiene valor mientras exista un archivo de audio completo en el directorio `media/audio` de la instancia. Nada de esto es accesible desde fuera de tu red.
