---
title: Referencia de la API de Almacenamiento
---

# Referencia de la API de Almacenamiento

Referencia completa de la API de Almacenamiento de Crow — herramientas MCP, endpoints HTTP y el módulo s3-client.

## Herramientas MCP

### crow_upload_file

Sube un archivo pequeño (base64, <1MB) u obtén una URL de subida HTTP para archivos más grandes.

**Parámetros:**

| Nombre | Tipo | Requerido | Longitud máx. | Descripción |
|---|---|---|---|---|
| `file_name` | string | Sí | 500 | Nombre original del archivo |
| `mime_type` | string | No | 200 | Tipo MIME (p. ej., `image/png`) |
| `data_base64` | string | No | 1500000 | Datos del archivo codificados en base64 (para archivos <1MB) |
| `bucket` | string | No | 100 | Bucket de destino (predeterminado: `crow-files`) |
| `reference_type` | string | No | 100 | A qué está adjunto este archivo (p. ej., `blog_post`, `project_source`) |
| `reference_id` | number | No | — | ID del elemento referenciado |

Cuando se proporciona `data_base64`, el archivo se sube directamente. Cuando se omite, se devuelve una URL de subida prefirmada para archivos más grandes.

**Devuelve (subida directa):**

```
Uploaded "photo.jpg" (240.0KB)
Key: 1709900000000-photo.jpg
Download URL (1hr): https://...
```

**Devuelve (URL prefirmada):**

```
Upload URL generated for "photo.jpg":

PUT https://...presigned-url...

Content-Type: image/jpeg
Max size: 100MB
Expires in 1 hour.
```

**Errores:**
- Cuota excedida — devuelve el límite de la cuota
- Tipo MIME bloqueado — los tipos ejecutables se rechazan
- Archivo demasiado grande para subirlo en base64 — sugiere el endpoint de subida HTTP

---

### crow_list_files

Lista los archivos almacenados con filtrado opcional.

**Parámetros:**

| Nombre | Tipo | Requerido | Longitud máx. | Descripción |
|---|---|---|---|---|
| `bucket` | string | No | 100 | Filtrar por bucket |
| `mime_type` | string | No | 200 | Filtrar por prefijo de tipo MIME (p. ej., `image/`) |
| `reference_type` | string | No | 100 | Filtrar por tipo de referencia |
| `reference_id` | number | No | — | Filtrar por ID de referencia |
| `limit` | number | No | — | Máximo de resultados (predeterminado: 50, máx.: 100) |

**Devuelve:**

```
3 file(s):

- photo.jpg (240.0KB, image/jpeg)
  Key: 1709900000000-photo.jpg | 2026-03-08T12:00:00Z
- doc.pdf (1024.0KB, application/pdf) [blog_post:5]
  Key: 1709900000001-doc.pdf | 2026-03-08T11:00:00Z
```

---

### crow_get_file_url

Obtén una URL de descarga prefirmada para un archivo.

**Parámetros:**

| Nombre | Tipo | Requerido | Longitud máx. | Descripción |
|---|---|---|---|---|
| `s3_key` | string | Sí | 500 | Clave del objeto S3 |
| `expiry` | number | No | — | Expiración de la URL en segundos (predeterminado: 3600, mín.: 60, máx.: 86400) |
| `bucket` | string | No | 100 | Nombre del bucket (predeterminado: `crow-files`) |

**Devuelve:**

```
Download URL (expires in 60 min):
http://minio:9000/crow-files/1709900000000-photo.jpg?X-Amz-...
```

---

### crow_delete_file

Elimina un archivo del almacenamiento y de la base de datos.

**Parámetros:**

| Nombre | Tipo | Requerido | Longitud máx. | Descripción |
|---|---|---|---|---|
| `s3_key` | string | Sí | 500 | Clave del objeto S3 a eliminar |
| `bucket` | string | No | 100 | Nombre del bucket (predeterminado: `crow-files`) |

**Devuelve:**

```
Deleted: 1709900000000-photo.jpg
```

---

### crow_storage_stats

Obtén estadísticas de uso del almacenamiento.

