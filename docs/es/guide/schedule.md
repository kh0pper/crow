---
title: Página de agenda
---

# La página de agenda

**Crow's Nest → Agenda** (`/dashboard/schedule`) muestra en una sola agenda todo lo que ocurrirá por su cuenta, y cuándo:

- **Las programaciones de Crow**: recordatorios, rutinas de bots y el resumen diario. Aquí se pueden cambiar (ver [Programación](./scheduling)).
- **Fuentes de solo lectura**, si las configuras: la **reserva** actual del equipo, las **ventanas del equipo** de un archivo de registro y los **temporizadores de tus máquinas** (temporizadores de systemd y líneas de cron). La página solo las muestra. Nunca las cambia, arranca ni detiene.

Arriba, una franja lista lo que necesita revisión, cada cosa con su arreglo. Si no hay nada, dice "Todo va según lo previsto". Los botones **Todo · De Crow · Equipo · Máquinas** filtran la agenda; Equipo y Máquinas solo aparecen cuando esa fuente existe. La franja siempre muestra todos los problemas.

Una instalación nueva no tiene ninguna fuente de solo lectura. No se muestra nada de ellas hasta que defines las variables de abajo en el entorno del gateway, por ejemplo en un drop-in de systemd.

## Reserva del equipo

Cuando un trabajo largo reserva la máquina (ver [Reserva del equipo](../../architecture/box-reservation)), la reserva aparece en **Ahora**: quién la tiene, por qué y hasta cuándo. No hace falta configurar nada.

Si el archivo de la reserva no se puede leer, no se arranca ningún modelo hasta que se arregle o se libere, y la franja dice **No se puede leer la reserva del equipo**. Su arreglo copia la orden para liberarla, `node scripts/ops/box-reserve.mjs release`, para que la ejecutes tú.

## Registro del equipo

Algunos operadores llevan un registro en markdown de las ventanas previstas en una máquina compartida. Para mostrarlo, indica el archivo al gateway:

```bash
CROW_BOX_LEDGER_PATH=/ruta/a/tu/registro.md
```

- **No hay ruta por defecto**. Sin la variable no se lee ningún registro. Defínela solo en la instancia que deba mostrarlo. Otra instancia de Crow que se ejecute con el mismo usuario no ve el registro, salvo que su propio entorno también defina la variable.
- La ruta debe ser absoluta y apuntar a un **archivo normal**: se rechazan los enlaces simbólicos, los FIFO y los directorios. Se leen como mucho 1 MB y 2.000 líneas de tabla.
- Solo se lee la tabla bajo un encabezado que empiece por `## Reservations`. Sus tres primeras columnas son **cuándo**, **qué** y **quién**. Las demás columnas y secciones se ignoran.

Cómo se lee la celda **cuándo** de una fila, en la zona horaria de la instancia (gana la primera regla que encaje):

| La celda dice | Se lee como |
|---|---|
| Una fila que empieza por `~~\|`, o `~~` en su celda cuándo o qué | **cerrada**: no se muestra |
| `ONGOING`, `standing`, `until …` (palabras, no una hora), `HELD`, `multi-session` | **en curso**: se listan juntas, nunca caducan |
| `hard stop [AAAA-MM-DD] HH:MM` | termina entonces |
| `→ HH:MM [Día]` | termina entonces. Si es antes del inicio, termina al día siguiente |
| `→ cap N h` / `→ cap N min` / `→ est. N h` | termina N después del inicio. Si el inicio es `now`, termina a las 23:59 de ese día |
| `→ end of day`, o cualquier otra cosa con fecha | termina a las 23:59 de ese día |
| sin ningún `AAAA-MM-DD` | **sin fecha**: se listan juntas, nunca caducan |

Las ventanas próximas aparecen en la agenda como filas **Ventana del equipo**, y las que están en marcha en **Ahora**. Una fila que sigue abierta **más de una hora después de terminar** está **caducada**: la franja la muestra, con un enlace para abrir el registro en el visor de archivos del panel (o un botón que copia su ruta si el visor no puede abrirlo). Ciérrala en el registro para resolverlo.

## Temporizadores de máquinas

