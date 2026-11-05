---
title: Actualización automática
---

# Actualización automática

Crow incluye un actualizador automático integrado que busca nuevas versiones, descarga los cambios y reinicia el gateway. No se requieren comandos manuales de SSH ni de git.

## Cómo funciona

El actualizador automático se ejecuta como una tarea en segundo plano dentro del proceso del gateway:

1. **Fetch** — ejecuta `git fetch origin main` para buscar nuevos commits
2. **Puerta de CI** — consulta en GitHub los resultados de CI requeridos del commit
   destino (`suite`, `static-checks`, `audit`). Una compilación en rojo o aún en
   ejecución pospone la actualización hasta la próxima comprobación; los forks sin
   esos checks no se ven afectados. Se desactiva con `CROW_UPDATE_CI_GATE=0`.
3. **Comprobación de cuarentena** — si este host ya revirtió un commit y ese commit
   sigue siendo la cabeza de `main`, la actualización se omite (ver
   [Reversión automática](#reversion-automatica); una reversión tomada por una razón
   de la máquina caduca a las 6 horas, así que se reintenta aunque `main` no avance)
4. **Pull** — ejecuta `git pull --ff-only origin main` (solo fast-forward, sin commits de merge).
   Los cambios locales **no** se guardan en un stash: `git pull` solo se niega cuando el
   diff entrante se solapa con un archivo que modificaste, y deja intactos los demás.
5. **Dependencias** — ejecuta `npm install` si `package.json` o `package-lock.json` cambiaron.
   Si la instalación falla, la actualización se detiene ahí y se revierte: sin
   comprobación de importación, sin migración y sin reinicio (ver
   [Reversión automática](#reversion-automatica))
6. **Comprobación de importación** — carga todo el grafo de importaciones del gateway
   descargado en un proceso hijo de corta duración. Si no carga, la actualización se
   revierte antes de arrancar nunca ese código (ver [Reversión automática](#reversion-automatica))
7. **Migraciones** — ejecuta `node scripts/init-db.js` para cualquier cambio de esquema,
   envuelto en la guarda de migraciones (copia de seguridad automática previa +
   protección contra pérdida de datos)
8. **Reinicio** — cierra el servidor HTTP de forma ordenada y sale para que systemd reinicie el proceso

## Configuración

| Ajuste | Predeterminado | Descripción |
|---------|---------|-------------|
| Actualización automática habilitada | Sí | Se activa en Settings > Updates |
| Intervalo de comprobación | 6 horas | Con qué frecuencia se buscan nuevas versiones |

### Página de configuración

Ve a **Settings > Updates** en el Crow's Nest para:

- Habilitar o deshabilitar la actualización automática
- Ver la versión actual (hash del commit de git)
- Ver cuándo se ejecutó la última comprobación y qué encontró
- Disparar manualmente una comprobación de actualización

## Cambios locales {#cambios-locales}

Una instancia con modificaciones locales (una máquina de desarrollo, o un archivo
de configuración editado a mano) no necesita ningún trato especial:

1. El actualizador nunca guarda ni descarta nada. Ejecuta `git pull --ff-only`,
   que solo se niega cuando el diff entrante se solapa con un archivo que modificaste.
2. Cualquier otra edición local sobrevive la actualización intacta.
3. Un pull rechazado se informa en Settings > Updates (`Pull failed …`) y se
   reintenta en la próxima comprobación. Haz commit, revierte o guarda en stash el
   archivo en conflicto para dejar pasar la actualización.

Ya no hay ciclo de stash/pop: un stash que no se podía reaplicar dejaba el
checkout limpio pero el trabajo del operador aparcado en `git stash list`.

## Reversión automática {#reversion-automatica}

Una actualización que no arranca es peor que una actualización tardía: systemd
reinicia un gateway que falla cada pocos segundos, así que el arreglo en `main`
nunca llega a descargarse. Por eso Crow comprueba el código descargado **antes**
de comprometerse con él.

**Capa 0 (esta versión).** Después del pull, el actualizador instala primero las
dependencias: si `npm install` sale con un código distinto de cero, la actualización
se abandona ahí — sin comprobación de importación, sin `init-db`, sin reinicio —
porque las comprobaciones siguientes estarían juzgando un árbol cuyas dependencias
nadie instaló, y la migración correría para un commit que puede que nunca arranque.
Los pasos de reversión de abajo valen también para ese caso, con `deps-failed` como
razón registrada.

Después, y *antes* de que se ejecute `init-db`, el actualizador lanza el
`servers/gateway/index.js` descargado en un proceso hijo con
`CROW_GATEWAY_IMPORT_CHECK=1`, usando el entorno que la unidad configura de verdad.
Ese archivo responde con un token de una línea y código de salida 0 como su
primerísima instrucción, lo que prueba que todo el grafo estático de importaciones
cargó. Ante una salida distinta de cero, un timeout (60 s) o un token ausente, el
actualizador:

1. escribe `<git-dir>/crow-update-quarantine.json` nombrando el commit — así ninguna
   instancia de este checkout lo vuelve a descargar;
2. mueve el checkout atrás con `git reset --keep <anterior>`, que se niega en lugar
   de destruir cambios locales que se solapen;
3. reinstala las dependencias si cambiaron, y
4. registra `Rolled back: …` en Settings > Updates — `… fails to load (…)` para un
   commit que no carga, `… — npm install failed` para uno cuyas dependencias no se
   pudieron instalar — y hace sonar la campana de notificaciones.

Nada se reinicia dentro del commit malo. Un commit cuyo código no carga queda en
cuarentena hasta que `main` avance más allá; una reversión tomada por una razón
de la máquina (un timeout, un `npm install` fallido, un `init-db` fallido que no
cambió nada) caduca además a las 6 horas. Si `git reset --keep` se niega porque
hay cambios locales que se solapan, la cuarentena se mantiene, el reinicio se
retiene, y el resultado dice `Update rollback blocked` — incluido el caso en que
el checkout todavía contiene el commit malo, así que el próximo reinicio o
rearranque lo arrancaría.

Un `init-db` fallido tras un pull solo se revierte cuando nada del código nuevo
puede haber llegado a la base de datos: el pull no debe cruzar una generación de
esquema, `scripts/init-db.js` debe ser idéntico byte a byte en ambos commits, la
base de datos debe seguir siendo legible y `user_version` no debe haber avanzado.
En caso contrario el árbol se deja como está y el aviso lo dice.

Toda instancia co-alojada que comparte el checkout respeta el mismo marcador:
ninguna migra ni se reinicia dentro de un commit en cuarentena, y cada una
verifica por separado que *su propio* entorno puede cargar el árbol antes de migrar.

### Capa 1: el guardián de arranque {#boot-guard}

La capa 0 solo ve los fallos que ocurren mientras un proceso sano sigue vivo. Lo
que esté detrás de una importación dinámica, o un fallo que solo aparece con el
entorno del gestor de servicios, todavía puede repetirse para siempre. El guardián
de arranque es la red de seguridad, y corre **fuera** del grafo de módulos del
gateway.

**Cómo se conecta.** La unidad de servicio recibe dos comandos más (un drop-in,
`10-boot-guard.conf`): uno *antes de cada arranque*, incluidos todos los reinicios
automáticos, y otro *después de cada parada*. El script que ejecutan no es la
copia de tu checkout — vive en `~/.crow/boot-guard/crow-boot-guard.mjs` y solo lo
refresca un gateway que ya lleva diez minutos en pie. Por eso un commit cuyo
código no arranca nunca puede reemplazar a quien lo juzga.

**Qué hace.**

- Registra cada arranque. Una salida cuenta como fallo solo cuando lo es de
  verdad: salida distinta de cero (salvo 78, que significa "las rutas de esta
  instancia están rechazadas"), un volcado de memoria, o una señal que no sea
  TERM/INT/HUP/KILL. Un reinicio que pidió Crow (una actualización, la instalación
  de un bundle, `systemctl restart`) nunca cuenta, y quedarse sin memoria tampoco
  — normalmente es la máquina, así que recibe una sola notificación. (Si tu
  unidad arranca el gateway con `npm run gateway`, el estado de salida que ve el
  guardián describe a npm y no a node; npm propaga un node matado como salida
  distinta de cero, que el guardián sí cuenta.)
- Tras **tres** fallos contados, el siguiente arranque (el cuarto) mueve `main`
  atrás hasta el último commit que este host demostró poder arrancar, escribe el
  marcador de cuarentena para que ninguna instancia vuelva a descargar el commit
  malo, reinstala las dependencias si cambiaron, y deja corriendo el código
  anterior. Recibes un aviso, y Settings → Updates muestra `Rolled back: …`.
- Se arma solo: tras un `git pull` manual y un reinicio también vigilará el commit
  nuevo, pero **solo** si el commit ya está en `origin/main` y desciende del
  último sano. Tus propios commits sin publicar en `main` nunca se revierten.
- Si dos instancias de Crow comparten un checkout, exactamente una mueve el árbol;
  la otra lo detecta y reporta `Rolled back: … a co-hosted instance rolled it back`.

**Qué rechaza** (en ninguno de estos casos se cambia nada):

| Situación | Por qué |
|---|---|
| No hay registro de un commit que arrancara bien | no puede saber a qué volver |
| El checkout no está en `main` | revertirlo separaría HEAD y detendría todas las actualizaciones |
| El commit anterior no es ancestro del que falla | volver atrás descartaría commits |
| El checkout es de solo lectura para esta instancia | debe revertirlo la instancia que lo descarga |
| Existe un `git index.lock` | hay otro comando git en marcha; el guardián nunca lo borra |
| La base de datos avanzó: `user_version` está más allá de lo que espera el commit anterior | sus migraciones pueden no ser reversibles |
| `scripts/init-db.js` cambió entre los dos commits | reconstruye tablas sin subir la generación de esquema |
| Se aplicó una migración que no declara que el código anterior puede con la forma nueva | el código viejo puede no entender los datos |

**Un rechazo que no puede desaparecer solo no se reintenta.** Cuando el guardián
rechaza porque la base de datos avanzó (`user_version`), porque cambió
`scripts/init-db.js`, o porque una migración aplicada no declara que el código
anterior puede correr con la forma nueva, nada de lo que hagas en el gateway
cambiará la respuesta: el guardián deja `main` donde está, mantiene el aviso y el
archivo `STATUS`, y **no** vuelve a armar el mismo commit en el siguiente
arranque — si no, arrancaría el commit que falla tres veces más por ciclo, para
nada. Los otros rechazos (sin commit anterior probado, un checkout que no está
en `main`, un checkout de solo lectura, un `index.lock`) pueden desaparecer solos,
así que se revisan otra vez en el siguiente arranque.

**Recuperarse de un rechazo.** El aviso y `~/.crow/boot-guard/STATUS` llevan los
pasos exactos para el caso que se disparó. En general (`CROW_APP` es tu checkout:
`~/.crow/app` en una instalación con el instalador, o donde hayas clonado el
repositorio):

```bash
# 1. Detén el bucle.
sudo systemctl stop crow-gateway

# 2. Si el aviso dice que la base de datos avanzó (una generación de esquema, un
#    cambio en init-db, o una migración no reversible), restaura la copia que la
#    guarda de migraciones hizo ANTES de tocar git.
ls ~/backups/crow            # o donde esté tu directorio de copias

# 3. Mueve main atrás a un commit que sepas que arranca, conservando cambios
#    locales no relacionados.
CROW_APP="${CROW_APP:-$HOME/.crow/app}"
cd "$CROW_APP"
git log --oneline -5
git reset --keep <ese-commit>

# 4. Arráncalo otra vez.
sudo systemctl start crow-gateway
```

No uses `git checkout <commit>`: eso separa HEAD, el actualizador omite entonces
todas las comprobaciones con `Skipped: not on main`, y las actualizaciones se
detienen en silencio.

**Contra qué protege.** El guardián es una defensa contra commits malos
*accidentales*: una importación que lanza, un error de sintaxis, una dependencia
que no arranca. **No** es una defensa contra un commit deliberadamente
malicioso. Un commit así corre como el usuario del servicio, igual que el
gateway, así que puede reescribir `~/.crow/boot-guard/crow-boot-guard.mjs`, el
archivo de estado que está junto a él, o el `.git/config` de este repositorio
antes del siguiente arranque. El aislamiento del lanzador
(`core.hooksPath=/dev/null`, `GIT_*` eliminadas, ningún módulo del árbol
importado) existe para que los hooks y módulos de un commit malo *honesto* no
corran durante la reversión — no aporta nada contra un atacante. Trata el acceso
de escritura a `main` como equivalente a una shell como el usuario del servicio.

**Instalarlo.** Las instalaciones nuevas lo traen. En un host existente, ejecuta
`sudo scripts/ops/install-boot-guard.sh` desde el checkout (o
`scripts/ops/install-boot-guard.sh --user` para una unidad de usuario); escribe un
drop-in por unidad de gateway y copia el lanzador, surte efecto en el siguiente
arranque, y nunca reinicia nada por sí mismo. La imagen Docker no está cubierta:
no tiene `.git`, así que allí nunca se descarga nada y no hay nada que revertir.

Si el drop-in existe pero el guardián no corre (un `node` que se movió, una copia
del lanzador borrada), la Crow's Nest muestra una tarjeta "The boot guard did not
run" en el siguiente arranque en vez de fallar en silencio.

## Reinicio ordenado

Cuando el actualizador automático (o la instalación de un bundle) dispara un reinicio:

1. Emite un evento `crow:shutdown` para cerrar el socket de escucha del servidor HTTP
2. Espera 1 segundo a que el socket se libere
3. Sale con código 1 para que el `Restart=on-failure` de systemd levante el servicio de nuevo

Esto evita el típico error `EADDRINUSE`, donde el proceso nuevo arranca antes de que el viejo haya liberado el puerto.

## Actualización manual

Si prefieres actualizar manualmente (`CROW_APP` es tu checkout: `~/.crow/app` en
una instalación con el instalador, o donde hayas clonado el repositorio):

```bash
CROW_APP="${CROW_APP:-$HOME/.crow/app}"
cd "$CROW_APP"
git pull --ff-only origin main
npm install
node scripts/guarded-init-db.mjs   # migración con guarda: copia previa, restauración si hay pérdida
sudo systemctl restart crow-gateway
```

`node scripts/guarded-init-db.mjs` es el punto de entrada de migraciones que usa
también el actualizador: hace una copia de seguridad antes de migrar, clasifica el
resultado por si hubo pérdida de datos y restaura la copia si la migración dañó el
almacén. `npm run init-db` sigue existiendo, pero es la ejecución desnuda, sin
ninguna guarda y sin copia: úsala solo en una base de datos de pruebas, nunca en
una que te importe.

`bash ~/.crow/app/scripts/crow-update.sh` hace la misma secuencia en un solo paso
y va más allá: comprueba que el código nuevo responde de verdad en `/health` y
revierte con `git reset --keep` si no lo hace.

O dispara una comprobación única desde la página de Settings sin habilitar las comprobaciones automáticas.

## Reversión {#reversion}

Si una actualización causa problemas, revierte **sobre `main`** (`CROW_APP` es tu
checkout: `~/.crow/app` en una instalación con el instalador, o donde hayas
clonado el repositorio):

```bash
CROW_APP="${CROW_APP:-$HOME/.crow/app}"
cd "$CROW_APP"
git log --oneline -5             # Encontrar el commit anterior
git reset --keep <commit-hash>   # Mover main atrás, conservando cambios locales ajenos
sudo systemctl restart crow-gateway
```

Usa `reset`, nunca `checkout`: `git checkout <commit>` deja HEAD desacoplado, el
checkout deja de estar "en main", y el actualizador automático omite **todas** las
comprobaciones con `Skipped: not on main` — las actualizaciones se detienen en
silencio hasta que alguien devuelva la rama.

`git reset --keep` se niega si el commit al que vuelves difiere en un archivo que
has modificado; haz commit, stash o revierte ese archivo primero. El actualizador
automático solo usa pulls fast-forward, así que `git reflog` siempre conserva el
estado anterior.

Si revertiste porque un commit no arrancaba, escribe también la cuarentena para
que ninguna instancia lo vuelva a descargar:

```bash
printf '{"v":1,"sha":"<sha-malo>","previous":"<sha-bueno>","reason":"manual","at":"%s","by":"operator"}\n' \
  "$(date -Iseconds)" > "$(git rev-parse --absolute-git-dir)/crow-update-quarantine.json"
```

El marcador vive en el git dir, no en `.git/` por nombre: en un worktree enlazado
el git dir está en otra ruta, y `git rev-parse --absolute-git-dir` es la ruta que
usa el propio actualizador.

## Registros

La actividad de actualización se registra en el stdout del gateway (visible con `journalctl -u crow-gateway`):

```
[auto-update] Enabled — checking every 6h
[auto-update] 3 new commit(s) available. Updating...
[auto-update] Dependencies changed — running npm install...
[auto-update] import check unavailable in 1a2b3c4d5 (no CROW_GATEWAY_IMPORT_CHECK seam) — relying on the boot guard
[auto-update] Running database migrations...
[auto-update] Updated: c29e19c → 9d18049
[auto-update] Restarting to run 9d18049...
```

Una reversión se lee así:

```
[auto-update] Rolled back: 9d18049 fails to load (import-check); running c29e19c; updates resume when main moves past it
[auto-update] Rolled back: 9d18049 — npm install failed; running c29e19c; retried after 6 h or when main moves
```

Un `npm install` fallido registra su código de salida y el final de la salida de
npm (por eso se queda en el log y nunca llega a la notificación):

```
[auto-update] npm install failed (exit 1): npm ERR! …
```

Los resultados de las actualizaciones también se guardan en la base de datos y son visibles en Settings > Updates.