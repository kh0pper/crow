---
title: Compartir
---

# Compartir

Comparte memorias, proyectos y notas de forma segura con otros usuarios de Crow. Todo está cifrado de extremo a extremo — ningún servidor central puede ver tus datos.

## Requisitos previos

- Crow instalado y configurado (`npm run setup`)
- Tu Crow ID (se muestra durante la configuración, o ejecuta `npm run identity`)

## Tu Crow ID

Cada instalación de Crow tiene una identidad única, generada durante la configuración:

```
Your Crow ID: crow:k3x7f9m2q4
```

Este es tu identificador público — compártelo con tus amigos para que puedan conectarse contigo. Se deriva de tu clave pública criptográfica y no se puede cambiar (pero puedes rotar las claves si se ven comprometidas).

Para ver tu Crow ID en cualquier momento:

```bash
npm run identity
```

O pregúntale a Crow: *"¿Cuál es mi Crow ID?"* — la herramienta `crow_sharing_status` te lo mostrará.

## Conectar con amigos

Compartir requiere un intercambio de conexión inicial entre dos usuarios de Crow.

### Paso 1: Generar una invitación

Pídele a Crow que cree una invitación:

> "Genera un código de invitación para mi amiga Alice"

Crow crea un código como `AXFK-9M2Q-T4PL-V8KN` que contiene tus claves públicas.

### Paso 2: Enviar la invitación

Envía el código a tu amigo por cualquier canal — mensaje de texto, correo, código QR, Signal, etc. El código en sí no contiene datos sensibles, solo tus claves públicas.

### Paso 3: Tu amigo acepta

Tu amigo le dice a su Crow:

> "Acepta la invitación AXFK-9M2Q-T4PL-V8KN de Bob"

### Paso 4: Verificar el número de seguridad

Después de conectarse, ambos lados ven un **número de seguridad** — un hash corto derivado de ambas claves públicas. Compárenlo por un canal independiente (por ejemplo, en persona o por un canal de confianza) para confirmar que nadie interceptó el intercambio:

```
Safety number: 4829-7153-0926
```

Si ambos ven el mismo número, están conectados de forma segura.

## Compartir memorias

Una vez conectados, compartir es simple:

> "Comparte mi memoria de masa madre con Alice"

Crow busca la memoria, la cifra con la clave pública de Alice y la pone en cola para entrega. Si Alice está en línea, se entrega de inmediato vía Hyperswarm. Si no, se entrega la próxima vez que ambos estén conectados.

### Tipos de compartición

| Lo que dices | Lo que sucede |
|---|---|
| "Comparte mi memoria de masa madre con Alice" | Envía una sola memoria |
| "Comparte mi proyecto de tesis con Bob, solo lectura" | Otorga acceso continuo de lectura a un proyecto |
| "Comparte la fuente 3 de mi tesis con Alice" | Envía una sola fuente del proyecto |
| "Comparte las notas de la reunión con Bob" | Envía una sola nota |

### Niveles de permiso

- **Lectura** — El destinatario puede ver pero no modificar (predeterminado)
- **Lectura-escritura** — El destinatario puede agregar a un proyecto compartido (fuentes, notas)
- **Una vez** — Los datos se entregan una vez y luego se eliminan del feed de sincronización

## Compartir proyectos

Compartir proyectos es más poderoso que compartir elementos individuales. Cuando compartes un proyecto:

1. Se incluyen todas las fuentes, notas y bibliografía
2. La compartición se mantiene sincronizada — los nuevos elementos que agregues aparecen para tu colaborador
3. Con acceso de **lectura-escritura**, los colaboradores pueden agregar sus propias fuentes y notas

> "Comparte mi proyecto de tesis con Alice, lectura-escritura"

El Crow de Alice le notificará:

> "Bob compartió el proyecto 'Investigación de Tesis' contigo (acceso lectura-escritura)"

Los cambios se sincronizan automáticamente cada vez que ambos estén en línea.

## Revisar tu bandeja de entrada

Pídele a Crow que revise las comparticiones y mensajes recibidos:

> "Revisa mi bandeja de entrada"

O sé más específico:

> "¿Tengo comparticiones sin leer?"
> "Muéstrame los mensajes de Alice"

La herramienta `crow_inbox` devuelve todas las comparticiones y mensajes pendientes, con marcas de tiempo y estado de lectura.

## Gestión de permisos

### Revocar acceso

> "Revoca el acceso de Alice a mi proyecto de tesis"

Esto detiene la sincronización del feed del proyecto. Alice conserva su copia local de lo que ya se compartió, pero no recibirá actualizaciones futuras.

### Ver comparticiones activas

> "¿Qué estoy compartiendo con Bob?"

Muestra todas las comparticiones activas con permisos y estado.

## Configuración de relays

Si tú y un contacto rara vez están en línea al mismo tiempo, compartir datos puede ser lento. Los peer relays resuelven esto.

### Usar un relay

Si un amigo tiene un gateway de Crow desplegado en la nube, puede actuar como relay:

> "Agrega el gateway de Alice como relay de confianza: https://alice-crow-server"

El relay almacena datos cifrados (no puede leer tu contenido) y los reenvía cuando tu contacto se conecta.

### Convertirse en relay

Si tu gateway de Crow está desplegado en la nube (siempre en línea), puedes ofrecerte como relay para tus contactos:

> "Habilita el modo relay para mi gateway"

Esto es voluntario y solo sirve a tus contactos existentes.

## Migración de dispositivo

¿Vas a mover Crow a un nuevo dispositivo? Exporta tu identidad:

```bash
# En el dispositivo anterior:
npm run identity:export
# Guarda un archivo cifrado en data/identity-export.enc

# En el nuevo dispositivo:
npm run identity:import
# Solicita la contraseña y restaura la identidad
```

Tu Crow ID permanece igual. Tus contactos no necesitan reconectarse.

## Notas de seguridad

- Todas las comparticiones están **cifradas de extremo a extremo** — solo el destinatario puede leerlas
- Tu semilla de identidad está cifrada en reposo con tu contraseña
- Los códigos de invitación expiran después de 24 horas y son de un solo uso
- Los números de seguridad permiten verificar que las conexiones no fueron interceptadas
- Los relays solo ven blobs cifrados — no pueden leer tus datos
- Puedes bloquear contactos en cualquier momento para detener toda comunicación
