# Social y Mensajería

Envía mensajes cifrados, mantén conversaciones en hilos e interactúa con tus contactos — todo impulsado por el protocolo Nostr. Sin cuentas, sin servidores centrales, sin fugas de metadatos.

Para voz y video, consulta [Llamadas de Video y Audio](/es/guide/calls).

## Cómo Funciona

Crow usa el **protocolo Nostr** para las funciones sociales ligeras:

- **Cifrado de extremo a extremo** — Los mensajes usan cifrado NIP-44 (ChaCha20-Poly1305)
- **Anonimato del remitente** — Los gift wraps de NIP-59 ocultan quién habla con quién en los relays públicos
- **Siempre asíncrono** — Los mensajes persisten en los relays hasta que tu contacto los recupera
- **Sin cuentas** — Tu identidad de Nostr se deriva del mismo par de claves de Crow — no hay nada extra que configurar

Los datos pesados (compartición de proyectos, memorias en bloque) usan Hypercore. Las interacciones sociales ligeras (mensajes, reacciones) usan Nostr. Ambos comparten el mismo Crow ID.

## Enviar Mensajes

Háblale a Crow con naturalidad:

> "Envíale un mensaje a Alice: Oye, ¿viste el nuevo artículo sobre arquitecturas de transformers?"

Crow cifra el mensaje para la clave pública de Alice, lo envuelve para el anonimato y lo publica en tus relays de Nostr configurados. El Crow de Alice lo recoge la próxima vez que ella esté en línea.

### Ejemplos de mensajes

| Lo que dices | Lo que sucede |
|---|---|
| "Mensaje para Alice: ¿Puedes revisar el borrador de mi tesis?" | Envía un DM cifrado |
| "Responde al último mensaje de Alice: Suena bien, veámonos el jueves" | Envía una respuesta en hilo |
| "Envíale a Bob el enlace a esa memoria de masa madre" | Envía un mensaje con una referencia |

## Conversaciones en Hilos

Los mensajes pueden organizarse en hilos para mantener discusiones ordenadas:

> "Responde al mensaje de Alice sobre la conferencia"

Crow encuentra el mensaje más reciente de Alice que coincide con ese contexto y crea una respuesta en hilo. Los hilos mantienen las conversaciones organizadas, especialmente cuando discutes varios temas con el mismo contacto.

### Ver hilos

> "Muéstrame mi conversación con Alice"
> "Muestra el hilo sobre la conferencia"

La herramienta `crow_inbox` devuelve los mensajes agrupados por hilo, con marcas de tiempo y estado de lectura.

## Revisar Mensajes

Los mensajes llegan automáticamente cuando tu instancia de Crow está en ejecución. Para ver qué hay de nuevo:

> "Revisa mis mensajes"
> "¿Hay mensajes nuevos de Bob?"
> "Muestra los mensajes sin leer"

La herramienta `crow_inbox` recupera los mensajes de los relays de Nostr y los devuelve junto con cualquier compartición de Hypercore que hayas recibido.

## Configuración de Relays de Nostr

Crow se conecta de forma predeterminada a relays públicos y gratuitos de Nostr:

- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.nostr.band`

### Agregar relays

> "Agrega wss://relay.example.com como relay de Nostr"

Más relays = mayor confiabilidad en la entrega de mensajes. Los mensajes se publican en todos los relays configurados, así que basta con que tu contacto comparta un solo relay en común contigo.

### Eliminar relays

> "Elimina wss://relay.example.com de mis relays"

### Ver el estado de los relays

> "Muestra el estado de mis relays de Nostr"

La herramienta `crow_sharing_status` muestra todos los relays configurados, su estado de conexión y la hora de la última sincronización exitosa.

## Privacidad y Seguridad

### Qué pueden ver los relays

Los relays de Nostr son infraestructura pública. Sin protecciones, podrían ver metadatos de los mensajes (quién habla con quién, cuándo). Crow lo mitiga así:

- **Cifrado NIP-44** — El contenido del mensaje siempre está cifrado. Los relays solo ven texto cifrado.
- **Gift wraps de NIP-59** — Los mensajes se envuelven en un sobre exterior con una clave desechable aleatoria. El relay ve el envoltorio, no tu identidad real. Tu contacto lo desenvuelve para encontrar tu mensaje real adentro.

### Qué no pueden ver los relays

- El contenido del mensaje (cifrado)
- Quién envió el mensaje (envuelto con gift wrap)
- Tu Crow ID o tus claves públicas (ocultos por el envoltorio)

### Qué sí pueden ver los relays

- Que *alguien* publicó *algo* en un momento dado
- El tamaño aproximado de la carga cifrada
- La clave desechable del envoltorio (inútil para la identificación)

### Persistencia de mensajes

Los mensajes persisten en los relays hasta que se recuperan. La mayoría de los relays públicos retienen los mensajes de días a semanas. Para una entrega garantizada:

1. Usa varios relays (redundancia)
2. Mantén al menos un relay en común con cada contacto
3. Considera operar tu propio relay para tener el máximo control

## Reacciones

Responde a comparticiones y mensajes con reacciones:

> "Reacciona al último mensaje de Alice con un pulgar arriba"

Las reacciones son eventos ligeros de Nostr — no saturan tus feeds de Hypercore.

## Comparación: Nostr vs Hypercore

Crow usa ambos protocolos, cada uno para lo que hace mejor:

| Característica | Nostr | Hypercore |
|---|---|---|
| **Caso de uso** | Mensajes, reacciones, social | Proyectos, memorias, datos en bloque |
| **Entrega** | Vía relays públicos (siempre asíncrona) | P2P directo (o vía peer relay) |
| **Persistencia** | Depende del relay (días a semanas) | Permanente (feeds de solo anexar) |
| **Límite de tamaño** | Cargas pequeñas (texto) | Cargas grandes (archivos, conjuntos de datos) |
| **Identidad** | Clave secp256k1 | Clave Ed25519 |
| **Ambas derivadas de** | La misma semilla maestra de Crow | La misma semilla maestra de Crow |

No necesitas pensar en qué protocolo usar — Crow elige automáticamente según lo que estés haciendo.

## Solución de Problemas

### Los mensajes no se entregan

1. Revisa el estado de los relays: *"Muestra el estado de mis relays de Nostr"*
2. Verifica que compartas al menos un relay con tu contacto
3. Prueba agregar un relay popular: *"Agrega wss://relay.damus.io como relay"*

### No puedo ver los mensajes de un contacto

1. Verifica que el contacto esté conectado: *"Muestra mis contactos"*
2. Revisa tu bandeja de entrada: *"Revisa mi bandeja de entrada"*
3. Puede que el contacto esté usando relays a los que tú no estás conectado

### La entrega de mensajes es lenta

Los relays públicos son infraestructura gratuita y ocasionalmente pueden ser lentos. Para una entrega más rápida:

1. Agrega más relays para redundancia
2. Pregúntale a tu contacto qué relays usa y agrégalos
3. Considera un relay dedicado para tu grupo