Crow puede listar los temporizadores que se ejecutan en tus máquinas. **El gateway nunca se conecta a ellas.** No usa SSH, no ejecuta órdenes ni abre conexiones de red para esto. Solo lee archivos JSON de una carpeta:

```bash
CROW_HOST_TIMERS_DIR=/ruta/a/host-timers   # por defecto: <CROW_HOME>/host-timers/
```

Sin carpeta no se muestra nada: una instalación genérica cuesta un `stat` por vista de página. Escribir los archivos te toca a ti. Usa la herramienta que quieras (una tarea de cron, una herramienta de gestión de configuración, un script que se ejecute por SSH desde otro sitio). Escribe cada archivo de forma atómica (a un archivo temporal y luego renómbralo), uno por máquina.

### Formato del archivo: `crow.host-timers/1`

```json
{
  "schema": "crow.host-timers/1",
  "host": "box-1",
  "tz": "Europe/Madrid",
  "collected_at": "2026-10-26T13:45:01Z",
  "timers": [
    { "id": "user:backup.timer", "kind": "systemd-user", "name": "backup",
      "schedule": "cada 2 h", "next": "2026-10-26T15:00:00Z",
      "last": "2026-10-26T13:00:00Z", "last_result": "success" },
    { "id": "cron:3", "kind": "cron", "name": "collect.sh", "schedule": "*/15 * * * *" }
  ]
}
```

| Campo | Obligatorio | Significado |
|---|---|---|
| `schema` | sí | Exactamente `crow.host-timers/1`. Con cualquier otro valor, el archivo se omite |
| `host` | sí | El nombre de la máquina tal como quieres verlo (hasta 64 caracteres) |
| `tz` | no | La zona horaria IANA de la máquina, para calcular las horas de cron. Por defecto `UTC` |
| `collected_at` | sí | Cuándo se escribió el archivo (ISO 8601 con zona) |
| `timers[].id` | sí | Único en el archivo. Para systemd: la unidad, con el prefijo opcional `user:` o `system:` |
| `timers[].kind` | sí | `systemd-system`, `systemd-user` o `cron` |
| `timers[].name` | no | Lo que se muestra (hasta 80 caracteres). En `cron` solo se guarda el nombre del archivo de la orden |
| `timers[].schedule` | no | En `cron`: la expresión de 5 campos, con la que Crow calcula la próxima ejecución. En systemd: cualquier texto, tal cual |
| `timers[].next`, `timers[].last` | no | En systemd: la próxima y la última ejecución (ISO 8601) |
| `timers[].last_result` | no | `success`, o cualquier otra cosa para marcar que la última ejecución falló |

Reglas que aplica el gateway:

- Lee como mucho **50** archivos `*.json` de hasta **256 KB** cada uno, y hasta 500 temporizadores por archivo, con 60 segundos de caché. Se omiten los enlaces simbólicos, los FIFO y los archivos que empiezan por punto. Los campos desconocidos se descartan. Un archivo que no cumple el esquema se omite sin romper nada.
- **No pongas secretos en los archivos.** Las líneas de crontab pueden llevar tokens, así que emite solo el horario y la orden, nunca sus argumentos. Como segunda protección, Crow solo guarda el nombre del archivo de una orden de cron: se salta las palabras `VAR=valor` del principio, `cd … &&` y envoltorios como `env` o `nice`.
- Todo lo que viene de un archivo se escapa en la página.
- Un temporizador cuyo `last_result` no es `success` aparece en la franja. Su arreglo copia una orden de revisión (`systemctl [--user] status <unidad>`) solo cuando el nombre de la unidad usa los caracteres propios de systemd (`A–Z a–z 0–9 @ . _ : -`). Cualquier otro nombre se muestra como texto, sin botón de copiar. Crow nunca ejecuta la orden.
- Un archivo cuyo `collected_at` tiene **más de una hora** aparece en la franja como **Datos de máquina antiguos**. Vuelve a ejecutar tu recolector, o comprueba que sigue programado.

Los temporizadores que se ejecutan más de una vez por hora van en el grupo **Se ejecutan a menudo** de la agenda. La lista completa de cada máquina está en **En las máquinas**, agrupada por máquina.
