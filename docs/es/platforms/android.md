---
title: Aplicación Android
---

# Aplicación Android

Accede a Crow desde tu dispositivo Android con la aplicación nativa o como una Progressive Web App (PWA).

## Opción A: Instalar el APK

### Paso 1: Descargar el APK

Descarga la última versión de Crow para Android:

[Descargar Crow para Android (v1.5.0)](https://github.com/kh0pper/crow/releases/download/android-v1.5.0/app-release.apk)

Esta versión funciona en los teléfonos Android más nuevos (Android 15 y el diseño de memoria de 16 KB).

::: warning Desinstala primero la app anterior
Esta actualización cambia la firma de la app, así que Android no la instalará encima de una versión anterior de Crow. **Desinstala primero tu app de Crow actual y luego instala esta.** Tendrás que volver a emparejar tus gafas y reintroducir la dirección de tu gateway una vez — un paso único.
:::

¿Buscas una versión anterior? Consulta la [página de Releases](https://github.com/kh0pper/crow/releases).

### Paso 2: Habilitar orígenes desconocidos

Antes de instalar, permite que tu dispositivo instale aplicaciones de fuera de Play Store:

1. Abre **Ajustes** en tu dispositivo Android
2. Ve a **Seguridad** (o **Privacidad** en algunos dispositivos)
3. Activa **Instalar desde orígenes desconocidos** (o **Instalar aplicaciones desconocidas**)
4. Si te lo pide, permite el navegador que usaste para descargar el APK (Chrome, Firefox, etc.)

::: tip
En Android, este ajuste es por aplicación. Solo necesitas permitirlo para el navegador que usaste para la descarga.
:::

### Paso 3: Instalar

1. Abre el archivo `app-release.apk` descargado
2. Toca **Instalar** cuando se te solicite
3. Una vez instalado, abre la aplicación Crow

### Paso 4: Conectar a tu gateway

1. Introduce la URL de tu gateway (ej., `http://100.121.254.89:3001` o `https://tu-servidor.ts.net`)
2. Toca **Probar conexión** para verificar
3. Inicia sesión con tu contraseña del Crow's Nest

## Opción B: PWA (sin instalación)

Si prefieres no instalar un APK, puedes agregar el Crow's Nest como app de pantalla de inicio directamente desde Chrome:

1. Abre Chrome en tu dispositivo Android
2. Navega a la URL de tu Crow's Nest (ej., `http://100.121.254.89:3001`)
3. Inicia sesión en el Crow's Nest
4. Toca el **menú de tres puntos** (arriba a la derecha)
5. Toca **Agregar a pantalla de inicio**
6. Ponle el nombre "Crow" y toca **Agregar**

La PWA se ejecuta en una ventana independiente sin la interfaz del navegador, dando una apariencia de aplicación nativa.

## Configuración de Tailscale

Si tu gateway de Crow se ejecuta en un servidor casero o red local, instala Tailscale para acceder desde cualquier lugar:

1. Instala [Tailscale desde Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)
2. Abre Tailscale e inicia sesión con la misma cuenta que usas en tu servidor
3. Activa Tailscale
4. Usa la IP de Tailscale de tu servidor como URL del gateway (ej., `http://100.121.254.89:3001`)

::: tip
Tailscale se ejecuta en segundo plano con un impacto mínimo en la batería. Tu conexión a Crow permanece disponible mientras Tailscale esté activo.
:::

## Notificaciones push

La aplicación Crow puede enviar notificaciones push para recordatorios, mensajes de pares y alertas del sistema.

1. Cuando la app se inicie por primera vez, solicitará permiso de notificaciones — toca **Permitir**
2. Si descartaste el aviso, ve a **Ajustes de Android** > **Apps** > **Crow** > **Notificaciones** y actívalas
3. Las preferencias de notificaciones se pueden configurar en **Crow's Nest** > **Ajustes** > **Notificaciones**

## Funcionalidades

Todos los paneles del Crow's Nest están disponibles desde la aplicación Android:

- **Memoria** — Navega y busca tus recuerdos almacenados
- **Mensajes** — Chat con IA y mensajería entre pares
- **Blog** — Lee y gestiona publicaciones
- **Archivos** — Sube, descarga y gestiona archivos almacenados
- **Podcasts** — Suscríbete a feeds y transmite episodios
- **Contactos** — Ve y gestiona tu lista de contactos
- **Skills** — Explora las habilidades disponibles
- **Ajustes** — Acceso completo a la configuración

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

- Verifica que tu gateway esté funcionando (`npm run gateway` o Docker)
- Comprueba que tu dispositivo puede alcanzar la IP del servidor — intenta abrir la URL en Chrome primero
- Si usas Tailscale, asegúrate de que está conectado tanto en el teléfono como en el servidor

### Errores de certificado SSL

- Si tu gateway usa un certificado autofirmado, Chrome y la app pueden bloquear la conexión
- Usa Tailscale Funnel para HTTPS automático, o accede por HTTP plano sobre Tailscale (la VPN cifra el tráfico)

### La app no se instala

- Asegúrate de haber habilitado "Instalar desde orígenes desconocidos" para la app correcta (tu navegador)
- Verifica que tu versión de Android sea 14 o superior (API 34 — requerida por la integración con las gafas Meta)
- Si el almacenamiento está lleno, libera espacio e inténtalo de nuevo

### La PWA no funciona sin conexión

La PWA requiere una conexión de red a tu gateway. No almacena datos en caché para uso sin conexión — se conecta a tu instancia de Crow en tiempo real.
