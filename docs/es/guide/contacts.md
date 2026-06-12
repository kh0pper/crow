---
title: Contactos
---

# Contactos

Gestiona tus contactos en Crow — tanto pares de Crow (conectados mediante códigos de invitación) como contactos manuales que agregas tú mismo.

## Visión general

El panel de Contactos en el Crow's Nest es tu libreta de direcciones. Almacena dos tipos de contactos:

- **Pares de Crow** — Otros usuarios de Crow con los que te has conectado mediante códigos de invitación. Estos contactos tienen identidades criptográficas y pueden intercambiar mensajes, compartir memorias y sincronizar datos.
- **Contactos manuales** — Personas que agregas a mano. Son entradas estándar de libreta de direcciones sin conectividad Crow.

## Agregar contactos

### Pares de Crow (mediante código de invitación)

Para conectar con otro usuario de Crow:

1. Una persona genera un código de invitación:
   > "Crow, genera un código de invitación"
2. Comparte el código con la otra persona (mensaje de texto, correo, etc.)
3. La otra persona acepta la invitación:
   > "Crow, acepta el código de invitación ABC123"

Una vez aceptado, ambas partes aparecen en el panel de Contactos de la otra con conectividad completa de Crow.

También puedes generar y aceptar invitaciones desde el panel de **Contactos** en el Crow's Nest.

### Contactos manuales

Agrega un contacto sin conexión Crow:

- Desde el panel de **Contactos**, haz clic en **Agregar contacto** y completa los detalles
- O pídele a tu IA:
  > "Crow, agrega un contacto para María López — correo maria@example.com, teléfono 555-1234"

Los contactos manuales se almacenan localmente y no requieren que la otra persona use Crow.

## Perfiles de contacto

Cada contacto tiene una página de perfil con:

- **Nombre para mostrar** y avatar
- **Datos de contacto** — correo, teléfono, notas
- **Historial de actividad** — elementos compartidos, mensajes intercambiados (solo pares de Crow)
- **Notas** — notas de texto libre que agregas sobre el contacto
- **Estado** — en línea/desconectado y última vez visto (solo pares de Crow)

Para ver el perfil de un contacto, haz clic en su nombre en el panel de Contactos o pregunta:

> "Crow, muéstrame el perfil de contacto de María"

## Grupos

Organiza tus contactos en grupos para facilitar el filtrado y las operaciones masivas.

### Crear un grupo

> "Crow, crea un grupo de contactos llamado 'Equipo de investigación'"

O desde el panel de Contactos, haz clic en **Grupos** > **Nuevo grupo**.

### Asignar contactos a grupos

> "Crow, agrega a María y Carlos al grupo Equipo de investigación"

También puedes arrastrar contactos a los grupos desde el panel de Contactos.

### Filtrar por grupo

Usa el filtro de grupo en el panel de Contactos para ver solo los contactos de un grupo específico. Los grupos también funcionan con el uso compartido — puedes compartir elementos con un grupo entero a la vez.

## Tu perfil

Tu propio perfil es lo que otros pares de Crow ven cuando se conectan contigo.

### Editar tu perfil

Desde **Crow's Nest** > **Ajustes** > **Identidad**, puedes actualizar:

- **Nombre para mostrar** — el nombre que ven tus pares
- **Avatar** — sube una imagen de perfil
- **Bio** — una descripción breve visible para los contactos

O pídele a tu IA:

> "Crow, actualiza mi nombre para mostrar a 'Kevin H.'"

## Importar y exportar

### Importar contactos

Crow soporta la importación de contactos desde formatos estándar:

- **vCard (.vcf)** — arrastra un archivo `.vcf` al panel de Contactos, o usa el botón de importar
- **CSV** — importa una hoja de cálculo con columnas para nombre, correo, teléfono, etc.

> "Crow, importa contactos desde mi archivo contactos.vcf"

### Exportar contactos

Exporta tus contactos para respaldo o uso en otras aplicaciones:

- **vCard (.vcf)** — formato estándar compatible con la mayoría de libretas de direcciones
- Exporta desde el panel de Contactos vía **Exportar** o pregunta:

> "Crow, exporta todos mis contactos como archivo vCard"

::: tip
Los contactos de pares de Crow incluyen su Crow ID y claves públicas en la exportación. Los contactos manuales se exportan como entradas vCard estándar.
:::
