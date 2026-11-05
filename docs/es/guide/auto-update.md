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
   [Reversión automática](#reversion-automatica))
4. **Pull** — ejecuta `git pull --ff-only origin main` (solo fast-forward, sin commits de merge).
   Los cambios locales **no** se guardan en un stash: `git pull` solo se niega cuando el
   diff entrante se solapa con un archivo que modificaste, y deja intactos los demás.
5. **Dependencias** — ejecuta `npm install` si `package.json` o `package-lock.json` cambiaron
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

**Capa 0 (esta versión).** Después del pull y de `npm install`, y *antes* de que se
ejecute `init-db`, el actualizador lanza el `servers/gateway/index.js` descargado en
un proceso hijo con `CROW_GATEWAY_IMPORT_CHECK=1`, usando el entorno que la unidad
configura de verdad. Ese archivo responde con un token de una línea y código de salida
0 como su primerísima instrucción, lo que prueba que todo el grafo estático de
importaciones cargó. Ante una salida distinta de cero, un timeout (60 s) o un token
ausente, el actualizador:

1. escribe `<git-dir>/crow-update-quarantine.json` nombrando el commit — así ninguna
   instancia de este checkout lo vuelve a descargar;
2. mueve el checkout atrás con `git reset --keep <anterior>`, que se niega en lugar
   de destruir cambios locales que se solapen;
3. reinstala las dependencias si cambiaron, y
4. registra `Rolled back: <sha> fails to load (…)` en Settings > Updates y hace sonar
   la campana de notificaciones.

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

**Capa 1 (siguiente).** Un fallo que la capa 0 no puede ver — algo detrás de una
importación dinámica, o un fallo que solo aparece con el entorno del gestor de
servicios — lo detecta un guardián de arranque que corre fuera del grafo de módulos
del gateway, antes de cada arranque, y revierte el checkout tras tres fallos. Se
publica aparte; hasta entonces, un bucle de fallos sigue necesitando la reversión
manual de abajo.

## Reinicio ordenado

Cuando el actualizador automático (o la instalación de un bundle) dispara un reinicio:

1. Emite un evento `crow:shutdown` para cerrar el socket de escucha del servidor HTTP
2. Espera 1 segundo a que el socket se libere
3. Sale con código 1 para que el `Restart=on-failure` de systemd levante el servicio de nuevo

Esto evita el típico error `EADDRINUSE`, donde el proceso nuevo arranca antes de que el viejo haya liberado el puerto.

## Actualización manual

Si prefieres actualizar manualmente:

```bash
cd ~/crow
git pull origin main
npm install
npm run init-db
sudo systemctl restart crow-gateway
```

O dispara una comprobación única desde la página de Settings sin habilitar las comprobaciones automáticas.

## Reversión {#reversion}

Si una actualización causa problemas, revierte **sobre `main`**:

```bash
cd ~/crow
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
[auto-update] Restarting gateway via systemd...
```

Una reversión se lee así:

```
[auto-update] Rolled back: 9d18049 fails to load (import-check); running c29e19c; updates resume when main moves past it
```

Los resultados de las actualizaciones también se guardan en la base de datos y son visibles en Settings > Updates.