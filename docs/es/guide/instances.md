---
title: Encadenamiento Multi-Instancia
description: Conecta múltiples instalaciones de Crow en distintas máquinas en un espacio de trabajo unificado con memoria sincronizada, herramientas federadas y monitoreo centralizado.
---

# Encadenamiento Multi-Instancia

Ejecuta Crow en varias máquinas — un servidor en casa, un VPS en la nube, una Raspberry Pi — y encadénalas bajo una sola identidad. Las memorias se sincronizan automáticamente, y puedes llamar herramientas de cualquier instancia desde cualquier otra.

## ¿Por Qué Encadenar Instancias?

| Beneficio | Cómo ayuda |
|---------|-------------|
| **Redundancia** | Si una instancia se cae, tus datos están a salvo en la otra |
| **Acumulación de niveles gratuitos** | Combina instancias siempre gratuitas de Oracle Cloud + Google Cloud a costo cero |
| **Aislamiento de proyectos** | Dedica instancias a distintas líneas de trabajo (investigación en una, scraping de datos en otra) |
| **Distribución geográfica** | Coloca instancias en diferentes regiones para menor latencia |
| **Resiliencia sin conexión** | Los satélites funcionan de forma independiente cuando están desconectados, y luego sincronizan al reconectarse |

La cadena más simple son dos VMs de nube siempre gratuitas: [Oracle Cloud](/es/getting-started/oracle-cloud) como home + [Google Cloud](/es/getting-started/google-cloud) como satélite. Consulta el [Inicio Rápido Multi-Dispositivo](/es/getting-started/multi-device) para configurarla en 15 minutos.

## ¿Qué Es una Instancia?

Una instancia es una instalación de Crow con alcance de directorio. Cada máquina (o cada directorio de proyecto) puede alojar su propia instancia con su propia base de datos, sus servidores MCP y su gateway.

Dos tipos:

| Tipo | Rol |
|---|---|
| **Home** | Tu instancia principal. Mantiene la identidad autoritativa y actúa como el hub de sincronización. |
| **Satélite** | Instancias secundarias en otras máquinas. Sincronizan con la instancia home y pueden operar de forma independiente cuando están sin conexión. |

Podrías tener una instancia home en tu servidor ejecutando la plataforma completa, y satélites en una laptop para trabajar sin conexión o en una VM en la nube para scraping siempre activo.

## Configuración

### 1. Instala Crow en Ambas Máquinas

Cada máquina necesita su propia instalación de Crow. Sigue la guía de [Servidor en Casa](/es/getting-started/home-server) o de [Instalación de Escritorio](/es/getting-started/desktop-install).

### 2. Comparte Tu Identidad

Ambas instancias deben usar la misma identidad criptográfica. En tu instancia home:

```bash
npm run identity:export
```

Esto produce un archivo cifrado. Transfiérelo a la máquina satélite e impórtalo:

```bash
npm run identity:import
```

Ambas instancias ahora comparten el mismo Crow ID y los mismos pares de claves.

### 3. Registra las Instancias

En la instancia home, registra el satélite:

```
"Registra mi servidor black-swan como instancia satélite"
```

La IA usa `crow_register_instance` para agregar el satélite al registro de instancias. Necesitas la URL del gateway del satélite (p. ej., `http://100.121.254.89:3001` vía Tailscale).

En el satélite, registra la instancia home de la misma manera. Ambos lados necesitan conocerse mutuamente.

### 4. Verifica la Conectividad

```
"Muéstrame el estado de las instancias"
```

El dashboard del Nest también muestra la salud de las instancias en el panel de Instancias — verde para conectada, amarillo para sincronizando, rojo para inalcanzable.

## Cómo Funciona la Sincronización

Las instancias sincronizan datos a través de feeds append-only de **Hypercore** — la misma tecnología P2P que se usa para compartir con peers, pero entre tus propias máquinas en lugar de entre usuarios distintos.

- Cada instancia mantiene un feed de Hypercore para sus cambios salientes
- El `InstanceSyncManager` replica los feeds cuando las instancias se conectan
- Las **marcas de tiempo de Lamport** establecen un orden causal entre máquinas
- Los conflictos (ediciones simultáneas de la misma memoria) se detectan — gana la edición más reciente, y la otra versión se conserva a salvo en lugar de descartarse

Cuando ocurre un conflicto recibes una notificación que enlaza a **Configuración → Conflictos de sincronización**. Ahí puedes revisar ambas versiones lado a lado, conservar la actual o restaurar la que fue sobrescrita — una restauración se sincroniza hacia tus otras instancias como cualquier edición normal.

La sincronización es de **consistencia eventual**. Cuando dos instancias están en línea y pueden alcanzarse (vía Tailscale, LAN o internet pública), los cambios se propagan en cuestión de segundos. Sin conexión, los cambios se encolan localmente y se sincronizan al reconectarse.

### Qué Se Sincroniza

- Memorias (con filtrado por alcance de instancia)
- Proyectos, fuentes y notas
- Entradas del blog y su configuración
- Contactos y configuración de relays

### Qué Se Queda Local

- Claves de identidad (ya compartidas durante la configuración)
- Sesiones del gateway y tokens OAuth
- Archivos de almacenamiento (los objetos S3 se quedan en su MinIO local)

## Federación

La federación te permite llamar herramientas en una instancia remota como si fueran locales. Cuando le pides a Crow buscar memorias, puede consultar la base de datos local y las instancias remotas simultáneamente.

Esto funciona a través del **proxy del gateway**: tu gateway local reenvía las solicitudes MCP al gateway remoto por HTTP, autenticadas con tokens bearer derivados de tu identidad compartida.

```
"Busca en todas mis instancias notas sobre la declaración de impuestos"
```

La IA despacha la búsqueda a cada instancia registrada y combina los resultados.

### Cuándo Usar Federación vs. Sincronización

- La **sincronización** copia datos entre instancias. Úsala cuando quieras tener los mismos datos disponibles en todas partes, incluso sin conexión.
- La **federación** consulta los datos donde están. Úsala para conjuntos de datos grandes que no quieres replicar, o para herramientas que solo tienen sentido en una máquina específica (p. ej., domótica en tu servidor de casa).

## Monitoreo en el Nest

El dashboard de Crow's Nest incluye un panel de **Instancias** que muestra:

- Todas las instancias registradas con su estado de conexión
- La marca de tiempo de la última sincronización por instancia
- Conflictos pendientes que requieren resolución
- Conteos de memorias y proyectos por instancia

Accede a él en la URL de tu gateway, en la pestaña de Instancias.

## Próximos Pasos

- [Inicio Rápido Multi-Dispositivo](/es/getting-started/multi-device) — Guía de configuración paso a paso
- [Arquitectura de Instancias](/es/architecture/instances) — Análisis profundo de los internos de la sincronización
- [Configuración de Tailscale](/es/getting-started/tailscale-setup) — Conectividad segura entre redes
