---
title: Modo kiosco
---

# Modo kiosco

El modo kiosco convierte una pantalla de Crow en una superficie de voz a pantalla completa y manos libres — tu pájaro de Ramble, toca para hablar — de modo que una tablet en el mostrador, una pantalla en el estudio o un display de pared se convierte en un Crow al que simplemente le hablas. Es la página de la [Pantalla kiosk](/es/architecture/kiosk).

> El Compañero de IA (un avatar Live2D animado que ejecutaba Open-LLM-VTuber en el puerto `12393`) se **retiró**. Los quioscos, las gafas y el teléfono responden ahora como la misma voz de Crow; no hay front end de avatar por dispositivo ni página en `:12393`.

## Iniciar

Abre la página de la [Pantalla kiosk](/es/architecture/kiosk) a pantalla completa en la pantalla (el panel Kiosk empareja la pantalla y te da su dirección). El navegador pide el micrófono la primera vez.

El encabezado de Crow's Nest ya no tiene el botón **Compañero**. Su único botón, el pájaro, abre la bandeja con un toque y **Hablar con Crow** con una pulsación larga.

La música o la radio que inicias desde Hablar con Crow suena en la **barra del reproductor** del panel, abajo en la página, no dentro de la superposición. Sigue sonando al cerrar la superposición y al pasar de un panel a otro; los botones de la barra la pausan, saltan y detienen, y al recargar la página la barra vuelve (toca ⏯ si el navegador retuvo el sonido). Termina cuando la detienes o cierras sesión.

## Quién responde y los encargos

Todas las pantallas responden como **Crow**, el mismo bot de voz de tus lentes y de Hablar con Crow en el teléfono. Un quiosco no se vincula a un bot propio; la personalidad, el modelo y los límites de herramientas de Crow se configuran una sola vez en el bot de voz **Crow** del [Bot Builder](/es/guide/bot-builder). Lo que sigue siendo por dispositivo es el emparejamiento y sus ajustes de quiosco (seguimiento, memoria, animación, horas de descanso, tema), en el panel Kiosk.

El enrutado de modelos de todas las superficies de voz es el [router `/llm/v1`](/es/developers/configuration) del gateway, en proceso: responde un modelo local rápido (y escala al modelo grande con un `!escalate` inicial o un turno con forma de herramienta). El par sale del rol de voz en Ajustes → Modelos, y `COMPANION_FAST_MODEL` / `COMPANION_ESCALATION_MODEL` siguen sobrescribiéndolo.

Crow puede encargarle un trabajo más grande a uno de tus bots. Un quiosco es una pantalla compartida, así que un «sí» dicho en la sala nunca basta: Crow manda una notificación a tu teléfono y ahí tocas Confirmar. Cuando el bot termina, una sola notificación abre lo que hizo, y si sigues hablando con el quiosco Crow dice que el bot terminó. Puedes preguntar «¿cómo va writer?» y decir «para a writer» o «párala»; Crow te pregunta antes (en un quiosco, también en el teléfono) y lo que el bot ya hizo se conserva. Los bots a los que Crow puede encargar trabajo se eligen en los ajustes de voz de Crow en el Bot Builder (**Encargos a otros bots**). Consulta [la arquitectura del quiosco](/es/architecture/kiosk#encargos).

## Escribir a Crow y desactivar la voz

El botón del teclado de la página (**Escribir un mensaje**) abre un cuadro de mensaje: escribe lo que quieras, toca **Enviar** y Crow responde como lo haría a una pregunta hablada. Está en el **Hablar con Crow** del teléfono y en una pantalla kiosco que tenga un teclado conectado (el kiosco de la Pi ejecuta la página en cage con Chromium y no instala teclado en pantalla).

El botón del altavoz desactiva la voz con un solo toque (**Desactivar la voz**): no se te escucha, las respuestas habladas y las líneas habladas no se dicen, y lo que Crow habría dicho aparece en la pantalla como texto (el timbre del temporizador sigue sonando). Un toque de nuevo (**Activar la voz**) devuelve el micrófono y las respuestas habladas. La elección se conserva en ese dispositivo, así que una pantalla puesta en texto vuelve en texto tras recargar.

Un mensaje escrito puede pedir un encargo igual que uno hablado, y se sigue confirmando en tu teléfono: lo que decide es la pantalla de la que salió el mensaje, no si lo escribiste o lo dijiste.

## Relacionado

- [Arquitectura de la Pantalla kiosk](/es/architecture/kiosk) — la página, sus herramientas y las reglas de los encargos
- [Bot Builder](/es/guide/bot-builder) — el bot de voz de Crow y los demás bots a los que puede encargar trabajo
- [Lentes Meta](/es/guide/meta-glasses) — el canal de voz hermano y el flujo de emparejamiento de dispositivos