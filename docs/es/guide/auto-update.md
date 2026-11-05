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
   ejecución pospone la actualización hasta la próxima comprobación; un origen que
   no es GitHub no tiene CI que consultar y se actualiza como siempre; una respuesta
   de GitHub que no se puede leer también la pospone (ver
   [La puerta de CI](#la-puerta-de-ci)). Se desactiva con `CROW_UPDATE_CI_GATE=0`.
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

## La puerta de CI {#la-puerta-de-ci}

Antes de hacer el pull, el actualizador pide a GitHub los check-runs requeridos
del commit exacto que va a desplegar (`suite`, `static-checks`, `audit`). Tanto la
comprobación cada 6 horas como **Check for updates now** en Settings > Updates
pasan por la misma puerta, así que el botón manual no puede saltársela.

Cuando GitHub responde, la respuesta decide:

| Respuesta | Qué pasa |
|---|---|
| los tres en verde | la actualización continúa |
| alguno en rojo | se pospone y se reintenta en la próxima comprobación |
| alguno aún en ejecución | se pospone y se reintenta en la próxima comprobación |
| falta alguno de los tres y nada sigue en ejecución | se pospone como **sin CI** (ver abajo): los checks que faltan nunca informarán en este origen — **verde exige los tres**, así que un sha en el que solo `audit` ha terminado nunca se despliega ni se queda como "en ejecución" |
| ningún check-run de nuestros tres | se pospone como **sin CI**: un commit sin verificar nunca se despliega. Un push que se adelantó a los checks se resuelve en la siguiente comprobación; un fork que quita esos checks sigue posponiéndose |

**Sin CI.** GitHub respondió, pero sin los tres checks requeridos —
típicamente un fork que no lleva la CI de este repositorio, o un push cuyos
workflows aún no se han registrado. El commit queda sin verificar, así que esta
comprobación se pospone con su propio mensaje, que nombra los checks que faltan:

```
Skipped: origin/main has none of the required CI checks (1a2b3c4d5; a fork without this repo's CI?) — not deploying an unverified commit; set CROW_UPDATE_CI_GATE=0 to update without the gate
Skipped: origin/main has only some of the required CI checks (1a2b3c4d5; missing audit — a fork without this repo's full CI?) — not deploying an unverified commit; set CROW_UPDATE_CI_GATE=0 to update without the gate
```

Se registra como resultado transitorio, así que nunca hace sonar la campana; si
se repite más de dos intervalos de comprobación, la tarjeta de Actualizaciones
del Nest avisa de que los checks requeridos no se ejecutaron todos en main.
`CROW_UPDATE_CI_GATE=0` es la salida.

Dos resultados *no* son un resultado de CI:

**No aplicable.** El origen no es GitHub — un repositorio desnudo en disco, u otro
host — así que no hay CI que consultar y la puerta nunca puede aplicarse. La
actualización continúa exactamente como siempre, el registro dice

```
[auto-update] CI gate not applicable (origin is not GitHub)
```

y la tarjeta de Actualizaciones del Nest muestra una línea informativa diciendo
que las actualizaciones no pasan por la puerta de CI en este origen. Esa línea
sigue visible entre comprobaciones: una comprobación con el repositorio al día
vuelve a leer el origen en local y registra otra vez "no aplicable" (solo un
origen de GitHub la borra), así que el aviso no depende de acertar con la única
comprobación que descargó algo.

**No disponible.** El origen *sí* es GitHub y no se pudo leer ninguna respuesta:
un fallo de red, un tiempo de espera agotado, un límite de peticiones `403`/`429`,
cualquier otra respuesta que no sea 200, o un cuerpo que no es JSON válido. El
commit queda sin verificar, así que esta comprobación se **pospone exactamente
igual que una compilación en ejecución** — no se descarga nada, el código en
disco sigue corriendo y la próxima comprobación lo reintenta:

```
Skipped: CI status could not be read for origin/main (1a2b3c4d5) — will retry next tick
```

Las dos primeras comprobaciones ilegibles seguidas son transitorias, así que una
caída breve de GitHub pasa en silencio. La tercera seguida se registra como fallo
y hace sonar la campana de notificaciones una vez (su enfriamiento de 24 horas por
código la mantiene en una):

```
Skipped: CI status unreadable for 3 checks in a row — updates are paused until GitHub answers (or set CROW_UPDATE_CI_GATE=0)
```

Cualquier otra respuesta — verde, rojo, en ejecución o no aplicable — reinicia ese
contador, así que una caída que se resuelve no requiere ninguna acción. Si esta
máquina nunca puede alcanzar la API de GitHub (una instalación sin conexión cuyo
origen sigue siendo una URL de GitHub), pon `CROW_UPDATE_CI_GATE=0` en el entorno
de la unidad y reinicia Crow: la puerta se omite por completo.

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
cambió nada) caduca además a las 6 horas. Ninguna de las dos cosas aplica al
marcador que deja una reversión *bloqueada* (el checkout sigue conteniendo el
commit rechazado): ese marcador no se borra nunca ni caduca nunca, así que el
avance de `main` tampoco lo desbloquea — el próximo reinicio o rearranque
arrancaría exactamente ese commit. Si `git reset --keep` se niega porque
hay cambios locales que se solapan, el reinicio se retiene, el resultado dice
`Update rollback blocked`, y el marcador se reescribe SIN caducidad — el checkout
todavía contiene el commit malo, así que una comprobación posterior lo reporta en
vez de decir `Up to date`, y el próximo reinicio o rearranque lo arrancaría. En
cuanto el checkout deja de contener ese commit (por ejemplo, moviendo `main`
back a mano), el marcador vuelve a ser uno normal: una razón de la máquina (las
dependencias nunca se instalaron) caduca 6 horas después de escribirse y ese
mismo commit se reintenta, y uno cuyo código no carga espera a `main` como
siempre. No hay que borrar nada a mano. El marcador que deja una reversión que
SÍ se completó es normal desde el principio: si arreglas la causa y pones ese
mismo commit en `main` tú mismo (un `git pull --ff-only` manual), caduca como
cualquier otro y el avance de `main` lo limpia, así que no puede congelar las
actualizaciones.

Un `init-db` fallido tras un pull solo se revierte cuando nada del código nuevo
puede haber llegado a la base de datos: el pull no debe cruzar una generación de
esquema, `scripts/init-db.js` debe ser idéntico byte a byte en ambos commits, la
base de datos debe seguir siendo legible y `user_version` no debe haber avanzado.
En caso contrario el árbol se deja como está y el aviso lo dice.

Toda instancia co-alojada que comparte el checkout respeta el mismo marcador:
ninguna migra ni se reinicia dentro de un commit que una reversión bloqueada dejó
en el checkout — ni siquiera una vez pasadas sus 6 horas, mientras el checkout
siga conteniendo ese commit — y cada una verifica por separado que *su propio*
entorno puede cargar el árbol antes de migrar.

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
archivo `STATUS`, pone el commit en cuarentena para que ninguna instancia vuelva
a descargarlo, y **no** vuelve a armar el mismo commit en el siguiente
arranque — si no, arrancaría el commit que falla tres veces más por ciclo, para
nada. Los otros rechazos (sin commit anterior probado, un checkout que no está
en `main`, un checkout de solo lectura, un `index.lock`) pueden desaparecer solos,
así que se revisan otra vez en el siguiente arranque. Una reversión siempre
compara el commit que falla con el último commit que corrió estable diez minutos,
no con el commit inmediatamente anterior, así que cuando un cambio de la clase que
provoca rechazos se corrige hacia adelante, los fallos posteriores siguen siendo
rechazables hasta que esa corrección haya corrido estable diez minutos. La causa
de un rechazo puede no ser el commit mismo (una base de datos que otra cosa dejó
avanzada), así que la cuarentena no es permanente: cuando la instancia que lo
rechazó ha corrido ese commit estable diez minutos, reescribe su marca como una
ordinaria y se descarga normalmente un commit más nuevo en `main`. Una instancia
co-alojada que nunca lo rechazó no puede limpiarla así: un rechazo pertenece a la
instancia que lo hizo.

**Recuperarse de un rechazo.** El aviso y `~/.crow/boot-guard/STATUS` llevan los
pasos exactos para el caso que se disparó. En general (`CROW_APP` es tu checkout:
`~/.crow/app` en una instalación con el instalador, o donde hayas clonado el
repositorio):

```bash
# 1. Detén el bucle.
sudo systemctl stop crow-gateway

# 2. Solo un cruce de generación de esquema (user_version por encima de lo que
#    espera el commit anterior) deja una copia, y el aviso nombra ese archivo
#    exacto: restáuralo — la guarda de migraciones la hizo ANTES de tocar git.
#    Cualquier otro tipo de cambio no dejó ninguna, así que el aviso nombra la
#    carpeta donde están las copias anteriores de la guarda pero no da un paso
#    de restauración: son de migraciones anteriores, no de esta. Las migraciones
#    del registro no hacen copia.
ls "$HOME/.crow/data/backups/migrations"

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
npm install --omit=dev
node scripts/guarded-init-db.mjs   # migración con guarda: copia previa, restauración si hay pérdida
sudo systemctl restart crow-gateway
```

`node scripts/guarded-init-db.mjs` usa la misma guarda que el actualizador: hace
una copia de seguridad antes de migrar, clasifica el resultado por si hubo
pérdida de datos y restaura la copia si la migración dañó el almacén.
`npm run init-db` sigue existiendo, pero es la ejecución desnuda, sin ninguna
guarda y sin copia: úsala solo en una base de datos de pruebas, nunca en una que
te importe.

`bash "$CROW_APP/scripts/crow-update.sh"` hace la misma secuencia en un solo paso
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
[auto-update] CI gate not applicable (origin is not GitHub)
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

Si el propio `npm install` de la reversión falla, el resultado (y la
notificación) llevan una cláusula más — instala antes del próximo reinicio,
porque `node_modules` puede estar a medio escribir aunque el código viejo siga
corriendo desde memoria:

```
; its dependencies could not be reinstalled — run npm install --omit=dev in the checkout before the next restart
```

Un `npm install` fallido registra su código de salida y el final de la salida de
npm (por eso se queda en el log y nunca llega a la notificación):

```
[auto-update] npm install failed (exit 1): npm ERR! …
```

Los resultados de las actualizaciones también se guardan en la base de datos y son visibles en Settings > Updates.

## Actualizaciones del sistema {#system-updates}

Todo lo anterior trata del **código de Crow**. La máquina debajo también se
mantiene parcheada: el instalador activa `unattended-upgrades`, así que las
actualizaciones de seguridad de Debian/Ubuntu se instalan solas una vez al día, y
añade a esa misma ejecución los repositorios que Crow instaló. «Sistema» aquí
significa exactamente lo que la propia configuración de unattended-upgrades de la
distribución considera un archivo de seguridad — Crow no lo estrecha ni lo
amplía.

### Qué activa el instalador

| Qué cubre | Origen |
|---|---|
| Node.js (NodeSource) | `origin=. nodistro,codename=nodistro` |
| Docker Engine y sus paquetes | `origin=Docker,archive=${distro_codename}` |
| Caddy | `origin=cloudsmith/caddy/stable,codename=any-version` |

Los tres orígenes viven en el archivo propio de Crow,
`/etc/apt/apt.conf.d/52crow-unattended-upgrades`. El `50unattended-upgrades` de
la distribución nunca se edita, y sus orígenes de seguridad quedan exactamente
como estaban: Crow solo añade. `/etc/apt/apt.conf.d/20auto-upgrades` activa la
ejecución diaria, y solo se escribe cuando aún no existe — una máquina que ya
configuró unattended-upgrades conserva su propia configuración. Volver a ejecutar
el instalador reescribe el archivo de Crow solo cuando su contenido cambia.

### Los reinicios nunca son automáticos

`Unattended-Upgrade::Automatic-Reboot` está en `"false"`. Cuando una actualización
necesita reiniciar, el Nido del Cuervo muestra una tarjeta **Actualizaciones del
sistema** diciendo que hace falta reiniciar, con los paquetes que lo pidieron
(hasta diez nombres). Reinicia cuando te venga bien:

```bash
sudo reboot
```

La misma tarjeta dice si la ejecución diaria sigue activa y cuándo se ejecutó por
última vez, así que un temporizador detenido aparece como "las actualizaciones de
seguridad se ejecutaron por última vez hace N días" en vez de silencio. En una
instalación nueva dice que la ejecución aún no ha ocurrido hasta que pasa su
primer día — eso no es un error. También lista las versiones instaladas de Node y
Docker — solo como información, sin buscar la versión más reciente.

### Los servicios pueden reiniciarse un momento

Una actualización de seguridad de Node, Docker o Caddy reemplaza el paquete.
Docker y Caddy reinician su propio servicio como parte de ello, así que el panel
puede quedar inaccesible unos segundos mientras ocurre. Reiniciar `dockerd`
detiene **todos** los contenedores de la máquina; solo vuelven los que tienen una
política de reinicio, y los bundles de Crow usan `restart: unless-stopped`, así
que vuelven. Crow no se reinicia por estas actualizaciones — de eso se encarga la
actualización automática, más arriba en esta misma página. Una actualización de
Node solo surte efecto cuando se reinicia el gateway, así que aplícala con
`sudo systemctl restart crow-gateway` cuando te venga bien.

### Desactivar las actualizaciones automáticas {#turning-off}

Hay dos cosas distintas que se pueden desactivar: si la ejecución diaria ocurre
o no, y si además cubre los repositorios que Crow añadió.

- **Instalar sin ellas:** pasa la opción al instalador. El comando único
  documentado le envía el script a bash por stdin, así que la opción va a bash:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash -s -- --no-auto-updates
  curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | CROW_NO_AUTO_UPDATES=1 bash
  ```

  No se cambia nada bajo `/etc/apt/apt.conf.d`: no se escribe ni
  `52crow-unattended-upgrades` ni `20auto-upgrades`. Los demás pasos del
  instalador siguen añadiendo sus fuentes de repositorio y sus keyrings
  (NodeSource en `/etc/apt/sources.list.d`, el keyring de Caddy en
  `/usr/share/keyrings`), así que apt sigue ofreciendo esos paquetes — nada los
  instala solo.

  Con una copia descargada valen las mismas dos formas: `bash crow-install.sh --no-auto-updates`
  o `CROW_NO_AUTO_UPDATES=1 bash crow-install.sh`.

- **Quitar los orígenes extra de Crow:** `sudo rm /etc/apt/apt.conf.d/52crow-unattended-upgrades`.
  Solo quita lo que añade Crow: Node, Docker y Caddy dejan de actualizarse solos,
  mientras la ejecución diaria sigue activa y las actualizaciones de seguridad de
  la distribución siguen instalándose solas.

- **Detener la ejecución diaria:** pon el interruptor en off en `/etc/apt/apt.conf.d/20auto-upgrades`:

  ```
  APT::Periodic::Unattended-Upgrade "0";
  ```

  o ejecuta `sudo dpkg-reconfigure unattended-upgrades` y responde *No*. Esto
  desactiva toda ejecución automática, incluidos los orígenes extra de Crow.

Con las actualizaciones automáticas desactivadas, la tarjeta **Actualizaciones
del sistema** del Nido lo dice y enlaza aquí. Nunca afirma que la máquina está al
día mientras nada las comprueba.