---
title: Servidor de Almacenamiento
---

# Servidor de Almacenamiento

El servidor de almacenamiento (`servers/storage/`) ofrece almacenamiento de archivos compatible con S3 a través de herramientas MCP y endpoints HTTP. Se conecta a MinIO (o a cualquier servicio compatible con S3) para el almacenamiento de objetos y registra los metadatos de los archivos en SQLite.

> Recorrido para el usuario (configuración, subida de archivos, cuotas): [guía de Almacenamiento](/es/guide/storage). Esta página cubre los internos.

## Arquitectura

```
┌──────────────────────────────────────┐
│       Capa de herramientas MCP       │
│  crow_upload_file  crow_list_files   │
│  crow_get_file_url crow_delete_file  │
│  crow_storage_stats                  │
├──────────────────────────────────────┤
│        Capa HTTP del gateway         │
│  POST /storage/upload (multipart)    │
│  GET  /storage/file/:key (prefirmada)│
├──────────────────────────────────────┤
│           s3-client.js               │
│  Wrapper del SDK de MinIO,           │
│  URLs prefirmadas                    │
├──────────────────────────────────────┤
│  SQLite (storage_files)  │  MinIO    │
│  Metadatos + índice      │  Blobs    │
└──────────────────────────────────────┘
```

## Patrón de fábrica

Como todos los servidores de Crow, el servidor de almacenamiento usa una función de fábrica:

```js
// servers/storage/server.js
export function createStorageServer(dbPath) {
  const server = new McpServer({ name: "crow-storage", version: "1.0.0" });
  // ... registros de herramientas
  return server;
}
```

- `server.js` — Función de fábrica con todas las definiciones de herramientas
- `index.js` — Conecta la fábrica al transporte stdio
- `s3-client.js` — Wrapper del cliente MinIO/S3

El gateway importa `createStorageServer()` y lo conecta al transporte HTTP junto con los demás servidores.

## s3-client.js

Envuelve el SDK de MinIO con valores predeterminados específicos de Crow:

```js
import { Client } from 'minio';

export function createS3Client(config) {
  // Devuelve un cliente MinIO configurado
}

export async function uploadObject(client, bucket, key, buffer, metadata) { }
export async function getPresignedUrl(client, bucket, key, expiry) { }
export async function deleteObject(client, bucket, key) { }
export async function listObjects(client, bucket, prefix) { }
export async function getBucketSize(client, bucket) { }
```

Las URLs prefirmadas expiran en 1 hora por defecto. La expiración es configurable por solicitud.

## Tabla de la base de datos

```sql
CREATE TABLE storage_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  s3_key TEXT NOT NULL UNIQUE,       -- Clave del objeto S3 (p. ej., "1234567890-photo.jpg")
  original_name TEXT NOT NULL,       -- Nombre original del archivo al subirlo
  mime_type TEXT,                    -- Tipo MIME validado
  size_bytes INTEGER,               -- Tamaño del archivo
  bucket TEXT DEFAULT 'crow-files',  -- Nombre del bucket S3
  uploaded_by TEXT,                  -- Quién lo subió (opcional)
  reference_type TEXT,              -- A qué está adjunto este archivo (p. ej., blog_post)
  reference_id INTEGER,             -- ID del elemento referenciado
  created_at TEXT DEFAULT (datetime('now'))
);
```

La columna `s3_key` es el identificador canónico que se usa en las herramientas MCP y los endpoints HTTP.

## Herramientas MCP

### crow_upload_file

Sube un archivo pequeño vía base64 (menos de 1MB) o genera una URL de subida prefirmada para archivos más grandes. Valida el tipo MIME, comprueba la cuota, sube el archivo a MinIO e inserta una fila de metadatos.

**Parámetros:**
- `file_name` (string, máx. 500) — Nombre original del archivo
- `mime_type` (string, máx. 200, opcional) — Tipo MIME (p. ej., `image/png`)
- `data_base64` (string, máx. 1500000, opcional) — Datos del archivo codificados en base64 (para archivos de menos de 1MB)
- `bucket` (string, máx. 100, opcional) — Bucket de destino (predeterminado: `crow-files`)
- `reference_type` (string, máx. 100, opcional) — A qué está adjunto este archivo (p. ej., `blog_post`, `research_source`)
- `reference_id` (number, opcional) — ID del elemento referenciado

### crow_list_files

Lista archivos con filtrado opcional por bucket, prefijo de tipo MIME o referencia.

