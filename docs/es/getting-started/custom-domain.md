---
title: Configuración de Dominio Personalizado
description: Apunta tu propio dominio a tu servidor Crow con registros DNS A y HTTPS automático vía Caddy.
---

# Configuración de Dominio Personalizado

Si quieres una URL profesional para tu blog o gateway de Crow (p. ej., `blog.yourdomain.com` en lugar de `crow.your-tailnet.ts.net`), necesitas apuntar un registro DNS a la dirección IP pública de tu servidor. Esta guía cubre la configuración de DNS para los proveedores más comunes y cómo Caddy maneja HTTPS automáticamente.

## Requisitos Previos

- Un servidor Crow en funcionamiento con una **dirección IP pública** (consulta [Oracle Cloud Free Tier](./oracle-cloud) u otro proveedor de nube)
- Un nombre de dominio de tu propiedad
- El puerto 443 abierto en el firewall de tu servidor (cubierto en el paso de endurecimiento de seguridad de la guía de Oracle Cloud)

## ¿Qué Es un Registro A?

Un registro A asocia un nombre de dominio (como `blog.yourdomain.com`) con una dirección IPv4. Cuando alguien visita tu dominio, su navegador usa este registro para encontrar tu servidor. Necesitas un registro A que apunte el dominio o subdominio que elijas a la IP pública de tu servidor Crow.

## Paso 1: Encuentra la IP Pública de Tu Servidor

```bash
# En tu servidor
curl -4 ifconfig.me
```

Anota esta dirección IP — la ingresarás en el panel de tu proveedor de DNS.

## Paso 2: Crea el Registro DNS

Elige tu proveedor de DNS a continuación y sigue las instrucciones. En todos los casos, estás creando un registro A que apunta tu dominio o subdominio a la IP de tu servidor.

### Cloudflare

