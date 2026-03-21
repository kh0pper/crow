---
title: Aplicacion Android
---

# Aplicacion Android

Accede a Crow desde tu dispositivo Android con la aplicacion nativa o como una Progressive Web App (PWA).

## Opcion A: Instalar el APK

### Paso 1: Descargar el APK

Descarga la ultima version de Crow para Android:

[Descargar Crow para Android](https://github.com/kh0pper/crow/releases/download/android-v1.0.0/app-debug.apk)

### Paso 2: Habilitar origenes desconocidos

Antes de instalar, permite que tu dispositivo instale aplicaciones de fuera de Play Store:

1. Abre **Ajustes** en tu dispositivo Android
2. Ve a **Seguridad** (o **Privacidad** en algunos dispositivos)
3. Activa **Instalar desde origenes desconocidos** (o **Instalar aplicaciones desconocidas**)
4. Si te lo pide, permite el navegador que usaste para descargar el APK (Chrome, Firefox, etc.)

::: tip
En Android 8+, este ajuste es por aplicacion. Solo necesitas permitirlo para el navegador que usaste para la descarga.
:::

### Paso 3: Instalar

1. Abre el archivo `crow-android.apk` descargado
2. Toca **Instalar** cuando se te solicite
3. Una vez instalado, abre la aplicacion Crow

### Paso 4: Conectar a tu gateway

1. Introduce la URL de tu gateway (ej., `http://100.121.254.89:3001` o `https://tu-servidor.ts.net`)
2. Toca **Probar conexion** para verificar
3. Inicia sesion con tu contrasena del Crow's Nest

## Opcion B: PWA (sin instalacion)

Si prefieres no instalar un APK, puedes agregar el Crow's Nest como app de pantalla de inicio directamente desde Chrome:

1. Abre Chrome en tu dispositivo Android
2. Navega a la URL de tu Crow's Nest (ej., `http://100.121.254.89:3001`)
3. Inicia sesion en el Crow's Nest
4. Toca el **menu de tres puntos** (arriba a la derecha)
5. Toca **Agregar a pantalla de inicio**
6. Ponle el nombre "Crow" y toca **Agregar**

La PWA se ejecuta en una ventana independiente sin la interfaz del navegador, dando una apariencia de aplicacion nativa.

## Configuracion de Tailscale

Si tu gateway de Crow se ejecuta en un servidor casero o red local, instala Tailscale para acceder desde cualquier lugar:

1. Instala [Tailscale desde Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)
2. Abre Tailscale e inicia sesion con la misma cuenta que usas en tu servidor
3. Activa Tailscale
4. Usa la IP de Tailscale de tu servidor como URL del gateway (ej., `http://100.121.254.89:3001`)

::: tip
Tailscale se ejecuta en segundo plano con un impacto minimo en la bateria. Tu conexion a Crow permanece disponible mientras Tailscale este activo.
:::

## Notificaciones push

La aplicacion Crow puede enviar notificaciones push para recordatorios, mensajes de pares y alertas del sistema.

1. Cuando la app se inicie por primera vez, solicitara permiso de notificaciones — toca **Permitir**
2. Si descartaste el aviso, ve a **Ajustes de Android** > **Apps** > **Crow** > **Notificaciones** y activalas
3. Las preferencias de notificaciones se pueden configurar en **Crow's Nest** > **Ajustes** > **Notificaciones**

## Funcionalidades

Todos los paneles del Crow's Nest estan disponibles desde la aplicacion Android:

- **Memoria** — Navega y busca tus recuerdos almacenados
- **Mensajes** — Chat con IA y mensajeria entre pares
- **Blog** — Lee y gestiona publicaciones
- **Archivos** — Sube, descarga y gestiona archivos almacenados
- **Podcasts** — Suscribete a feeds y transmite episodios
- **Contactos** — Ve y gestiona tu lista de contactos
- **Skills** — Explora las habilidades disponibles
- **Ajustes** — Acceso completo a la configuracion

## Solucion de problemas

### "Conexion rechazada" o tiempo de espera agotado

- Verifica que tu gateway este funcionando (`npm run gateway` o Docker)
- Comprueba que tu dispositivo puede alcanzar la IP del servidor — intenta abrir la URL en Chrome primero
- Si usas Tailscale, asegurate de que esta conectado tanto en el telefono como en el servidor

### Errores de certificado SSL

- Si tu gateway usa un certificado autofirmado, Chrome y la app pueden bloquear la conexion
- Usa Tailscale Funnel para HTTPS automatico, o accede por HTTP plano sobre Tailscale (la VPN cifra el trafico)

### La app no se instala

- Asegurate de haber habilitado "Instalar desde origenes desconocidos" para la app correcta (tu navegador)
- Verifica que tu version de Android sea 8.0 o superior
- Si el almacenamiento esta lleno, libera espacio e intentalo de nuevo

### La PWA no funciona sin conexion

La PWA requiere una conexion de red a tu gateway. No almacena datos en cache para uso sin conexion — se conecta a tu instancia de Crow en tiempo real.
