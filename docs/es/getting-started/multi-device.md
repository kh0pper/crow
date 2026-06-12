---
title: Inicio Rápido Multi-Dispositivo
description: Guía paso a paso para encadenar dos instalaciones de Crow con identidad compartida y datos sincronizados.
---

# Inicio Rápido Multi-Dispositivo

Conecta dos instalaciones de Crow para que compartan la misma identidad, sincronicen memorias y puedan llamar las herramientas una de la otra. Este recorrido toma unos 15 minutos.

## Requisitos previos

- **Dos máquinas** con Crow instalado (consulta [Servidor en Casa](./home-server) o [Instalación de Escritorio](./desktop-install))
- **Node.js 18+** en ambas máquinas
- **Conectividad de red** entre ellas — se recomienda Tailscale (consulta [Configuración de Tailscale](./tailscale-setup)), o la misma LAN

## Paso 1: Elige Tu Instancia Principal

Decide qué máquina es tu instancia **home** (principal) y cuál es la **satélite**. La instancia home es donde se creó tu identidad por primera vez.

Para esta guía, las llamaremos `server-a` (home) y `server-b` (satélite).

## Paso 2: Exporta la Identidad desde la Instancia Home

En `server-a`:

```bash
cd ~/crow
npm run identity:export
```

Se te pedirá una frase de contraseña para cifrar la exportación. El comando muestra una ruta de archivo — algo como `~/.crow/identity-export.enc`.

Copia el archivo a `server-b`:

```bash
scp ~/.crow/identity-export.enc user@server-b:~/
```

## Paso 3: Importa la Identidad en la Satélite

En `server-b`:

```bash
cd ~/crow
npm run identity:import
```

Ingresa la misma frase de contraseña que usaste durante la exportación. Esto reemplaza la identidad de `server-b` con la compartida.

Verifica que ambas máquinas tengan el mismo Crow ID:

```bash
# En server-a
npm run identity

# En server-b
npm run identity
```

Los Crow IDs deben coincidir.

## Paso 4: Inicializa la Base de Datos de la Satélite

En `server-b`, si aún no lo has hecho:

```bash
npm run init-db
```

## Paso 5: Inicia el Gateway en Ambas Máquinas

Cada instancia necesita su gateway en ejecución:

```bash
# En server-a
npm run gateway

# En server-b
npm run gateway
```

Anota las URLs de los gateways — por defecto `http://<ip>:3001`.

## Paso 6: Registra las Instancias

En `server-a`, abre una sesión de Crow y registra la satélite:

```
"Registra server-b como instancia satélite en http://<server-b-ip>:3001"
```

En `server-b`, registra la instancia home:

```
"Registra server-a como mi instancia home en http://<server-a-ip>:3001"
```

::: tip ¿Usas Tailscale?
Usa IPs de Tailscale o nombres de MagicDNS para una conectividad confiable entre redes:
```
"Registra server-b como instancia satélite en http://server-b:3001"
```
:::

## Paso 7: Verifica la Sincronización

En cualquiera de las dos máquinas:

```
"Muestra el estado de las instancias"
```

Deberías ver ambas instancias listadas con estado "online". Ahora prueba la sincronización:

```
# En server-a
"Recuerda que la sincronización multi-dispositivo está funcionando"

# En server-b (espera unos segundos)
"Busca en las memorias sincronización multi-dispositivo"
```

La memoria almacenada en `server-a` debería aparecer en `server-b`.

## Paso 8: Prueba la Federación

La federación te permite llamar herramientas en la instancia remota:

```
# En server-b
"Busca notas de proyecto en todas las instancias"
```

Esto consulta tanto la base de datos local como la de `server-a`, combinando los resultados.

## Ejemplo: Oracle Cloud + Google Cloud

Una configuración común es Oracle Cloud (home, 1 GB de RAM) + Google Cloud (satélite, 1 GB de RAM) — dos nubes always-free encadenadas.

### Configuración

| Instancia | Rol | IP (Tailscale) | Guía |
|----------|------|----------------|-------|
| Oracle Cloud | Home | `100.x.x.x` | [Guía de configuración](./oracle-cloud) |
| Google Cloud | Satélite | `100.y.y.y` | [Guía de configuración](./google-cloud) |

Sigue el paso "Chain with Oracle Cloud" de la [guía de Google Cloud](./google-cloud) para el recorrido completo.

### Lo que obtienes

- **Redundancia** — las memorias existen en ambas nubes
- **Federación** — consulta los proyectos de Oracle desde Google Cloud
- **Aprovechamiento de capas gratuitas** — separa cargas de trabajo entre dos máquinas
- **Distribución geográfica** — Oracle (tu región local) + Google Cloud (EE. UU.)

## Solución de Problemas

### Las instancias aparecen "offline"

- Verifica que ambos gateways estén funcionando: revisa `http://<ip>:3001/health`
- Comprueba la conectividad de red: `curl http://<ip>:3001/health` desde la otra máquina
- Si usas Tailscale, verifica que ambas máquinas estén en la misma tailnet: `tailscale status`

### Error de identidad no coincidente durante el registro

- Vuelve a ejecutar `npm run identity` en ambas máquinas y confirma que los Crow IDs coincidan
- Si difieren, vuelve a exportar desde la instancia home y a importar en la satélite

### Las memorias no se sincronizan

- Comprueba que ambos gateways hayan estado funcionando desde el registro — la sincronización comienza cuando el proceso del gateway se conecta
- Revisa los registros del gateway en busca de errores de sincronización: reinicia el gateway con `DEBUG=crow:*` para salida detallada
- Verifica que las instancias estén registradas en ambos lados (el registro es bidireccional)

### Conflictos de sincronización

Cuando dos instancias editan la misma memoria sin conexión, se crea un conflicto. Revisa el panel de Instancias del dashboard del Nest para ver los conflictos pendientes y resolverlos ahí.

### Tailscale no conecta entre nubes

- Verifica que ambas máquinas estén en la misma red de Tailscale: `tailscale status` en ambas
- Comprueba que el puerto UDP 41641 esté abierto en ambas (requerido para conexiones directas)
- Prueba `tailscale ping <other-ip>` para verificar la conectividad
- Si usas Google Cloud, verifica que el firewall de la VPC permita el tráfico UDP de Tailscale

### La verificación de salud del gateway falla desde la máquina remota

- Verifica que el gateway esté funcionando: `curl http://localhost:3001/health` en la propia máquina
- Revisa UFW: `sudo ufw status` — el puerto 3001 debe estar permitido desde `100.64.0.0/10` (Tailscale)
- Revisa las reglas de firewall de la nube (Security Lists de Oracle / Firewall de VPC de Google)

## Próximos Pasos

- [Guía Multi-Instancia](/es/guide/instances) — Descripción completa de las funciones
- [Arquitectura de Instancias](/es/architecture/instances) — Internos de sincronización y resolución de conflictos
- [Configuración de Tailscale](./tailscale-setup) — Asegura tus conexiones entre redes
