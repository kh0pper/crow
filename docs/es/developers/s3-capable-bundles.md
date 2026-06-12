# Bundles con capacidad S3

Cualquier bundle de Crow que almacene medios generados por el usuario (música, fotos, videos, documentos) puede optar por usar el **almacenamiento S3 compartido** de la plataforma — un MinIO (o cualquier endpoint compatible con S3) al que apuntan todas las instancias de Crow emparejadas.

Cuando un bundle opta por participar:

- El operador configura **un solo** juego de credenciales en el Nest (Configuración → Multi-instancia → Almacenamiento compartido).
- Las credenciales se replican a cada instancia emparejada (selladas en reposo vía `secret-box`, de modo que los archivos del feed nunca contienen texto plano).
- El flujo de instalación del bundle inyecta automáticamente las variables de entorno específicas de la app en `<bundle>/.env`, usando la capa traductora que ya conoce `AWS_*`, `S3_*`, `PEERTUBE_OBJECT_STORAGE_*` y `AWS_STORAGE_BUCKET_NAME`.
- El panel de Almacenamiento compartido muestra una insignia de "drift" cuando la configuración en disco del bundle no coincide con la configuración actual de la base de datos, con un botón **Apply** que reescribe el bloque y ejecuta `docker compose up -d --force-recreate`.

## Lista de verificación mínima para adoptarlo

1. **Agrega un bloque `storage` al manifiesto del bundle**:

   ```json
   {
     "id": "mybundle",
     "storage": {
       "translator": "mastodon",
       "bucket": "mymedia"
     }
   }
   ```

   - `translator` — debe coincidir con una clave en `servers/gateway/storage-translators.js::TRANSLATORS`. Actualmente: `funkwhale`, `mastodon`, `peertube`, `pixelfed`. Para agregar una app nueva, extiende el mapa de traductores y agrega un fixture de prueba.
   - `bucket` — sufijo que se anexa a `storage.shared.bucket_prefix`. Para un prefijo de almacenamiento compartido `crow` y `bucket: "mymedia"`, el bundle obtiene `crow-mymedia`.

2. **Referencia las variables de entorno en el `docker-compose.yml` del bundle** exactamente como las emite el traductor. Cada traductor documenta su forma al inicio de `storage-translators.js`. Ejemplo de Mastodon:

   ```yaml
   environment:
     S3_ENABLED: ${S3_ENABLED:-}
     S3_BUCKET: ${S3_BUCKET:-}
     S3_REGION: ${S3_REGION:-}
     S3_HOSTNAME: ${S3_HOSTNAME:-}
     S3_ENDPOINT: ${S3_ENDPOINT:-}
     AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID:-}
     AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:-}
   ```

3. **Nada más**. El flujo de instalación del gateway (`servers/gateway/routes/bundles.js::installBundle`), en el paso 2.5, detecta automáticamente el `storage.translator` del manifiesto, abre las credenciales selladas vía secret-box, ejecuta `translate(...)` y escribe un bloque administrado en `<bundle>/.env`:

   ```
   # crow-shared-storage BEGIN (managed by gateway — do not edit)
   # crow-shared-storage-version: <sha256-hex>
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   ...
   # crow-shared-storage END
   ```

   El sello de versión es `sha256(JSON.stringify(sortedKeys.map(k => [k, translated[k]])))` sobre la salida del traductor **en texto plano**, de modo que los re-sellados con nonce fresco no señalen drift de forma espuria. El panel de Almacenamiento compartido del Nest lee este sello vía `readManagedBlockVersion()` y muestra los bundles que están desactualizados.

## Verificar la adopción

Después de publicar un cambio de manifiesto:

```bash
# Listar todos los adoptantes
grep -l '"translator":' bundles/*/manifest.json

# Inspeccionar el bloque administrado de un bundle instalado después de la instalación
cat ~/.crow/bundles/<id>/.env | sed -n '/# crow-shared-storage BEGIN/,/# crow-shared-storage END/p'
```

En el Nest: Configuración → Multi-instancia → Almacenamiento compartido. Los bundles con capacidad S3 instalados aparecen al final con una insignia "in sync" / "drifted" / "missing".

## Lo que NO es automático

- **Cumplimiento** — el propio compose del bundle debe referenciar las variables de entorno. El gateway solo las escribe; los contenedores las leen en el primer arranque.
- **Reconfiguración al cambiar las credenciales** — haz clic en **Apply** en el panel de Almacenamiento compartido, o habilita `storage.local.auto_apply_to_bundles` (solo local, no se sincroniza) para recrear automáticamente los contenedores después de cada guardado.
- **Instalaciones previas del bundle** — si un bundle se instaló antes de ganar un `storage.translator`, desinstala + reinstala, o usa el botón Apply una vez que el bundle lo declare.

## La capa traductora

`servers/gateway/storage-translators.js` toma un registro canónico de Crow:

```js
{ endpoint: "http://host:port", region: "us-east-1", bucket: "crow-mybundle", accessKey: "...", secretKey: "..." }
```

y devuelve los pares clave-valor de entorno específicos de la app. Para agregar una app nueva, agrega una entrada al mapa `TRANSLATORS` y (recomendado) un fixture en un script de smoke al estilo de `scripts/ops/verify-secret-box.mjs`.

Tanto el flujo de instalación del gateway como la herramienta independiente `bundles/funkwhale/scripts/configure-storage.mjs` llaman al mismo `translate()` — no hay divergencia entre la ruta de instalación vía el Nest y la de edición manual del env.
