---
title: Actualización automática
---

# Actualización automática

Crow incluye un actualizador automático integrado que busca nuevas versiones, descarga los cambios y reinicia el gateway. No se requieren comandos manuales de SSH ni de git.

## Cómo funciona

El actualizador automático se ejecuta como una tarea en segundo plano dentro del proceso del gateway:

1. **Fetch** — ejecuta `git fetch origin main` para buscar nuevos commits
2. **Stash** — si hay cambios locales (archivos modificados, trabajo sin commitear), los guarda automáticamente en un stash
3. **Pull** — ejecuta `git pull --ff-only origin main` (solo fast-forward, sin commits de merge)
4. **Dependencias** — ejecuta `npm install` si `package.json` o `package-lock.json` cambiaron
5. **Migraciones** — ejecuta `node scripts/init-db.js` para cualquier cambio de esquema
6. **Restauración** — aplica el stash para restaurar los cambios locales. Si hay conflictos, restaura un estado limpio y registra una advertencia
7. **Reinicio** — cierra el servidor HTTP de forma ordenada y sale para que systemd reinicie el proceso

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

## Árbol de trabajo sucio

Si tu instancia tiene modificaciones locales (algo común en máquinas de desarrollo o después de ediciones manuales de configuración), el actualizador automático las maneja con cuidado:

1. Antes de hacer pull, ejecuta `git stash --include-untracked` para guardar todos los cambios locales
2. Cuando la actualización termina, ejecuta `git stash pop` para restaurarlos
3. Si la restauración tiene conflictos de merge, el actualizador:
   - Ejecuta `git checkout -- .` para volver a un estado limpio posterior a la actualización
   - Registra una advertencia con instrucciones para recuperar los cambios manualmente
   - Tus cambios quedan preservados en `git stash list` y pueden recuperarse con `git stash pop`

Esto significa que el gateway siempre se reinicia con código fuente válido, incluso si tus cambios locales entran en conflicto con la actualización.

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

## Reversión

Si una actualización causa problemas:

```bash
cd ~/crow
git log --oneline -5          # Encontrar el commit anterior
git checkout <commit-hash>    # Revertir
sudo systemctl restart crow-gateway
```

El actualizador automático solo usa pulls fast-forward, así que `git reflog` siempre conserva el estado anterior.

## Registros

La actividad de actualización se registra en el stdout del gateway (visible con `journalctl -u crow-gateway`):

```
[auto-update] Enabled — checking every 6h
[auto-update] 3 new commit(s) available. Updating...
[auto-update] Dependencies changed — running npm install...
[auto-update] Running database migrations...
[auto-update] Local changes stashed and restored successfully.
[auto-update] Updated: c29e19c → 9d18049
[auto-update] Restarting gateway via systemd...
```

Los resultados de las actualizaciones también se guardan en la base de datos y son visibles en Settings > Updates.