1. Inicia sesión en el [panel de Cloudflare](https://dash.cloudflare.com)
2. Selecciona tu dominio
3. Ve a **DNS** en la barra lateral izquierda
4. Haz clic en **Add Record**
5. Configura los campos:
   - **Type:** `A`
   - **Name:** tu subdominio (p. ej., `blog`) o `@` para el dominio raíz
   - **IPv4 address:** la IP pública de tu servidor
   - **Proxy status:** cámbialo a **DNS only** (nube gris). Caddy necesita una conexión directa para aprovisionar certificados. Puedes activar el proxy de nube naranja más adelante si lo deseas, pero empieza con DNS only.
   - **TTL:** Auto
6. Haz clic en **Save**

### Namecheap

1. Inicia sesión en [Namecheap](https://www.namecheap.com) y ve a **Domain List**
2. Haz clic en **Manage** junto a tu dominio
3. Ve a la pestaña **Advanced DNS**
4. Haz clic en **Add New Record**
5. Configura los campos:
   - **Type:** `A Record`
   - **Host:** tu subdominio (p. ej., `blog`) o `@` para el dominio raíz
   - **Value:** la IP pública de tu servidor
   - **TTL:** Automatic
6. Haz clic en la marca de verificación para guardar

### GoDaddy

1. Inicia sesión en [GoDaddy](https://www.godaddy.com) y ve a **My Products**
2. Encuentra tu dominio y haz clic en **DNS** (o **Manage DNS**)
3. Haz clic en **Add** en la sección de registros
4. Configura los campos:
   - **Type:** `A`
   - **Name:** tu subdominio (p. ej., `blog`) o `@` para el dominio raíz
   - **Value:** la IP pública de tu servidor
   - **TTL:** 600 segundos (o el mínimo disponible)
5. Haz clic en **Save**

### DigitalOcean

1. Inicia sesión en el [panel de control de DigitalOcean](https://cloud.digitalocean.com)
2. Ve a **Networking** en la barra lateral izquierda
3. Si tu dominio no aparece en la lista, ingrésalo bajo "Add a Domain" y haz clic en **Add Domain**
4. En los registros DNS del dominio, haz clic en **Create new record**
5. Configura los campos:
   - **Type:** `A` (seleccionado por defecto)
   - **Hostname:** tu subdominio (p. ej., `blog`) o `@` para el dominio raíz
   - **Will Direct To:** la IP pública de tu servidor
   - **TTL:** 3600 (por defecto)
6. Haz clic en **Create Record**

::: tip Otros proveedores
El proceso es el mismo en todas partes: encuentra la página de gestión de DNS, agrega un registro A, ingresa tu subdominio y la IP del servidor. Si tu proveedor no aparece aquí, busca "add A record" en su documentación de ayuda.
:::

## Paso 3: Instala y Configura Caddy

La configuración Docker de Crow usa [Caddy](https://caddyserver.com) como proxy inverso. Caddy aprovisiona y renueva automáticamente certificados TLS de Let's Encrypt cuando el DNS apunta a tu servidor — no se requiere gestión manual de certificados.

Si seguiste la [guía de Oracle Cloud](./oracle-cloud), puede que ya tengas Caddy instalado. Si no:

```bash
# Instalar Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Configura el proxy inverso:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
blog.yourdomain.com {
    reverse_proxy localhost:3001
}
EOF

sudo systemctl restart caddy
```

Reemplaza `blog.yourdomain.com` con tu dominio real. Caddy detectará el dominio, contactará a Let's Encrypt y aprovisionará un certificado automáticamente. Esto normalmente toma menos de un minuto.

## Paso 4: Configura la URL Pública

Dile a Crow su dirección pública para que genere enlaces correctos en los feeds del blog, las URLs de compartición y el Crow's Nest:

```bash
# Si usas la estructura del instalador
echo 'CROW_GATEWAY_URL=https://blog.yourdomain.com' >> ~/.crow/app/.env
sudo systemctl restart crow-gateway

# Si usas Docker
# Agrega CROW_GATEWAY_URL=https://blog.yourdomain.com a tu archivo .env
# luego: docker compose --profile cloud up --build -d
```

## Paso 5: Verifica

Abre `https://blog.yourdomain.com/health` en tu navegador. Deberías ver una respuesta JSON confirmando que el gateway está funcionando, servida sobre HTTPS con un certificado válido.

## Solución de Problemas

### Retraso en la propagación de DNS

Después de crear o cambiar un registro DNS, puede tardar hasta 48 horas en propagarse mundialmente, aunque la mayoría de los cambios surten efecto en menos de 30 minutos. Puedes verificar el estado de la propagación con:

```bash
# Verificar si el DNS se actualizó
dig +short blog.yourdomain.com

# O usa una herramienta en línea como https://dnschecker.org
```

Si el comando devuelve la IP de tu servidor, la propagación está completa.

### HTTPS no funciona

Si ves errores de certificado o Caddy no logra aprovisionar un certificado:

1. Confirma que el DNS apunta a la IP correcta: `dig +short blog.yourdomain.com`
2. Confirma que el puerto 443 está abierto en tu servidor y en cualquier firewall de nube (Oracle Security Lists, AWS Security Groups, etc.)
3. Revisa los registros de Caddy en busca de errores específicos:

```bash
sudo journalctl -u caddy --no-pager -n 50
```

Causas comunes:
- **DNS aún no propagado** — espera y reintenta. Caddy reintenta automáticamente.
- **Puerto 443 bloqueado** — Let's Encrypt necesita alcanzar el puerto 443 para el desafío HTTP. Revisa tanto el firewall de tu sistema operativo (`sudo ufw status`) como las reglas de firewall de tu proveedor de nube.
- **Proxy de Cloudflare activado** — si usas Cloudflare con la nube naranja (proxy) activada, Caddy no puede completar el desafío ACME. Cambia a DNS only (nube gris) para la configuración inicial.

### Dirección IP incorrecta

Si tu dominio carga el sitio de otra persona o la conexión expira:

1. Verifica la IP pública actual de tu servidor: `curl -4 ifconfig.me`
2. Compárala con lo que devuelve el DNS: `dig +short blog.yourdomain.com`
3. Si no coinciden, actualiza el registro A en tu proveedor de DNS y espera la propagación

Los proveedores de nube a veces cambian tu IP pública si detienes y reinicias una instancia. Si esto sucede, actualiza tu registro A con la nueva IP. Considera reservar una IP estática (llamada "Reserved Public IP" en Oracle Cloud, "Elastic IP" en AWS) para evitarlo.

## Guías Relacionadas

- [Oracle Cloud Free Tier](./oracle-cloud) — servidor gratuito recomendado para alojar Crow
- [Acceso Remoto con Tailscale](./tailscale-setup) — acceso privado sin un dominio público
- [Docker](./docker) — despliegue basado en contenedores con soporte integrado de Caddy