**Parámetros:** Ninguno.

**Devuelve:**

```json
{
  "total_files": 42,
  "total_size_bytes": 52428800,
  "total_size_human": "50.0 MB",
  "quota_bytes": 1073741824,
  "quota_human": "1.0 GB",
  "used_percent": 4.9,
  "by_type": {
    "image/jpeg": { "count": 20, "size_bytes": 30000000 },
    "application/pdf": { "count": 15, "size_bytes": 20000000 },
    "text/plain": { "count": 7, "size_bytes": 2428800 }
  }
}
```

## Endpoints HTTP

### POST /storage/upload

Sube un archivo vía datos de formulario multipart.

**Encabezados:**
- `Authorization: Bearer <token>` (cuando OAuth está habilitado)
- `Content-Type: multipart/form-data`

**Campos del formulario:**
- `file` — El archivo a subir (requerido)
- `folder` — Ruta de la subcarpeta (opcional)

**Respuesta (200):**

```json
{
  "key": "images/photo.jpg",
  "original_name": "photo.jpg",
  "mime_type": "image/jpeg",
  "size_bytes": 245760
}
```

**Errores:**
- `400` — No se proporcionó archivo o el tipo MIME es inválido
- `413` — El archivo excede el límite de tamaño
- `507` — Cuota de almacenamiento excedida

**Ejemplo:**

```bash
curl -X POST http://localhost:3001/storage/upload \
  -F "file=@photo.jpg" \
  -F "folder=images/blog"
```

---

### GET /storage/file/:key

Recupera un archivo redirigiendo a una URL prefirmada de MinIO.

**Parámetros de ruta:**
- `key` — Clave de almacenamiento codificada como URL (p. ej., `images%2Fphoto.jpg`)

**Parámetros de query:**
- `expiry` — Expiración de la URL prefirmada en segundos (predeterminado: 3600)

**Respuesta:**
- Redirección `302` a la URL prefirmada de MinIO
- `404` si la clave del archivo no se encuentra

**Ejemplo:**

```bash
curl -L http://localhost:3001/storage/file/images%2Fphoto.jpg
```

## Exports de s3-client.js

El módulo `servers/storage/s3-client.js` envuelve el SDK de MinIO para que lo usen el servidor de almacenamiento y el gateway. Usa un cliente singleton configurado mediante variables de entorno (`S3_ENDPOINT` / `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`, `S3_ACCESS_KEY` / `MINIO_ROOT_USER`, `S3_SECRET_KEY` / `MINIO_ROOT_PASSWORD`).

### getClient()

Obtiene o crea el singleton del cliente MinIO/S3. Devuelve `null` si no está configurado (falta el endpoint o la clave secreta).

### isAvailable()

Comprueba si el backend S3/MinIO está disponible y respondiendo. Devuelve `boolean`.

### ensureBucket(bucket?)

Garantiza que un bucket exista, creándolo si falta. El valor predeterminado es `"crow-files"`.

### uploadObject(key, data, opts?)

Sube un Buffer a S3. `opts` puede incluir `bucket` (string) y `contentType` (string).

### getPresignedUrl(key, opts?)

Genera una URL GET (descarga) prefirmada. `opts` puede incluir `bucket` y `expiry` (segundos, predeterminado: 3600).

### getPresignedUploadUrl(key, opts?)

Genera una URL PUT (subida) prefirmada para subidas directas desde el navegador. `opts` puede incluir `bucket` y `expiry` (segundos, predeterminado: 3600).

### deleteObject(key, bucket?)

Elimina un objeto de S3. `bucket` tiene como valor predeterminado `"crow-files"`.

### listObjects(opts?)

Lista los objetos de un bucket. `opts` puede incluir `bucket` y `prefix`. Devuelve un arreglo de `{ name, size, lastModified }`.

### getBucketStats(bucket?)

Obtiene estadísticas del bucket. Devuelve `{ fileCount, totalSizeBytes }`.

### isAllowedMimeType(mimeType)

Valida que un tipo MIME esté permitido para subir (bloquea los tipos ejecutables). Devuelve `boolean`.
