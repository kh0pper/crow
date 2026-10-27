---
title: Almacenamiento
---

# Almacenamiento

Guarda archivos, imágenes y adjuntos junto a tus datos de Crow. El almacenamiento usa almacenamiento de objetos compatible con S3 (Garage, o cualquier servicio S3), así que tus archivos se quedan en tu propia infraestructura.

## ¿Qué es esto?

Crow Storage le da a tu asistente de IA la capacidad de guardar y recuperar archivos. Se conecta a la extensión File Storage (Garage) (o a cualquier servicio compatible con S3) que corre junto a tu servidor Crow.

Los archivos se organizan por tipo — imágenes, documentos, audio, adjuntos — y son accesibles a través de herramientas MCP, endpoints HTTP o el explorador de archivos del Crow's Nest.

## ¿Por qué querría esto?

- **Adjuntos de proyectos** — Guarda PDFs, conjuntos de datos e imágenes junto a tus proyectos
- **Recursos del blog** — Sube imágenes para las entradas del blog sin necesitar un servicio de hosting aparte
- **Compartir archivos** — Comparte archivos con tus peers conectados a través del sistema de compartición P2P existente
- **Respaldo** — Mantén archivos importantes en una capa de almacenamiento autohospedada que tú controlas

## Configuración

Instala **File Storage (Garage)** desde **Extensiones** en el Crow's Nest. Crow genera todas las claves y tokens que necesita, los guarda en **Ajustes → Contraseñas** y conecta a él sus herramientas de almacenamiento: no hay nada que escribir.

- **Dónde quedan los archivos:** por defecto, en un volumen de Docker en esta máquina. Para guardarlos en una carpeta de otro disco local, define *GARAGE_DATA_PATH* al instalar (no una carpeta de red ni un disco USB montado con FUSE).
- **Compartir con instancias de Crow emparejadas:** pon en *GARAGE_BIND_ADDR* la IP de la tailnet de esta máquina, y en *S3_ENDPOINT* esa misma dirección con el puerto 3900. La API de administración (puerto 3903) se queda siempre en esta máquina.
- **Sin consola web:** explora y gestiona los archivos en la página **Archivos** del Crow's Nest.

Crow crea y gestiona su bucket (`crow-files`) automáticamente — no necesitas configurar ningún bucket.

::: tip ¿Ya tienes S3 en otro lado?
Cualquier servicio compatible con S3 funciona. Configúralo en **Ajustes → Almacenamiento compartido** (se replica a las instancias emparejadas y tiene prioridad sobre `.env`), o define `S3_ENDPOINT`, `S3_ACCESS_KEY` y `S3_SECRET_KEY` en `.env`.
:::

::: warning MinIO está obsoleto
La extensión MinIO ya no tiene mantenimiento upstream y su imagen ya no se puede descargar, así que ya no se puede instalar. Una instalación de MinIO existente sigue funcionando; los ajustes antiguos `MINIO_*` se siguen leyendo cuando no hay ningún ajuste `S3_*`.
:::

## Subir archivos

### A través de tu IA

Pídele a Crow que suba un archivo:

> "Sube esta imagen al almacenamiento"

> "Guarda el PDF que está en ~/Downloads/paper.pdf en mis archivos de investigación"

Crow usa la herramienta `crow_upload_file` tras bambalinas.

### A través de HTTP

Sube vía el endpoint HTTP del gateway:

```bash
curl -X POST http://localhost:3001/storage/upload \
  -F "file=@photo.jpg" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### A través del Crow's Nest

Abre el panel de **Archivos** en el Crow's Nest y usa el botón de subida. Puedes arrastrar y soltar archivos directamente.

## Explorar archivos

Pídele a Crow que liste tus archivos:

> "Muéstrame mis archivos guardados"

> "Lista todas las imágenes en el almacenamiento"

O explóralos visualmente en el panel de Archivos del Crow's Nest.

## Obtener URLs de archivos

Para usar un archivo guardado (por ejemplo, en una entrada del blog o un documento compartido):

> "Dame la URL de header-image.jpg"

Crow genera una URL prefirmada que expira después de un periodo configurable (por defecto: 1 hora). Esto mantiene tus archivos privados a la vez que permite acceso temporal.

## Cuotas de almacenamiento

Crow aplica una cuota de almacenamiento configurable (por defecto: 5 GB / 5120 MB). Revisa tu uso:

> "¿Cuánto almacenamiento estoy usando?"

La herramienta `crow_storage_stats` devuelve el uso actual, el número de archivos y la cuota restante. Ajusta la cuota en tu `.env`:

```bash
CROW_STORAGE_QUOTA_MB=2048
```

## Tipos de archivo soportados

El almacenamiento usa un enfoque de lista de bloqueo — se acepta la mayoría de los tipos de archivo y solo se bloquean los tipos ejecutables. Esto significa que puedes subir prácticamente cualquier formato de archivo, incluyendo:

- **Imágenes**: JPEG, PNG, GIF, WebP, SVG, TIFF, BMP, ICO
- **Documentos**: PDF, texto plano, Markdown, HTML, documentos de Office (DOCX, PPTX, XLSX)
- **Datos**: JSON, CSV, XML, YAML
- **Audio**: MP3, WAV, OGG, FLAC, AAC
- **Video**: MP4, WebM, AVI, MKV
- **Archivos comprimidos**: ZIP, TAR, GZ, 7z, RAR

Los archivos con tipos MIME desconocidos o no reconocidos también se permiten.

Los siguientes tipos MIME ejecutables están bloqueados:

- `application/x-executable`
- `application/x-msdos-program`
- `application/x-msdownload`
- `application/x-sh`
- `application/x-shellscript`
- `application/x-bat`
- `application/x-msi`

## Capacidades desbloqueadas

Cuando el almacenamiento S3 está configurado, habilita capacidades en toda la plataforma — no solo la subida de archivos:

- **Adjuntos en mensajes** — Envía imágenes, documentos y archivos en todas las conversaciones del panel de Mensajes (mensajes entre peers, chat de IA y chat de bots). Los archivos se suben a S3 y se entregan vía URLs prefirmadas.
- **Visión para bots** — Los adjuntos de imagen enviados a los bots se enrutan a través de un modelo de visión para su análisis, lo que permite a los bots entender fotos, recibos, capturas de pantalla y documentos.
- **Recursos del blog** — Sube imágenes de cabecera y medios en línea para las entradas del blog sin necesitar un host de imágenes aparte.
- **Archivos de proyectos** — Adjunta PDFs, conjuntos de datos y materiales de referencia a tus proyectos de investigación.
- **Compartir archivos** — Comparte archivos con tus peers conectados a través del sistema de compartición P2P existente.

El almacenamiento es opcional — Crow funciona sin él. Pero configurar MinIO desbloquea estas funciones sin configuración adicional.

## Eliminar archivos

> "Elimina el archivo old-draft.pdf del almacenamiento"

La eliminación es permanente. Los archivos se eliminan tanto de MinIO como del índice de la base de datos.

## Bajo el capó

¿Te da curiosidad cómo funcionan internamente las URLs prefirmadas, las cuotas y el cliente de MinIO? Consulta la [arquitectura del servidor de almacenamiento](/es/architecture/storage-server).
