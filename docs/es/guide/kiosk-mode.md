---
title: Modo kiosco
---

# Modo kiosco

El modo kiosco convierte una pantalla de Crow en un [Compañero de IA](/es/architecture/companion) a pantalla completa — un avatar animado con el que puedes hablar. Es la forma en que una tablet en el mostrador, una pantalla en el estudio o un display de pared se convierte en una superficie de Crow manos libres.

## Iniciar

Abre el compañero en su propia dirección —el puerto `12393` del host de Crow— en un navegador a pantalla completa en la pantalla. El navegador pide el micrófono (y la cámara, si el seguimiento facial está activado) la primera vez.

El encabezado de Crow's Nest ya no tiene el botón **Compañero**. Su único botón, el pájaro, abre la bandeja con un toque y **Hablar con Crow** con una pulsación larga; Hablar con Crow es la página de la [Pantalla kiosk](/es/architecture/kiosk) (tu pájaro de Ramble, toca para hablar), no el compañero con avatar.

La música o la radio que inicias desde Hablar con Crow suena en la **barra del reproductor** del panel, abajo en la página, no dentro de la superposición. Sigue sonando al cerrar la superposición y al pasar de un panel a otro; los botones de la barra la pausan, saltan y detienen, y al recargar la página la barra vuelve (toca ⏯ si el navegador retuvo el sonido). Termina cuando la detienes o cierras sesión.

## Quién responde y los encargos

Todas las pantallas responden como **Crow**, el mismo bot de voz de tus lentes y de Hablar con Crow en el teléfono. Un quiosco ya no se vincula a un bot propio; la personalidad, el modelo y los límites de herramientas de Crow se configuran una sola vez en el bot de voz **Crow** del [Bot Builder](/es/guide/bot-builder). Lo que sigue siendo por dispositivo es el aspecto del compañero: el avatar y las funciones del quiosco (animación del avatar, modo mascota/inactivo, chat social, memoria), que se ajustan donde emparejas la pantalla.

Crow puede encargarle un trabajo más grande a uno de tus bots. Un quiosco es una pantalla compartida, así que un «sí» dicho en la sala nunca basta: Crow manda una notificación a tu teléfono y ahí tocas Confirmar. Cuando el bot termina, una sola notificación abre lo que hizo, y si sigues hablando con el quiosco Crow dice que el bot terminó. Puedes preguntar «¿cómo va writer?» y decir «para a writer» o «párala»; Crow te pregunta antes (en un quiosco, también en el teléfono) y lo que el bot ya hizo se conserva. Los bots a los que Crow puede encargar trabajo se eligen en los ajustes de voz de Crow en el Bot Builder (**Encargos a otros bots**). Consulta [la arquitectura del quiosco](/es/architecture/kiosk).

El avatar surte efecto en la siguiente sesión del quiosco. Los toggles de funciones se aplican en capas distintas: las funciones de configuración de dispositivo (`social_chat`, `face_tracking`) se obtienen y aplican en cada carga de página del quiosco; las funciones de generación de config (`avatar_model`, `memory_integration`) se incorporan a la config generada del compañero y solo surten efecto tras regenerar la config y reiniciar el contenedor. Consulta la [tabla de semántica de `companion_features`](/es/architecture/companion) para el desglose completo.

El par de modelos lo comparten todas las pantallas porque un contenedor de compañero tiene un único `base_url` de LLM (el [router `/llm/v1` del gateway](/es/architecture/companion)). Un quiosco que de verdad necesite un par de modelos *distinto* necesita su **propio contenedor de compañero** (puerto propio + `conf.yaml`).

## Funciones sociales / de chat

La sala de chat y los DM del compañero están controlados por el toggle por dispositivo `social_chat`, de modo que un kiosco de cara al público puede funcionar solo con el avatar (sin UI social) mientras una pantalla personal conserva el chat completo.

## Relacionado

- [Arquitectura del Compañero de IA](/es/architecture/companion) — el motor, el router de modelos y el escalamiento
- [Bot Builder](/es/guide/bot-builder) — definir el agente que ejecuta un kiosco
- [Lentes Meta](/es/guide/meta-glasses) — el canal de voz hermano y el flujo de emparejamiento de dispositivos
