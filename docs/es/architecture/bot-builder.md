---
title: Arquitectura del Bot Builder
---

# Bot Builder

El Bot Builder es la plataforma de agentes nativa de Crow — la vía de primera clase para construir y ejecutar agentes en Crow.

Un agente es una definición almacenada en la tabla `pi_bot_defs` de la `crow.db` de Crow. El dashboard edita esa definición; un runtime de agentes ligero la ejecuta por turno; los gateways alimentan los turnos desde el correo, Discord y los lentes.

## Componentes

```
┌──────────────────────────────────────────────────────────────────┐
│  Crow's Nest                                                      │
│  ├── panel Bot Builder  (editor con pestañas → pi_bot_defs)       │
│  └── panel Bot Board    (estado / API del board)                  │
├──────────────────────────────────────────────────────────────────┤
│  Definición del agente (fila de pi_bot_defs)                      │
│   persona · skills · tools · gateways · permission_policy · model │
├──────────────────────────────────────────────────────────────────┤
│  scripts/pi-bots/                                                 │
│   bridge.mjs          runtime de agente por turno (lanza el motor)│
│   ext_registry.mjs    extensiones instaladas → herramientas+skills│
│   skill_resolver.mjs  resuelve el texto de la skill por nombre    │
│   mcp_writer.mjs      acuña el .mcp.json por agente               │
│   skill_proposals.mjs autoescritura opcional (proponer → aprobar) │
│   discord_gateway.mjs canal de Discord                            │
│   bridge_tick.mjs     canal de Gmail                              │
├──────────────────────────────────────────────────────────────────┤
│  bundles/meta-glasses/  gateway de lentes: el bot vinculado       │
│                         dirige el turno de voz acotado y con      │
│                         permisos aplicados                        │
├──────────────────────────────────────────────────────────────────┤
│  crow.db (SQLite, WAL)  pi_bot_defs + datos compartidos de Crow   │
└──────────────────────────────────────────────────────────────────┘
```

## La definición del agente

Cada fila en `pi_bot_defs` es una definición JSON con estas partes:

- **persona**: el system prompt
- **skills**: nombres que se resuelven a texto de skill en tiempo de ejecución
- **tools**: el conjunto de herramientas permitido: las categorías de herramientas centrales de Crow más herramientas de extensiones seleccionadas
- **gateways**: los canales en los que corre el agente (`gmail`, `discord`, `glasses`, `companion`)
- **permission_policy**: los conjuntos de confirmación / denegación, el modo `external_send` y el interruptor `self_authoring`
- **model** y un `fast_voice_model` opcional

El editor fusiona los campos de una pestaña a la vez, de modo que los guardados no son destructivos entre pestañas. En cualquier instancia de Crow que no tenga la tabla `pi_bot_defs`, el panel renderiza un aviso amigable en lugar de fallar.

## Las extensiones aportan herramientas y skills

Una extensión instalada aporta tanto herramientas MCP (declaradas en su bloque `mcp-addons.json`) como skills (declaradas en su manifiesto). `ext_registry.mjs` enumera las extensiones instaladas y expone sus herramientas y skills a la paleta del Bot Builder.

Cuando un agente selecciona una herramienta de una extensión que no forma parte del conjunto canónico de herramientas de Crow, `mcp_writer.mjs` acuña un bloque de servidor MCP por agente y lo fusiona en el `.mcp.json` propio de ese agente. La fusión es aditiva y nunca muta la configuración canónica compartida. Cada agente, por tanto, corre con exactamente los servidores que su selección requiere.

## El runtime del agente

`bridge.mjs` es el runtime por turno. Para cada turno entrante ensambla el system prompt del agente y el texto de skills resuelto, apunta el motor al `.mcp.json` acuñado del agente y ejecuta el turno. Como el runtime se lanza por turno, los cambios a la definición de un agente surten efecto en el siguiente turno sin reiniciar ningún servicio.

## Gateways

