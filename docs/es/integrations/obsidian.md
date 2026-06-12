---
title: Obsidian
---

# Obsidian

Conecta Crow a tu vault de Obsidian para buscar notas y sincronizar conocimiento con tu asistente de IA.

## Qué obtienes

- Buscar en todas las notas de tu vault por contenido o por nombre de archivo
- Leer el contenido de las notas, incluyendo los metadatos del frontmatter
- Explorar la estructura de carpetas del vault
- Sincronizar hallazgos de investigación entre los Proyectos de Crow y Obsidian

## Configuración

### Paso 1: Ubicar la ruta de tu vault

Encuentra la ruta completa a tu vault de Obsidian en el disco:

- **macOS**: Típicamente `~/Documents/ObsidianVault` o `~/Obsidian`
- **Linux**: Típicamente `~/Documents/ObsidianVault` o `~/obsidian`
- **Windows**: Típicamente `C:\Users\TuNombre\Documents\ObsidianVault`

Puedes encontrar la ruta exacta abriendo Obsidian, haciendo clic en el ícono del vault en la esquina inferior izquierda y anotando la ruta que se muestra para tu vault.

### Paso 2: Agregar a Crow

Pega la ruta de tu vault en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

La variable de entorno es `OBSIDIAN_VAULT_PATH`.

No se necesita clave de API — esta integración lee directamente desde tu sistema de archivos local.

## Permisos requeridos

| Permiso | Por qué |
|---|---|
| Acceso de lectura al sistema de archivos | Leer notas, adjuntos y la estructura de carpetas de tu vault |

La integración accede a los archivos del vault directamente en el disco. Obsidian no necesita estar en ejecución.

## Solución de problemas

### "ENOENT: no such file or directory"

La ruta del vault es incorrecta o el directorio no existe. Revisa bien la ruta completa, incluyendo las mayúsculas y minúsculas correctas en los nombres de carpeta en sistemas de archivos sensibles a mayúsculas (Linux).

### No se encuentran notas en la búsqueda

Asegúrate de que la ruta apunte a la raíz del vault (la carpeta que contiene el directorio `.obsidian`), no a una subcarpeta dentro del vault.

### Los cambios no se reflejan

La integración lee los archivos directamente desde el disco. Si acabas de editar una nota en Obsidian, los cambios están disponibles de inmediato — no hay retraso de sincronización.
