---
title: Crow Messages
---

# Crow Messages

Crow Messages permite que tus agentes sean accesibles igual que las personas: como contactos a los que envías mensajes. Puedes compartir un bot para que otra persona hable con él, explorar los bots que corren en tus propios Crows y agregarlos con un clic, y reunir a personas y bots en una sala grupal. Funciona sobre la mensajería entre pares de Crow, así que las conversaciones están cifradas de extremo a extremo y viajan por relays públicos sin un servidor central en medio.

La idea central de toda la función es una sola línea: **un bot es un contacto.** Todo lo de abajo se construye sobre eso, de modo que un bot aparece, recibe mensajes y se une a un grupo exactamente como lo haría una persona, solo que con una insignia de bot.

## Compartir un bot

Cada agente que ejecuta una pasarela de **Crow Messages** obtiene su propia identidad de mensajería, derivada de tu instancia, para poder ser contactado directamente. Desde el editor del bot puedes compartirlo:

- Un **enlace** para compartir y un **código QR** escaneable que llevan una invitación firmada, de un solo uso o de uso limitado.
- Una lista de **"Quién puede enviar mensajes"** (la lista de control de acceso). Compartir es **denegar por defecto**: solo te pueden contactar las personas que has invitado o agregado. Puedes revocar a cualquiera en cualquier momento.
- Un interruptor **"permitir instancias emparejadas"**. Cuando está activo, tus otros Crows (las instancias que has emparejado) pueden enviar mensajes al bot sin una invitación aparte, que es lo que hace funcionar el directorio y las salas grupales de abajo a través de tu flota.

Compartir nunca expone el bot a la internet abierta. Una invitación autoriza la clave de una persona concreta, y el bot responde como él mismo, bajo su propia persona, habilidades y política de permisos.

## Enviar un mensaje a un bot, o aceptar una invitación

Cuando alguien comparte un bot contigo, aceptas la invitación y el bot aparece en tu lista de **Mensajes** como cualquier otro contacto, con una insignia de bot. Hay dos formas de entrar, ambas desde el menú **"+"** de Mensajes:

- **Agregar un bot**: pega un código de invitación que te dieron.
- Un **enlace directo** desde un enlace para compartir abre el flujo de aceptación directamente.

A partir de ahí es una conversación normal. Tú escribes, el agente responde desde su propia identidad, y el hilo vive junto a tus demás mensajes.

## Explorar los bots de tus Crows

Si tienes más de un Crow, los bots que has decidido compartir se anuncian a tus otras instancias emparejadas, para que puedas encontrarlos y agregarlos sin copiar códigos de invitación de un lado a otro. El directorio muestra cada bot anunciado, agrupado por el Crow en el que corre, cada uno con una breve descripción, y marca los que ya has agregado.

Puedes abrir el directorio desde dos lugares:

- **Contactos → Explorar bots de Crow**
- **Mensajes → "+" → Enviar mensaje a un bot**

Agregar un bot desde el directorio lo materializa como contacto y te lleva directo a una conversación.

## Salas grupales: personas y bots juntos

Una sala es un hilo de varias partes que mezcla personas y bots. Creas una, le pones nombre y agregas miembros igual que agregarías un contacto, incluidos tus bots. Esta es la parte que se pidió en palabras sencillas: "agregar un bot a un chat como se agrega un contacto".

Crea una sala desde **Mensajes → "+" → Nuevo grupo**: ponle nombre, elige los miembros (personas y bots, con los bots marcados), elige cómo deben responder los bots, y ya estás dentro.

**Cómo toma turno un bot.** Cada sala tiene un ajuste para cuándo hablan sus bots:

| Modo | Comportamiento |
|---|---|
| **Solo cuando se le menciona** (predeterminado) | Un bot responde solo cuando una persona lo menciona con @ o lo nombra. Las personas pueden conversar libremente sin que el bot intervenga, y con varios bots en una sala solo responde aquel al que te diriges. |
| **A cada mensaje** | Cada bot de la sala responde a cada mensaje que envía una persona. Animado con un solo bot, más ruidoso con varios. |

**Los bots nunca se responden entre sí.** Un bot solo reacciona a un mensaje que escribió una *persona*, nunca al mensaje de otro bot. Es una regla estructural, no un ajuste, así que una sala llena de bots nunca puede entrar en un bucle hablando consigo misma.

**Gestionar una sala.** Desde el encabezado de la sala puedes renombrarla, cambiar el modo de respuesta, agregar o quitar miembros (personas o bots) y eliminar la sala. Quitar a un miembro deja de retransmitirle; eliminar una sala borra su historial.

## Privacidad y control

- **Denegar por defecto en todas partes.** Un bot responde solo a las personas de su lista de acceso; una sala retransmite solo a sus miembros. Nadie llega a un bot o a una sala adivinando.
- **Remitentes verificados.** Cada mensaje se autoriza por la firma criptográfica del remitente, nunca por un nombre o etiqueta en el cuerpo del mensaje, así que un participante no puede hacerse pasar por otro para hacer actuar a un bot.
- **Tú alojas tus salas.** Una sala que creas la retransmite tu propio Crow. Tú decides quién está en ella y puedes quitar a cualquiera.
- **Sin servidor central.** Los mensajes están cifrados de extremo a extremo y se mueven por relays públicos. Crow es lo único que guarda tu lado de la conversación.

## Relacionado

- [Bot Builder](/es/guide/bot-builder): Construye los agentes que compartes y agregas a salas
- [Social y Mensajería](/es/guide/social): La mensajería persona a persona de Crow
- [Contactos](/es/guide/contacts): Gestiona personas y bots como contactos
- [Compartir](/es/guide/sharing): Comparte memorias, proyectos y archivos con otros Crows
- [Arquitectura de Bot Builder](/es/architecture/bot-builder): El adaptador de mensajería, las identidades y el modelo de salas
