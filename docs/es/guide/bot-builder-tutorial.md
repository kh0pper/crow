---
title: "Tu primer bot: un tutorial"
---

# Tu primer bot

Esta es una guía paso a paso para crear tu primer bot en Crow, escrita para personas que nunca han configurado un agente de IA. Sin archivos de configuración, sin línea de comandos, sin jerga. Si puedes rellenar un formulario, puedes crear un bot.

Un **bot** es un ayudante de IA con una tarea. Tú decides cómo se llama, qué modelo de IA lo impulsa, dónde puede hablar la gente con él y qué tiene permitido hacer. Crow lo mantiene funcionando por ti.

Tiempo necesario: unos cinco minutos para un bot con el que puedes hablar de inmediato.

## Antes de empezar

Necesitas una sola cosa: **un proveedor de IA**. Es el servicio (o modelo local) que hace el trabajo de pensar. Si aún no has añadido uno, abre **Ajustes → LLM → Proveedores** en el panel y añádelo primero; de todos modos, el asistente te llevará allí si no hay ninguno configurado.

## Paso 1 — Abre el asistente

En la barra lateral del panel, abre **Bot Builder** y pulsa el botón **Crear un bot**. Verás una serie corta de pantallas con una barra de progreso arriba. Puedes volver **Atrás** en cualquier momento sin perder lo que escribiste, y nada se crea hasta el último paso.

## Paso 2 — Elige un punto de partida

Las plantillas configuran un bot funcional para una tarea común. Puedes cambiar cada detalle después, así que no le des demasiadas vueltas.

