# Identidad Portátil (Estudio de Factibilidad)

Este documento explora cómo hacer las instalaciones de Crow totalmente portátiles — mover tu identidad, datos y configuración entre máquinas como quien lleva una llave.

## El concepto de "pier"

Inspirado en el modelo de "pier" de Urbit, donde toda tu identidad digital es un único directorio que puedes mover entre computadoras. En Crow, el directorio `~/.crow/` cumple este rol:

```
~/.crow/                    ← Tu "pier"
├── data/
│   ├── crow.db             # Todas las memorias, investigación, entradas de blog, contactos
│   └── identity.json       # Identidad criptográfica (Crow ID)
├── .env                    # Claves de API y configuración
├── installed.json          # Estado de los complementos
├── bundles/                # Bundles instalados
└── panels/                 # Paneles personalizados
```

**La idea clave:** después de la estandarización del directorio de datos (todos los datos en `~/.crow/`), la migración ya es posible — solo que aún no está automatizada.

::: info Encadenamiento vs. migración
La identidad portátil habilita la **migración** — mover tu identidad de Crow de un dispositivo a otro. Para ejecutar múltiples instancias **simultáneamente** con datos sincronizados, consulta en su lugar [Encadenamiento Multi-Instancia](./instances). Ambas funciones usan el mismo mecanismo de exportación/importación de identidad, pero el encadenamiento mantiene todas las instancias ejecutándose en paralelo.
:::

## Qué funciona hoy

### Usuarios de SQLite local (el caso más común)

La migración es directa:

1. Detén Crow en la máquina anterior
2. Copia `~/.crow/` a la nueva máquina
3. Instala Crow en la nueva máquina (`npm run setup`)
4. Inicia Crow

Tu Crow ID, todas las memorias, investigación, entradas de blog, contactos y mensajes vienen contigo. La identidad es determinista — la misma semilla produce las mismas claves en cualquier máquina.

### Estado P2P

- **Contactos y mensajes** están en SQLite — migran con la base de datos
- **Los feeds de Hypercore** se re-sincronizan automáticamente vía descubrimiento DHT después del reinicio
- **Las conexiones a relays de Nostr** se restablecen según las entradas de la tabla `relay_config`
- En general: el estado P2P es mayormente transparente de migrar

## Complicaciones

### Usuarios de MinIO (almacenamiento de objetos)

Los archivos almacenados en MinIO no están en `~/.crow/data/`. Opciones:

1. **Si MinIO se ejecuta localmente** — Copia `~/.crow/minio-data/` junto con `~/.crow/data/`
2. **Si MinIO es remoto** — Simplemente conserva el mismo endpoint en `.env`
3. **A futuro:** un comando `crow export-files` para descargar todos los objetos S3 a un directorio local

### Volúmenes de Docker

Los complementos tipo bundle que usan Docker pueden almacenar datos en volúmenes con nombre (p. ej., la base de datos de Nextcloud, los modelos de Ollama). Estos necesitan un respaldo aparte:

```bash
# Exportar un volumen de Docker
docker run --rm -v nextcloud-db:/data -v $(pwd):/backup alpine tar czf /backup/nextcloud-db.tar.gz /data
```

### Claves de API

Las claves de API en `.env` son específicas de la máquina en algunos casos (p. ej., tokens OAuth atados a redirect URIs). Después de la migración, puede que algunas claves deban reconfigurarse.

## Ruta de implementación

### Ahora: migración manual (disponible hoy)

```bash
# En la máquina anterior
sudo systemctl stop crow-gateway  # o Ctrl-C si se ejecuta manualmente
tar czf crow-backup.tar.gz ~/.crow/

# Transferir a la nueva máquina
scp crow-backup.tar.gz newmachine:~/

# En la nueva máquina
tar xzf crow-backup.tar.gz -C ~/
git clone https://github.com/kh0pper/crow.git ~/.crow/app  # o actualizar el existente
cd ~/.crow/app && npm run setup
```

### Pronto: comando `crow backup` (v2)

Agregar al CLI `crow`:

```bash
crow backup                    # Crea ~/.crow/crow-backup-2026-06-12.tar.gz
crow backup --include-bundles  # Incluye los volúmenes de Docker de los bundles
crow restore backup.tar.gz     # Restaura en la nueva máquina
```

Implementación:
1. Crear un tarball de `~/.crow/` (excluyendo `app/node_modules/`)
2. Incluir un checksum SHA256 para verificación de integridad
3. Opcionalmente exportar los volúmenes de Docker de los bundles instalados
4. `crow restore` extrae, ejecuta `npm install`, `npm run init-db`, e inicia los servicios

## Lecciones de Urbit

El modelo de pier de Urbit demuestra que la portabilidad del estado funciona bien cuando:

1. **La identidad y los datos están fuertemente acoplados** — Crow lo logra con `identity.json` y `crow.db` en el mismo directorio
2. **Snapshots atómicos** — No intentes respaldar una base de datos en ejecución. Detén el servicio primero, o usa la API de backup de SQLite
3. **Protocolo de migración formal** — Documenta los pasos exactos y verifica la integridad. Un respaldo corrupto es peor que ningún respaldo
4. **Evitar la complejidad de respaldos mutables** — Los tarballs simples superan a los sistemas de respaldo incremental para datos personales a esta escala

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Respaldo corrupto | Verificación de checksum SHA256 |
| Migración incompleta (volúmenes de Docker faltantes) | Flag `--include-bundles` con advertencias explícitas |
| Incompatibilidad de claves de API | Verificación post-migración que lista qué claves necesitan actualizarse |
| Ejecutar en ambas máquinas simultáneamente | Colisión de identidad — advertir al usuario que detenga primero la instancia anterior |
| Bases de datos grandes (>1 GB) | API de backup de SQLite para snapshots en vivo sin detener el servicio |

## Decisión

La identidad portátil es factible hoy para los usuarios de SQLite local. La estandarización de `~/.crow/` proporciona la base. La automatización completa (`crow backup/restore`) es una adición natural v2 al CLI. Las herramientas de migración de nube a local son un esfuerzo futuro aparte.
