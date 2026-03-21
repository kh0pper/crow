---
title: Contactos
---

# Contactos

Gestiona tus contactos en Crow — tanto pares de Crow (conectados mediante codigos de invitacion) como contactos manuales que agregas tu mismo.

## Vision general

El panel de Contactos en el Crow's Nest es tu libreta de direcciones. Almacena dos tipos de contactos:

- **Pares de Crow** — Otros usuarios de Crow con los que te has conectado mediante codigos de invitacion. Estos contactos tienen identidades criptograficas y pueden intercambiar mensajes, compartir memorias y sincronizar datos.
- **Contactos manuales** — Personas que agregas a mano. Son entradas estandar de libreta de direcciones sin conectividad Crow.

## Agregar contactos

### Pares de Crow (mediante codigo de invitacion)

Para conectar con otro usuario de Crow:

1. Una persona genera un codigo de invitacion:
   > "Crow, genera un codigo de invitacion"
2. Comparte el codigo con la otra persona (mensaje de texto, correo, etc.)
3. La otra persona acepta la invitacion:
   > "Crow, acepta el codigo de invitacion ABC123"

Una vez aceptado, ambas partes aparecen en el panel de Contactos de la otra con conectividad completa de Crow.

Tambien puedes generar y aceptar invitaciones desde el panel de **Contactos** en el Crow's Nest.

### Contactos manuales

Agrega un contacto sin conexion Crow:

- Desde el panel de **Contactos**, haz clic en **Agregar contacto** y completa los detalles
- O pidele a tu IA:
  > "Crow, agrega un contacto para Maria Lopez — correo maria@example.com, telefono 555-1234"

Los contactos manuales se almacenan localmente y no requieren que la otra persona use Crow.

## Perfiles de contacto

Cada contacto tiene una pagina de perfil con:

- **Nombre para mostrar** y avatar
- **Datos de contacto** — correo, telefono, notas
- **Historial de actividad** — elementos compartidos, mensajes intercambiados (solo pares de Crow)
- **Notas** — notas de texto libre que agregas sobre el contacto
- **Estado** — en linea/desconectado y ultima vez visto (solo pares de Crow)

Para ver el perfil de un contacto, haz clic en su nombre en el panel de Contactos o pregunta:

> "Crow, muestrame el perfil de contacto de Maria"

## Grupos

Organiza tus contactos en grupos para facilitar el filtrado y las operaciones masivas.

### Crear un grupo

> "Crow, crea un grupo de contactos llamado 'Equipo de investigacion'"

O desde el panel de Contactos, haz clic en **Grupos** > **Nuevo grupo**.

### Asignar contactos a grupos

> "Crow, agrega a Maria y Carlos al grupo Equipo de investigacion"

Tambien puedes arrastrar contactos a los grupos desde el panel de Contactos.

### Filtrar por grupo

Usa el filtro de grupo en el panel de Contactos para ver solo los contactos de un grupo especifico. Los grupos tambien funcionan con el uso compartido — puedes compartir elementos con un grupo entero a la vez.

## Tu perfil

Tu propio perfil es lo que otros pares de Crow ven cuando se conectan contigo.

### Editar tu perfil

Desde **Crow's Nest** > **Ajustes** > **Identidad**, puedes actualizar:

- **Nombre para mostrar** — el nombre que ven tus pares
- **Avatar** — sube una imagen de perfil
- **Bio** — una descripcion breve visible para los contactos

O pidele a tu IA:

> "Crow, actualiza mi nombre para mostrar a 'Kevin H.'"

## Importar y exportar

### Importar contactos

Crow soporta la importacion de contactos desde formatos estandar:

- **vCard (.vcf)** — arrastra un archivo `.vcf` al panel de Contactos, o usa el boton de importar
- **CSV** — importa una hoja de calculo con columnas para nombre, correo, telefono, etc.

> "Crow, importa contactos desde mi archivo contactos.vcf"

### Exportar contactos

Exporta tus contactos para respaldo o uso en otras aplicaciones:

- **vCard (.vcf)** — formato estandar compatible con la mayoria de libretas de direcciones
- Exporta desde el panel de Contactos via **Exportar** o pregunta:

> "Crow, exporta todos mis contactos como archivo vCard"

::: tip
Los contactos de pares de Crow incluyen su Crow ID y claves publicas en la exportacion. Los contactos manuales se exportan como entradas vCard estandar.
:::