| Plantilla | Qué hace | Qué necesitarás |
|---|---|---|
| **Asistente personal** | Chatea contigo, recuerda lo que le dices | Nada: funciona de inmediato |
| **Respondedor de correo** | Lee el correo entrante, redacta respuestas corteses | Una dirección de Gmail y una lista de remitentes permitidos |
| **Preguntas y respuestas en Discord** | Responde preguntas en tu servidor de Discord | Un token de bot de Discord gratuito ([cómo conseguirlo](#conseguir-un-token-de-bot-de-discord)) |
| **Gestor de proyectos** | Trabaja un tablero de tareas: las toma y las avanza | Nada: vincula un proyecto después |
| **Empezar desde cero** | Un bot mínimo con valores seguros | Para cuando quieres control total |

**Para tu primer bot, elige Asistente personal.** No necesita cuentas ni tokens, y puedes hablar con él en cuanto se cree.

## Paso 3 — Nombra tu bot

Escribe un nombre: «Explorador de Investigación», «Ayudante de Tareas», lo que encaje con su trabajo. Un id interno corto se crea automáticamente a partir del nombre (lo verás después en la pantalla de resumen). No necesitas tocar la sección «Avanzado».

## Paso 4 — Elige su modelo de IA

Elige de la lista el modelo que impulsará a tu bot. La lista muestra exactamente lo que está disponible en *tu* Crow, nada imaginario.

Si la lista está vacía, el asistente muestra un enlace a los ajustes de proveedores. Añade un proveedor allí y vuelve a iniciar el asistente: son solo dos pantallas rápidas hasta este punto, y no queda ningún bot a medias (nada se crea hasta el paso final).

Puedes cambiar el modelo en cualquier momento en la pestaña **IA** del bot.

## Paso 5 — Conecta un canal

Un **canal** es donde la gente habla con tu bot. La plantilla elige uno razonable, pero puedes cambiarlo aquí.

- **Crow Messages** (el predeterminado del Asistente personal) viene integrado en Crow: sin cuentas, sin credenciales. Después de crear el bot puedes compartir un enlace o código QR para que tu familia o equipo le escriban.
- **Gmail / Discord / Telegram / Slack** necesitan credenciales de esos servicios — mira las [guías de canales](#guías-de-canales) más abajo. También puedes elegir el canal ahora, saltarte las credenciales y terminar después.
- **Sin canal por ahora** siempre es una opción. El bot funciona igual — puedes hablar con él desde su pestaña Sesiones — y puedes añadir un canal cuando quieras.

## Paso 6 — Revisa y crea

La última pantalla muestra lo que elegiste: plantilla, nombre, id interno, modelo, canal. Pulsa **Crear bot**.

## Paso 7 — La lista de verificación

Aterrizas en la pestaña **Revisar** de tu nuevo bot, que muestra una lista de verificación:

- Las filas con ✓ están listas.
- Las filas con ⚠ te dicen qué falta, en lenguaje claro, con un enlace **Cambiar** que te lleva directo a la pestaña donde se arregla.

El aviso más común en un primer bot está en la fila **Canal** (por ejemplo, un canal de Gmail sin remitentes permitidos todavía: el bot no puede recibir correo hasta configurarlo). La lista nunca finge que algo funciona cuando no es así.

Todo lo técnico (la definición sin procesar, los diagnósticos) está guardado bajo **Avanzado**, al final. No lo necesitas para el uso diario.

## Paso 8 — Habla con tu bot

Para un bot de Crow Messages: abre la pestaña **Gateways** del bot, pulsa **Compartir acceso** y obtendrás un enlace + código QR. Abre el enlace (o abre **Mensajes** en la barra lateral) y salúdalo. Para otros canales, escríbele donde vive: mándale un correo, menciónalo en Discord, etcétera.

## Limpieza

¿Creaste un bot de prueba que no quieres? Ábrelo, despliega **Avanzado** en la pestaña Revisar (o usa el enlace **Eliminar este bot…** en la lista de bots) y confirma. La página de confirmación muestra exactamente qué se eliminará — incluido tu historial de conversación con ese bot — antes de que lo apruebes. La eliminación no se puede deshacer.

## Guías de canales

### Conseguir un token de bot de Discord

1. Ve al [Portal de Desarrolladores de Discord](https://discord.com/developers/applications) e inicia sesión.
2. Pulsa **New Application**, ponle nombre y abre la sección **Bot**.
3. Pulsa **Reset Token** y copia el token: eso es lo que pegas en el campo de token del asistente. Trátalo como una contraseña.
4. En **Privileged Gateway Intents**, activa **Message Content Intent**.
5. En **OAuth2 → URL Generator**, marca `bot`, dale *Send Messages* y *Read Message History*, abre la URL generada e invita al bot a tu servidor.

### Configurar un canal de Gmail

1. Usa una dirección de Gmail con un **alias con signo más**, p. ej. `tu+asistente@gmail.com`: el correo al alias llega a tu bandeja normal y Crow lo vigila.
2. Introduce ese alias como la dirección del bot.
3. Añade a la **lista de permitidos** los remitentes que pueden hablar con el bot, una dirección por línea. **Esto es obligatorio**: con la lista vacía el bot ignora todo el correo, a propósito, para que desconocidos no puedan darle órdenes a tu bot.

### Conseguir un token de bot de Telegram

1. En Telegram, escribe a **@BotFather** y envía `/newbot`.
2. Sigue las instrucciones; BotFather te da un token. Pégalo en el asistente.
3. Si quieres, restringe quién puede usar el bot añadiendo IDs de usuario de Telegram a la lista de permitidos (vacía = cualquiera que encuentre el bot puede hablarle).

### Configurar una app de Slack

1. Crea una app en [api.slack.com/apps](https://api.slack.com/apps) → **From scratch**.
2. En **Socket Mode**, actívalo y crea un **token de nivel de app** con el permiso `connections:write` (empieza por `xapp-`).
3. En **OAuth & Permissions**, añade los permisos de bot `chat:write` y `app_mentions:read` e instala la app en tu espacio de trabajo: eso te da el **token de bot** (empieza por `xoxb-`).
4. Pega ambos tokens en el asistente.

## Adónde ir después

- La [referencia del Bot Builder](/es/guide/bot-builder) explica cada pestaña en profundidad: herramientas, habilidades, permisos, disparadores y canales de voz.
- Dale a tu bot **habilidades** (instrucciones reutilizables para un flujo de trabajo) en su pestaña Habilidades.
- Configura sus **permisos**: los bots nuevos empiezan seguros, sin acceso a la terminal, solo borradores de correo y sin autoaprendizaje.