**Parámetros:**
- `bucket` (string, máx. 100, opcional) — Filtrar por bucket
- `mime_type` (string, máx. 200, opcional) — Filtrar por prefijo de tipo MIME (p. ej., `image/`)
- `reference_type` (string, máx. 100, opcional) — Filtrar por tipo de referencia
- `reference_id` (number, opcional) — Filtrar por ID de referencia
- `limit` (number, mín. 1, máx. 100, opcional, predeterminado 50)

### crow_get_file_url

Genera una URL de descarga prefirmada para acceso temporal a un archivo.

**Parámetros:**
- `s3_key` (string, máx. 500) — Clave del objeto S3
- `expiry` (number, mín. 60, máx. 86400, opcional, predeterminado 3600) — Expiración de la URL en segundos
- `bucket` (string, máx. 100, opcional) — Nombre del bucket (predeterminado: `crow-files`)

### crow_delete_file

Elimina un archivo tanto de MinIO como de la base de datos.

**Parámetros:**
- `s3_key` (string, máx. 500) — Clave del objeto S3 a eliminar
- `bucket` (string, máx. 100, opcional) — Nombre del bucket (predeterminado: `crow-files`)

### crow_storage_stats

Devuelve un resumen del uso de almacenamiento: total de archivos, tamaño total, cuota restante. Sin parámetros.

## Rutas HTTP del gateway

### POST /storage/upload

Subida de archivos multipart. Acepta el campo `file` y un campo `folder` opcional. Devuelve la clave del archivo y sus metadatos. Protegida por OAuth cuando está habilitado.

### GET /storage/file/:key

Redirige a una URL prefirmada de MinIO para el archivo solicitado. La clave va codificada como URL en la ruta. Devuelve 404 si el archivo no existe en la base de datos.

## Aplicación de cuotas

Antes de cada subida, el servidor consulta el uso total de almacenamiento:

```sql
SELECT COALESCE(SUM(size_bytes), 0) as total FROM storage_files;
```

Si `total + new_file_size > CROW_STORAGE_QUOTA_MB * 1024 * 1024`, la subida se rechaza con un mensaje de error claro que muestra el uso actual y la cuota.

## Validación MIME

Las subidas se validan contra una lista de tipos MIME permitidos. El servidor comprueba tanto la extensión del archivo como el tipo MIME detectado (usando los magic bytes cuando están disponibles). Las discrepancias se rechazan.

Categorías permitidas:
- `image/*` — JPEG, PNG, GIF, WebP, SVG
- `application/pdf`
- `text/*` — Texto plano, Markdown, HTML, CSV
- `application/json`, `application/xml`
- `audio/*` — MP3, WAV, OGG

Los ejecutables, scripts y formatos de archivo comprimido se rechazan por defecto.

## Adjuntos en mensajes

El panel de Mensajes usa el servidor de almacenamiento para los archivos adjuntos en todos los tipos de conversación (mensajes entre peers, chat con IA, chat con bots).

```
┌─────────────────────────────────────────────────────────┐
│  Panel de Mensajes (UI de adjuntos)                     │
│  ├── Elegir archivo → vista previa (miniatura / tarjeta)│
│  ├── Enviar mensaje                                     │
│  │   └── POST /storage/upload (multipart)               │
│  │       └── Bucket de MinIO (crow-files)               │
│  │           └── s3_key guardada en el mensaje          │
│  └── Mostrar mensaje                                    │
│      └── URL prefirmada generada al leer                │
│          └── Imagen inline / enlace de descarga         │
└─────────────────────────────────────────────────────────┘
```

### Flujo

1. El usuario selecciona un archivo en la UI de adjuntos (componente compartido entre todos los tipos de mensaje)
2. Al enviar, el archivo se sube a MinIO vía `POST /storage/upload`
3. Los valores devueltos `s3_key`, `name`, `mime_type` y `size` se guardan como JSON en la columna `attachments` del mensaje
4. Cuando se cargan los mensajes, se generan URLs prefirmadas a partir de la `s3_key` guardada para mostrarlos
5. Las imágenes se muestran inline; los demás tipos de archivo aparecen como enlaces de descarga


### Adjuntos en el chat con IA

Para el chat con IA BYOAI, los adjuntos de imagen se pasan como partes de contenido multimodal al proveedor de IA:

- **Compatible con OpenAI**: parte de contenido `image_url` con la URL prefirmada de S3
- **Anthropic**: parte de contenido `image` con la URL prefirmada de S3

Esto requiere que el modelo de IA configurado soporte visión (p. ej., GPT-4o, Claude Sonnet).
