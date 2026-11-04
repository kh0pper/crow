---
title: Servidores Satélite
description: Guarda una copia cifrada del respaldo nocturno de la base de datos de Crow en un satélite emparejado, y restáurala en cualquier máquina sin un Crow en ejecución.
---

# Servidores Satélite

Un **satélite** es una instalación pequeña de Crow en una segunda máquina que Crow administra por la tailnet. Una de sus tareas es guardar una copia fuera del sitio del respaldo nocturno de la base de datos de Crow. El satélite almacena ese archivo y nunca puede leerlo: el respaldo se cifra en Crow con una clave que vive en el llavero de Crow — y en ningún otro sitio salvo la exportación del llavero cifrada con contraseña que guardas fuera de línea.

El satélite tampoco es tu única copia — Crow conserva sus propios respaldos locales — pero la copia fuera del sitio es la que sobrevive a la muerte de la máquina principal.

## Subida nocturna, retención y la comprobación semanal

Crow mantiene la copia al día por sí solo en cuanto hay un satélite emparejado y una exportación del llavero contiene la clave:

- **Cada noche (03:10)** Crow cifra el respaldo más reciente de `crow.db` y lo sube al satélite. Solo cuando el servidor confirma el mismo tamaño y la misma suma de comprobación borra las copias antiguas, conservando los **7 días** más recientes y el domingo de cada una de las últimas **4 semanas**.
- **Cada domingo (03:40)** Crow descarga la copia más reciente, la descifra, ejecuta la comprobación de integridad de SQLite y compara el número de memorias con su base de datos en vivo. Un fallo, o una copia de más de 36 horas, genera un aviso al día.

Ambas tareas son unidades **de usuario** de systemd. El repositorio las trae como plantillas en `scripts/systemd/` (`crow-offsite-vault.timer`, `crow-offsite-verify.timer`) y **no están instaladas ni habilitadas**: eso es un paso de despliegue. Para activarlas:

```bash
cp scripts/systemd/crow-offsite-{vault,verify}.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now crow-offsite-vault.timer crow-offsite-verify.timer
```

Ejecuta una a mano con `systemctl --user start crow-offsite-vault.service` (o `node scripts/offsite-run.mjs upload`).

## Restaurar sin un Crow en ejecución

La restauración es posible en **cualquier** máquina que tenga el código de Crow y tu exportación del llavero. No intervienen ni el gateway, ni la base de datos, ni la red, ni el agente del satélite: la clave del respaldo se lee directamente de la exportación.

### 1. Consigue la exportación del llavero

La restauración necesita la exportación del llavero cifrada con contraseña que contenga la **clave de respaldo fuera del sitio** de Crow (`offsite-backup / CROW_OFFSITE_BACKUP_KEY`).

- Si ya guardas una exportación fuera de línea, usa esa.
- Si Crow todavía funciona, haz primero una exportación nueva: **Ajustes → Seguridad y contraseñas → Contraseñas y claves guardadas → Exportar**. Mientras una exportación no contenga esa clave, Crow lo indica en la página de Servidores (y en un aviso diario cuando el temporizador de la copia externa está activo) y no sube ningún respaldo, porque un respaldo que nadie puede descifrar es peor que no tener respaldo.
- El archivo de exportación y su contraseña van juntos. Sin ambos, la copia fuera del sitio no se puede abrir — ese es el objetivo del diseño.
- Importa solo las exportaciones del llavero que hayas hecho tú: una importación puede recuperar una clave fuera del sitio, y una clave que no hiciste tú cifraría los próximos respaldos para otra persona.

### 2. Copia el archivo vault desde el satélite

El satélite guarda un archivo por respaldo, con el nombre del día en que se tomó, dentro de un directorio identificado por tu Crow ID:

```
<satélite>:~/.crow-satellite/vault/<crow_id_hash>/crow-db-<AAAAMMDD>.vault
```

Cópialo a la máquina que hará la restauración con el método de transferencia que confíes (`scp`, una memoria USB, un almacén de objetos). El archivo está cifrado, así que la transferencia no necesita ser secreta — pero mantén el archivo privado de todos modos.

### 3. Ejecuta la restauración

Desde una copia del código de Crow (Node 24, nada más):

```bash
node scripts/vault-restore.mjs \
  --file crow-db-20261030.vault \
  --date 2026-10-30 \
  --keychain-export crow-keychain-2026-10-30.json \
  --out /tmp/crow-restored.db
```

- La contraseña se lee de **stdin**, nunca de la línea de comandos ni del entorno. Escríbela cuando se te pida, o pásala desde tu gestor de contraseñas.
- `--date` es el día en que se tomó el respaldo. La cabecera del archivo debe nombrar ese día, y su hora de creación debe caer dentro de ese día ± 1 día: el satélite no puede servir un respaldo antiguo con un nombre más nuevo.
- `--out` nunca se sobrescribe. Elige una ruta que todavía no exista.

Cada fragmento del archivo se autentica antes de escribirse. El texto plano va primero a `<out>.partial` y se renombra a `--out` solo cuando el último fragmento se verifica, así que un archivo en `--out` es siempre un respaldo completo y verificado. El comando imprime una sola línea — la fecha del respaldo, los bytes escritos, `verified` — y nada más: nunca la clave, nunca la contraseña.

| Código de salida | Significado |
|---|---|
| 0 | Restaurado y verificado |
| 2 | Uso: falta un argumento o es inválido, `--file` no se puede leer, o `--out` ya existe |
| 3 | No se pudo abrir la exportación (contraseña incorrecta, el archivo no es una exportación, o la exportación no contiene la clave de respaldo fuera del sitio) |
| 4 | El archivo vault fue rechazado. El mensaje nombra el motivo: `bad_magic`, `bad_version`, `bad_header`, `header_too_large`, `bad_chunk_size`, `key_mismatch`, `chunk_too_large`, `tag_failure`, `truncated`, `trailing_data`, `rollback`, `partial_exists` o `out_exists` (ya hay un archivo: no se sobrescribe nada) |

Un rechazo `rollback` significa que el archivo no es el respaldo de la fecha que pediste. Un `tag_failure` significa que el archivo está dañado, se selló con otra clave o fue manipulado — restaura otra copia en lugar de intentar repararlo.

Después, coloca el `crow.db` restaurado en su sitio a mano: detén Crow, aparta la base de datos anterior, copia el archivo restaurado al directorio de datos y vuelve a iniciar Crow. Conserva el archivo anterior hasta comprobar que la instancia restaurada tiene tus memorias y ajustes.

::: tip Mantén una segunda vía de acceso al satélite
La restauración lee un archivo que está en el satélite, así que necesitas *alguna* forma de entrar allí que no dependa de la máquina principal — una clave ssh guardada junto con la exportación del llavero, o la consola de tu proveedor de hosting. Guárdala donde guardes la exportación y pruébala una vez antes de necesitarla.
:::

## Antes de activar los temporizadores de la copia externa

Antes de activar los temporizadores de la copia externa en una máquina, comprueba que su systemd puede aislar un servicio de usuario: `systemd-run --user --wait -p PrivateTmp=yes -p ProtectSystem=strict -p ReadWritePaths=$HOME/.crow "$(command -v node)" -e 1` debe terminar con 0. Si falla (algunos núcleos restringen los espacios de nombres de usuario sin privilegios), los temporizadores nunca arrancarían ni te avisarían.
