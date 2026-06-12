---
title: Configuración de Tailscale
---

# Configuración de Tailscale

Accede a tu Crow's Nest y a tu gateway de forma segura desde cualquier lugar, sin exponerlos a internet.

## ¿Qué es esto?

Tailscale crea una red privada (llamada tailnet) entre tus dispositivos. Una vez configurado, tu teléfono, tu laptop y tu servidor Crow pueden comunicarse entre sí como si estuvieran en la misma red local — incluso cuando estás fuera de casa.

## ¿Por qué querría esto?

- **Acceso remoto seguro** — Llega al Crow's Nest desde tu teléfono o laptop en cualquier lugar
- **Sin redirección de puertos** — Funciona a través de NAT y firewalls sin configurar el router
- **Sin exposición pública** — Tu gateway de Crow permanece invisible para internet
- **Configuración fácil** — Instala, inicia sesión, listo

## Paso 1: Crea una Cuenta de Tailscale

Regístrate en [tailscale.com](https://tailscale.com). La capa gratuita admite hasta 100 dispositivos.

## Paso 2: Instala en Tu Servidor Crow

En Ubuntu/Debian:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Sigue la URL de inicio de sesión que aparece en la terminal para autorizar el dispositivo.

Después de iniciar sesión, obtén la IP de Tailscale de tu servidor:

```bash
tailscale ip -4
```

Esto devuelve una IP como `100.x.x.x`. Anótala — la usarás para acceder a Crow de forma remota.

## Paso 3: Instala en Tu Dispositivo

Instala Tailscale en el dispositivo desde el que quieres acceder a Crow:

- **macOS/Windows/Linux**: Descarga desde [tailscale.com/download](https://tailscale.com/download)
- **iOS**: [App Store](https://apps.apple.com/app/tailscale/id1470499037)
- **Android**: [Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)

Inicia sesión con la misma cuenta que usaste en tu servidor.

## Paso 4: Configura MagicDNS (Opcional pero Recomendado)

En lugar de memorizar direcciones IP, define un nombre de host amigable para poder acceder a Crow en `http://crow/` desde cualquier dispositivo de tu tailnet.

```bash
sudo tailscale set --hostname=crow
```

::: tip MagicDNS
MagicDNS está habilitado por defecto en las tailnets nuevas. Si `http://crow/` no resuelve, revisa tu [consola de administración de Tailscale](https://login.tailscale.com/admin/dns) y habilita MagicDNS.
:::

Si `crow` ya está tomado en tu tailnet, usa una alternativa:

```bash
sudo tailscale set --hostname=crow-home
# Luego accede en http://crow-home/
```

## Paso 5: Accede a Crow de Forma Remota

Una vez que ambos dispositivos estén en tu tailnet, accede al Crow's Nest en:

```
http://crow:3001/dashboard
```

O usando la IP de Tailscale:

```
http://100.x.x.x:3001/dashboard
```

Reemplaza `100.x.x.x` con la IP de Tailscale de tu servidor del Paso 2.

## Paso 6: Verifica la Conexión

Desde tu dispositivo, prueba la conexión:

```bash
tailscale ping crow
curl http://crow:3001/health
```

Deberías ver una respuesta de verificación de salud del gateway.

## Hacer Público Tu Blog

Tu blog es público en la URL de tu gateway, pero el Crow's Nest permanece privado. Para hacer que el blog sea accesible fuera de tu tailnet:

### Opción A: Tailscale Funnel (Uso Personal/Aficionado)

::: danger Nunca expongas la ruta raíz con Funnel
`sudo tailscale funnel 3001` (o cualquier comando que mapee `/` al gateway) expone el inicio de sesión del dashboard del Crow's Nest a internet. El gateway bloquea del lado del servidor las solicitudes al dashboard que llegan por Funnel, pero la configuración correcta es exponer por Funnel solo las rutas públicas del blog. Usa siempre `--set-path` como se muestra abajo.
:::

Expón solo las rutas públicas del blog (blog, feeds, descubrimiento OAuth):

```bash
sudo tailscale funnel --bg --set-path=/blog http://localhost:3001/blog
sudo tailscale funnel --bg --set-path=/robots.txt http://localhost:3001/robots.txt
sudo tailscale funnel --bg --set-path=/sitemap.xml http://localhost:3001/sitemap.xml
sudo tailscale funnel --bg --set-path=/.well-known/ http://localhost:3001/.well-known/
```

Verifica que el Crow's Nest **no** sea accesible públicamente:

```bash
curl -I https://<your-tailnet>.ts.net/dashboard   # se espera 404 (sin handler)
curl -I https://<your-tailnet>.ts.net/blog        # se espera 200
```

El gateway también rechaza del lado del servidor cualquier solicitud por Funnel a una ruta privada (Tailscale agrega `Tailscale-Funnel-Request` al tráfico de Funnel, que `isAllowedNetwork()` usa para fallar de forma cerrada). Esto es defensa en profundidad — aun así no debes exponer `/` por Funnel.

Para acceso solo desde la tailnet al gateway completo (dashboard, MCP, chat de IA), usa `tailscale serve` en un puerto separado:

```bash
sudo tailscale serve --bg --https=8444 http://localhost:3001
```

Luego llega al Nest en `https://<your-tailnet>.ts.net:8444/dashboard` desde cualquier dispositivo de tu tailnet.

::: warning Limitaciones de Tailscale Funnel
Tailscale Funnel está diseñado para **uso personal y de aficionados**. Tiene límites de ancho de banda y no está pensado como solución de hosting de producción. Si planeas monetizar tu blog o podcast (anuncios, suscripciones, contenido de pago), usa un proxy inverso apropiado con un dominio propio (Opción B abajo) o considera el [hosting administrado](./managed-hosting).
:::

### Opción B: Proxy Inverso con Caddy (Recomendado para Producción)

Para uso en producción, contenido monetizado o mayor tráfico, usa Caddy con un dominio propio. Caddy proporciona HTTPS automático vía Let's Encrypt sin límites de ancho de banda:

Instala Caddy:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Configura `/etc/caddy/Caddyfile` para exponer solo las rutas del blog:

```
yourdomain.com {
    # Páginas del blog, posts, feeds y sitemap
    handle /blog* {
        reverse_proxy localhost:3001
    }

    # Bloquear todo lo demás (Crow's Nest, MCP, API)
    handle {
        respond "Not Found" 404
    }
}
```

Luego define `CROW_GATEWAY_URL` en tu `.env` para que los feeds RSS, las URLs de podcast y los sitemaps usen el dominio público:

```bash
CROW_GATEWAY_URL=https://yourdomain.com
```

Reinicia ambos servicios:

```bash
sudo systemctl restart crow-gateway
sudo systemctl restart caddy
```

Caddy obtiene y renueva automáticamente los certificados de Let's Encrypt. Asegúrate de que el registro DNS A de tu dominio apunte a la IP pública de tu servidor, y de que los puertos 80 y 443 estén abiertos en tu firewall.

::: tip Capa Gratuita de Oracle Cloud
Si estás ejecutando en Oracle Cloud, también necesitas agregar reglas de ingreso para los puertos TCP 80 y 443 en la security list de tu VCN. Consulta la [sección de Oracle Cloud](/es/getting-started/cloud-deploy) para más detalles.
:::

::: tip Más allá del acceso de un solo dispositivo
Tailscale también habilita el encadenamiento multi-instancia — ejecuta Crow en varias máquinas y sincroniza datos entre ellas a través de tu red privada de Tailscale. Consulta el [Inicio Rápido Multi-Dispositivo](./multi-device).
:::

## Solución de Problemas

### No se puede llegar al servidor

1. Confirma que ambos dispositivos aparezcan como "Connected" en la consola de administración de Tailscale en [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines)
2. Comprueba que el gateway de Crow esté funcionando: `curl http://localhost:3001/health` en el servidor
3. Verifica que la IP de Tailscale no haya cambiado: `tailscale ip -4`
4. Prueba reiniciar Tailscale: `sudo systemctl restart tailscaled`

### La conexión expira

- Tailscale necesita una conexión inicial a un servidor de coordinación. Si tu servidor está detrás de un firewall estricto, puede necesitar acceso de salida a `login.tailscale.com` en el puerto 443.
- Algunas redes corporativas bloquean el tráfico UDP que Tailscale usa para conexiones directas. Tailscale recurrirá a servidores relay (DERP), que pueden ser más lentos pero igual funcionan.

### El Crow's Nest devuelve 403

La verificación de red del Crow's Nest permite automáticamente localhost, los rangos privados RFC 1918 y el rango CGNAT de Tailscale (`100.64.0.0/10`).

Si necesitas permitir direcciones IP o rangos adicionales, define la variable de entorno `CROW_ALLOWED_IPS` en tu archivo `.env`:

```bash
# Una sola IP
CROW_ALLOWED_IPS=203.0.113.50

# Varias IPs y rangos CIDR, separados por comas
CROW_ALLOWED_IPS=203.0.113.50,198.51.100.0/24
```

Como alternativa, define `CROW_DASHBOARD_PUBLIC=true` para desactivar la verificación de red por completo. Usa esto solo si tienes otros controles de acceso implementados (por ejemplo, un proxy inverso con autenticación).

### Tailscale no inicia al arrancar

Habilita el servicio de systemd:

```bash
sudo systemctl enable tailscaled
```
