---
title: Funkwhale
---

# Funkwhale

Conecta Crow a [Funkwhale](https://funkwhale.audio/), un servidor de música y podcasts autoalojado que federa sobre ActivityPub. Explora y busca en tu biblioteca, sube pistas, gestiona playlists, sigue canales remotos a través del fediverso y modera tu pod — todo a través de tu asistente de IA.

## Qué obtienes

- Explorar y buscar en tu biblioteca de música
- Subir pistas
- Crear y gestionar playlists (agregar, quitar, reordenar, eliminar)
- Seguir y dejar de seguir canales y bibliotecas remotos sobre ActivityPub
- Ver qué se está reproduciendo actualmente
- Moderación: bloquear/silenciar usuarios, bloquear o defederar dominios, depurar media en caché

## Configuración

Funkwhale se instala como un bundle de Crow. Ejecuta seis contenedores (api, celeryworker, celerybeat, un servidor de archivos nginx interno, postgres, redis) junto a tu gateway de Crow.

> "Crow, instala el bundle de Funkwhale"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

### Hardware

El bundle está protegido por una verificación de hardware: se niega a instalarse por debajo de **1.5 GB de RAM efectiva** (después de los bundles ya comprometidos) y advierte por debajo de 8 GB en total. El disco crece con tu biblioteca — espera aproximadamente 5–20 GB por cada 1,000 pistas, más cientos de MB para las cachés federadas.

### Almacenamiento: en disco o S3

Por defecto, los archivos de audio viven en `~/.crow/funkwhale/data/media`. Para enrutar el almacenamiento a MinIO o a un S3 externo, configura esto en `.env` **antes** de instalar:

```bash
FUNKWHALE_S3_ENDPOINT=https://minio.example.com
FUNKWHALE_S3_BUCKET=funkwhale-audio
FUNKWHALE_S3_ACCESS_KEY=...
FUNKWHALE_S3_SECRET_KEY=...
```

El paso de post-instalación del bundle detecta estos valores y configura las variables `AWS_*` que Funkwhale realmente lee. Ten en cuenta que la sola presencia de MinIO no es suficiente — debes configurar el bucket y las credenciales, porque Funkwhale necesita su propio aislamiento por bundle.

### Federación

Funkwhale federa sobre ActivityPub: usuarios remotos de Mastodon / GoToSocial / Pixelfed pueden seguir tus canales, y tu pod puede suscribirse a canales y bibliotecas remotos (manteniendo cachés locales del audio). Exponlo en su propio dominio vía Caddy como parte del bootstrap de primera ejecución.

## Herramientas de IA

Una vez instalado, puedes interactuar con Funkwhale a través de tu IA:

> "¿Qué hay en mi biblioteca de Funkwhale?"

> "Busca ambient en mi música"

> "Sube esta pista a Funkwhale"

> "Sigue ese canal"

> "Crea una playlist llamada Focus"

> "¿Qué se está reproduciendo ahora?"

## Solución de problemas

### El bundle no se instala

Revisa la verificación de hardware — Funkwhale se niega a instalarse por debajo de 1.5 GB de RAM efectiva después de contabilizar los otros bundles. Libera memoria o detén otro bundle y vuelve a intentarlo.

### Las subidas fallan o el audio no se reproduce

Si configuraste almacenamiento S3, confirma que los valores `FUNKWHALE_S3_*` sean correctos y que el bucket exista y sea escribible. Sin los cuatro configurados, Funkwhale recurre al almacenamiento en disco bajo `~/.crow/funkwhale/data/media`.

### La federación no funciona

Funkwhale debe ser accesible en su propio dominio público sobre HTTPS para que ActivityPub funcione. Confirma que el sitio de federación de Caddy esté configurado y que el dominio resuelva.
