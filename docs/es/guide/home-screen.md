---
title: Pantalla de Inicio
---

# Pantalla de Inicio

La pantalla de inicio del Crow's Nest es tu lanzador de aplicaciones. Muestra tus paneles y bundles instalados como una cuadrícula limpia de mosaicos — como la pantalla de inicio de un teléfono.

## Qué hay en la pantalla de inicio

- **Saludo** — Ícono de Crow, mensaje de bienvenida y fecha actual
- **Elementos anclados** — Fila opcional sobre la cuadrícula para conversaciones, borradores o proyectos marcados
- **Mosaicos de paneles** — Paneles integrados de Crow (Mensajes, Memoria, Blog, Archivos, Skills, Extensiones, Configuración)
- **Mosaicos de bundles** — Complementos Docker instalados (Ollama, Nextcloud, Immich, etc.)

## Orden de los mosaicos

1. Los paneles integrados aparecen primero, ordenados según su orden de navegación
2. Los mosaicos de bundles siguen después, ordenados por fecha de instalación (el más antiguo primero)

## Ciclo de vida de los mosaicos de bundles

Cuando instalas un complemento de tipo bundle, su mosaico aparece automáticamente en la pantalla de inicio. Cuando lo desinstalas, el mosaico desaparece. No se necesita gestión manual.

- Los bundles con interfaz web la abren en una pestaña nueva al hacer clic
- Los bundles sin interfaz web enlazan al panel de Extensiones
- Los bundles en ejecución muestran un punto de estado verde; los detenidos muestran un punto atenuado

## Íconos de los mosaicos

Los mosaicos de bundles resuelven su ícono en este orden:

1. **Logo de marca** — Los complementos oficiales (Ollama, Nextcloud, etc.) tienen logos SVG personalizados
2. **Ícono del manifiesto** — El campo `icon` del manifiesto del complemento se asigna a un ícono estilo feather
3. **Respaldo de primera letra** — Los complementos desconocidos muestran la primera letra de su nombre

Claves de ícono soportadas en el manifiesto: `brain`, `cloud`, `image`, `home`, `book`, `rss`, `mic`, `message-circle`, `gamepad`, `archive`.

## Qué no recibe mosaicos

- **Servidores MCP** — Integraciones sin interfaz, no hay UI que lanzar
- **Skills** — Archivos de comportamiento en Markdown, visibles en el panel de Skills
- **Complementos de panel** — Ya aparecen como mosaicos de panel vía el registro de paneles

## Elementos anclados

Ancla conversaciones, borradores del blog o proyectos a la pantalla de inicio para acceso rápido. Los elementos anclados aparecen en una fila desplazable sobre la cuadrícula principal. Pasa el cursor sobre un elemento anclado para revelar el botón de desanclar.

## Relacionado

- [Vista general del Crow's Nest](/es/guide/crows-nest) — Documentación completa del dashboard
- [Creating Add-ons](/developers/creating-addons) — Cómo crear complementos que aparecen en la pantalla de inicio
- [Creating Panels](/developers/creating-panels) — Cómo crear paneles para el dashboard
