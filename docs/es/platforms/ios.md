---
title: iPhone (PWA)
---

# iPhone (PWA)

Accede a Crow desde tu iPhone instalando el Crow's Nest como una app web — sin cuenta de App Store, sin APK, nada que aprobar. Esto se llama Progressive Web App (PWA) y se ve y se comporta como cualquier otro ícono de app en tu pantalla de inicio.

::: tip Requiere iOS 16.4 o posterior
Apple agregó soporte de notificaciones push para apps web instaladas en iOS 16.4. Si no ves la opción de notificaciones, revisa **Ajustes** > **General** > **Información** > **Versión de software** y actualiza si hace falta.
:::

## Paso 1: Únete a la red Tailscale de tu Crow

Si tu gateway de Crow se ejecuta en un servidor casero (algo que no es accesible desde internet directamente), instala Tailscale primero para que tu iPhone pueda alcanzarlo de forma segura desde cualquier lugar:

1. Instala la [app de Tailscale desde App Store](https://apps.apple.com/app/tailscale/id1470499037)
2. Abre Tailscale e inicia sesión con la misma cuenta que usas en tu servidor Crow
3. Activa Tailscale

Consulta la [guía de Configuración de Tailscale](/es/getting-started/tailscale-setup) completa si es la primera vez que la configuras, o si necesitas la dirección Tailscale de tu servidor.

::: tip ¿Ya estás en la misma Wi-Fi?
Si tu iPhone y tu servidor Crow están en la misma red doméstica, puedes saltarte Tailscale y usar directamente la dirección local del servidor.
:::

## Paso 2: Abre la URL de tu Crow's Nest en Safari

1. Abre **Safari** (tiene que ser Safari — otros navegadores en iOS no pueden instalar apps web en la pantalla de inicio)
2. Escribe la dirección que te dio quien configuró tu Crow — se parece a una dirección web, por ejemplo `http://100.121.254.89:3001` o `https://tu-servidor.tu-tailnet.ts.net:8444/dashboard` (el número después de los `:` varía según la configuración — consulta la [guía de Configuración de Tailscale](/es/getting-started/tailscale-setup) o ejecuta `tailscale serve status` en el servidor para encontrar el tuyo)
3. Inicia sesión con tu contraseña del Crow's Nest

## Paso 3: Agrega Crow a tu Pantalla de Inicio

1. Toca el botón **Compartir** (el cuadrado con una flecha hacia arriba, en la barra inferior)
2. Desplázate por la lista de opciones y toca **Agregar a pantalla de inicio**
3. Confirma el nombre (o déjalo como "Crow") y toca **Agregar**

Ahora aparece un ícono de Crow en tu pantalla de inicio, igual que cualquier otra app.

## Paso 4: Abre Crow desde la Pantalla de Inicio y activa las notificaciones

::: warning Abre el ícono, no la pestaña de Safari
El permiso de notificaciones solo se puede conceder **desde dentro de la app instalada** — al tocar el ícono de la pantalla de inicio. Safari por sí solo no ofrecerá activar las notificaciones del sitio, aunque sea la misma página.
:::

1. Cierra Safari y toca el **ícono de Crow** en tu pantalla de inicio
2. Ve a **Ajustes** > **Notificaciones** dentro del Crow's Nest
3. Toca **Activar Push**
4. Cuando iOS pregunte si permite las notificaciones, toca **Permitir**

Listo — Crow ahora se ejecuta a pantalla completa, sin la barra de direcciones de Safari, y puede enviarte notificaciones push para llamadas, mensajes y recordatorios.

## Solución de problemas

### No veo la opción para activar notificaciones

Asegúrate de haber abierto Crow desde el **ícono de la pantalla de inicio**, no desde una pestaña o marcador de Safari. Si no estás seguro, cierra Safari por completo y vuelve a tocar el ícono de Crow.

### Ya lo agregué a la Pantalla de Inicio, pero las notificaciones siguen sin funcionar

- Quita el ícono de la pantalla de inicio (mantén presionado > **Eliminar app** > **Eliminar de la pantalla de inicio**) y repite los Pasos 2 al 4. Esto obliga a iOS a volver a registrar la app.
- Confirma que tienes iOS 16.4 o posterior (**Ajustes** > **General** > **Información**).
- Revisa que las notificaciones no estén silenciadas por un modo Enfoque: **Ajustes** > **Enfoque**, y asegúrate de que el Enfoque activo (No Molestar, Dormir, Trabajo, etc.) permita notificaciones de Crow, o desactiva el Enfoque.
- Revisa **Ajustes** > **Notificaciones** > **Crow** en el propio iPhone y confirma que "Permitir Notificaciones" esté activado.

### La página se ve como un sitio web normal, no como una app

Si sigue mostrando la barra de direcciones y las pestañas de Safari, estás viendo la pestaña de Safari, no la app instalada. Vuelve al Paso 3 y agrégala a la pantalla de inicio, y ábrela siempre desde ese ícono de ahí en adelante.

### No puedo acceder a la página

- Si estás fuera de casa, confirma que Tailscale esté conectado (abre la app de Tailscale y revisa que diga "Conectado")
- Verifica bien la dirección — distingue mayúsculas/minúsculas y necesita la parte `http://` o `https://`
- Pide a quien administra tu servidor Crow que confirme que el gateway está funcionando