| Gateway | Punto de entrada | Transporte |
|---|---|---|
| **Gmail** | `bridge_tick.mjs` | Sondea un buzón conectado, redacta borradores o envía respuestas sujeto a la política |
| **Discord** | `discord_gateway.mjs` | Un WebSocket de Discord de larga vida que dirige el runtime, con una lista de usuarios permitidos por agente |
| **Meta Glasses** | `bundles/meta-glasses/` | Un dispositivo emparejado se vincula a un agente y dirige el turno de voz rápido |
| **AI Companion** | `bundles/companion/` + `scripts/companion/model-proxy.mjs` | Un dispositivo kiosko se vincula a un agente; el bucle OLVV del [companion](/es/architecture/companion) ejecuta la persona/avatar/herramientas de ese agente, con un proxy de modelos que enruta rápido (4B) → escalado (35B) |
| **Crow Messages** | `scripts/pi-bots/gateways/crow-messages.mjs` | El agente es accesible como contacto a través de la mensajería entre pares de Crow; los DM cifrados de remitentes autorizados dirigen el runtime y el agente responde desde su propia identidad derivada. Consulta [Crow Messages](#crow-messages-los-bots-como-contactos) abajo. |

> Los canales de Meta Glasses y AI Companion ejecutan su propio bucle de voz (el turno de voz de los lentes; OLVV para el companion) en lugar del runtime pi `bridge.mjs` — así que la persona/skills/herramientas del agente vinculado dirigen el turno, pero el motor es el front end de voz, no pi. Consulta [AI Companion](/es/architecture/companion).

## Crow Messages: los bots como contactos

La pasarela de Crow Messages hace que un agente sea accesible como un contacto de primera clase a través de la mensajería entre pares de Crow. Toda la superficie — compartir un bot, el directorio entre Crows y las salas grupales — descansa sobre un principio: **un bot es un contacto.** Consulta la [guía de Crow Messages](/es/guide/crow-messages) para el recorrido orientado al usuario.

**Identidad por bot.** Cada agente que ejecuta una pasarela de crow-messages tiene un par de claves Nostr *derivado* de la semilla de la instancia más el id del bot (`deriveBotIdentity`). No se almacena nada: la misma derivación corre en el panel (para mostrar la dirección del bot y acuñar invitaciones) y en el host de pi-bots (para suscribirse y responder), así que ambos siempre coinciden. El bot responde desde su propia clave, como él mismo.

**Adaptador y autorización.** `scripts/pi-bots/gateways/crow-messages.mjs` suscribe el bot a su propio pubkey, descifra los DM entrantes y dirige el runtime real `bridge.mjs` para los remitentes autorizados. La autorización es **denegar por defecto** y se basa en el firmante del evento verificado criptográficamente, nunca en un campo declarado en el cuerpo del mensaje. La lista de acceso (`bot_message_acl`) se llena al aceptar una invitación firmada con ed25519 (`bot_message_invites`); un modo opcional de "permitir instancias emparejadas" también admite los propios Crows emparejados del operador. Una tabla persistente de eventos vistos hace el turno idempotente frente a la ventana de reenvío de un relay.

**Bots como contactos + el directorio.** Aceptar un bot escribe una fila en `contacts` marcada `is_bot`, que es la costura sobre la que se construye el resto de la función. Los bots que se suman se anuncian a las instancias emparejadas del operador por un transporte firmado de `advertised-bots`, y `getBotDirectory` los agrega a través de la flota (agrupados por instancia, deduplicados por pubkey de mensajería) para que el panel pueda explorarlos y agregarlos con un clic.

**Salas grupales.** Una sala reutiliza la tabla existente `contact_groups`: un grupo se convierte en una sala de varias partes cuando lleva un `room_uid` (los grupos organizativos simples no se tocan). Los miembros reutilizan `contact_group_members`; los mensajes de sala viven en su propia tabla `room_messages`. El transporte es **hub-and-spoke** sobre los mismos DM por pares: la instancia anfitriona de la sala distribuye cada mensaje a cada miembro (personas y bots por igual) mediante un `sendControl` de solo publicación que no contamina la caché de mensajes uno a uno. Un bot es solo un participante direccionado en su pubkey, así que los bots locales y remotos son un único camino de código.

Dos invariantes estructurales hacen que las salas sean seguras y no solo ajustadas:

- **Seguridad ante bucles.** Un bot ejecuta un turno solo ante un mensaje escrito por una *persona*, y solo cuando el `addressed_to` calculado por el anfitrión lo nombra (o la sala está en modo "a cada mensaje"). La propia respuesta de un bot se marca como de bot, lo cual todo bot ignora. Redistribuir la respuesta de un bot nunca vuelve a activar a un bot, así que el trabajo queda acotado a un turno por bot por mensaje humano — un bucle es imposible por construcción.
- **Atribución verificada por firma.** Un mensaje de sala recibido se atribuye al firmante verificado, no a ninguna etiqueta de autor en la carga útil, así que un miembro no puede hacerse pasar por otro ni cambiar la insignia de bot para suprimir el direccionamiento.

## La vía de voz

Un dispositivo de lentes lleva un `bound_bot_id`. Cuando un dispositivo está vinculado, su turno de voz lo dirige ese agente en lugar de un perfil genérico:

- **Prompt**: la persona y las skills del agente vinculado, más un breve apéndice de estilo de voz.
- **Herramientas**: un conjunto acotado. Las categorías de herramientas centrales de Crow se incluyen cuando el agente seleccionó una herramienta bajo el servidor correspondiente, y las herramientas de una extensión se incluyen solo cuando el agente las seleccionó y el servidor está conectado. Un mapa de canónico a categoría de voz decide qué selecciones tienen un equivalente de voz; las selecciones sin equivalente se muestran como una advertencia en el editor en lugar de descartarse en silencio.
- **Modelo y voz**: el `fast_voice_model` del agente, resuelto a través del sistema de perfiles de Crow, con los perfiles de habla, texto-a-voz y visión del dispositivo aportando las voces.
- **Permisos**: un wrapper de despacho consciente de la política corre antes de que se ejecute cualquier herramienta. Resuelve la acción efectiva detrás de cualquier wrapper de herramienta de propósito general y luego aplica los conjuntos de confirmación y denegación del agente y su modo `external_send` (degradando las publicaciones a borradores y bloqueando los envíos reales). Una acción bloqueada o que requiere confirmación se responde por voz.

Este wrapper es la frontera de seguridad para la voz. Cierra la brecha que dejaba la antigua puerta de confirmación basada solo en nombres, que podía evadirse enrutando una acción protegida a través de una herramienta wrapper.

## Trabajo profundo

El trabajo de larga duración se entrega como un trabajo en segundo plano mediante la herramienta `crow_delegate`. El trabajo se encola en la tabla compartida `bot_jobs` y lo ejecuta un worker de pi en el proceso anfitrión del Bot Builder — un único agente fuerte realizando el trabajo de varios pasos en un contexto coherente. El agente acusa recibo de inmediato con un ID de trabajo y el resultado se entrega en un turno posterior (se obtiene con `crow_job_status`, o se envía al canal de origen), ya que el trabajo sobrevive al turno que lo inició. Una vía persistente de notificación de finalización es un siguiente paso planeado.

## Autoescritura opcional (opt-in)

`skill_proposals.mjs` implementa el flujo de proponer-y-aprobar. Cuando el `permission_policy.self_authoring` de un agente es true, el runtime agrega un directorio de staging confinado a las rutas de escritura del agente e inyecta la guía para escribir skills. El agente puede redactar un archivo de skill únicamente en staging.

Un archivo en staging es inerte por construcción. El resolvedor de skills carga las skills por nombre desde los directorios de skills, y el directorio de staging no es uno de ellos, así que un archivo en staging no puede resolverse y no se adjunta al agente. La aprobación, a través de la API del Bot Board, promueve el texto revisado por el operador a la biblioteca de skills y lo adjunta a la definición del agente. La vía de aprobación incluye una guarda de actualización optimista, una verificación de no-sobrescritura contra archivos existentes y una negativa a seguir symlinks. Como las skills son texto de prompt, la aprobación nunca puede otorgar herramientas ni cambiar una política de permisos.

## Relacionado

- [Guía del Bot Builder](/es/guide/bot-builder): El recorrido de cara al usuario
- [Meta Glasses](/es/guide/meta-glasses): El gateway de lentes en uso
- [Gestión de contexto](/es/architecture/context-management): Cómo se anuncian las herramientas para mantener el contexto ligero
