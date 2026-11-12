# Oracle Cloud Nivel Gratuito (Recomendado)

El nivel Always Free de Oracle Cloud te da un servidor permanente que nunca se apaga, nunca caduca y no cuesta nada. A diferencia de otras opciones de hosting gratuito, tus datos se quedan en disco local (no necesitas base de datos externa) y tu servidor responde al instante — sin arranques en frío.

::: tip ¿Por qué Oracle Cloud?
- **Genuinamente gratuito** — la tarjeta de crédito es solo para verificación de identidad. No se te cobrará.
- **Nunca se apaga** — tu servidor está siempre encendido, siempre responde
- **SQLite local** — no necesitas servicio de base de datos externa
- **47 GB de disco** — más que suficiente para Crow y todos tus datos
- **10 TB/mes de ancho de banda** — más que la mayoría de planes pagados
:::

## Paso 1: Crear una Cuenta de Oracle Cloud

1. Ve a [cloud.oracle.com](https://cloud.oracle.com) y haz clic en **Sign Up**
2. Ingresa tu correo electrónico y crea una contraseña
3. Necesitarás una tarjeta de crédito para verificación — Oracle la usa para confirmar que eres una persona real. El nivel Always Free es genuinamente gratuito y no se te cobrará.
4. Selecciona tu **región principal** — elige la más cercana a ti para menor latencia. Esto no se puede cambiar después.
5. Espera a que tu cuenta sea aprovisionada (generalmente unos minutos)

## Paso 2: Lanzar una Instancia Always Free

1. Inicia sesión en la [Consola de Oracle Cloud](https://cloud.oracle.com)
2. Ve a **Compute → Instances → Create Instance**
3. Dale un nombre a tu instancia (por ejemplo, `crow`)
4. **Imagen:** Selecciona **Ubuntu 22.04 Minimal** (en "Change image" → Platform images)
5. **Shape:** Haz clic en **Change shape** → **Specialty and previous generation** → Selecciona **VM.Standard.E2.1.Micro** (1 OCPU, 1 GB RAM)
   - Busca la insignia "Always Free Eligible" — esto confirma que no se te cobrará
6. **Red:** El VCN y subnet público predeterminados están bien. Asegúrate de que "Assign a public IPv4 address" esté marcado.
7. **Clave SSH:** Haz clic en "Generate a key pair" y descarga ambas claves, o sube tu clave pública si ya tienes una
8. Haz clic en **Create**

La instancia tarda 1-2 minutos en aprovisionarse. Una vez que el estado muestre "Running", anota la **dirección IP pública** en la página de detalles de la instancia.

## Paso 3: Conectar por SSH

```bash
# Si descargaste la clave generada por Oracle
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<tu-ip-publica>

# Si subiste tu propia clave
ssh ubuntu@<tu-ip-publica>
```

## Paso 4: Instalar Node.js

```bash
# Actualizar paquetes del sistema
sudo apt update && sudo apt upgrade -y

# Instalar Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git

# Verificar
node --version   # Debería ser 20.x
npm --version
```

## Paso 5: Instalar Crow

Puedes usar el instalador de un comando o instalar manualmente.

**Opción A: Instalador de un comando (Recomendado)**

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/v1.1.0/scripts/crow-install.sh | bash
```

**Opción B: Instalación manual**

```bash
git clone https://github.com/kh0pper/crow.git ~/.crow/app
cd ~/.crow/app
npm run setup
```

::: warning La Opción B deja cosas fuera
La Opción B no configura el socket de proxy que usa Caddy, ni el sandbox de bubblewrap para los bots, ni las actualizaciones automáticas de Node, Docker y Caddy, ni el guardia de arranque que revierte una actualización mala, ni el firewall que sube primero, ni el socket de administración de Caddy. La Opción B es para quien sabe que quiere eso.
:::

No necesitas base de datos externa — Crow usa SQLite local en el volumen de disco de Oracle automáticamente.

## Paso 6: Seguridad

Tu servidor está en el internet público. Estos pasos lo protegen de ataques comunes.

### Oracle Security Lists (firewall en la nube)

Oracle tiene su propio firewall que controla qué tráfico puede llegar a tu instancia. Por defecto, solo SSH (puerto 22) está abierto.

1. En la Consola de Oracle Cloud, ve a **Networking → Virtual Cloud Networks**
2. Haz clic en tu VCN → haz clic en tu **Subnet** → haz clic en la **Security List**
3. Haz clic en **Add Ingress Rules** y agrega:

| Source CIDR | Protocolo | Puerto Dest | Descripción |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `443` | HTTPS |

### UFW (firewall en la instancia)

::: tip
Sáltate esto si usaste el instalador (Paso 5, Opción A): ya configuró el firewall. Abre el 22, y el 443 solo si respondes que sí a su pregunta. En Oracle la respuesta por defecto es no.
:::

Defensa en profundidad — un segundo firewall en la instancia misma.

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 443/tcp    # HTTPS (para blog público)
sudo ufw allow 41641/udp  # Tailscale (WireGuard)
sudo ufw enable
```

### fail2ban (bloquea intentos de fuerza bruta)

::: tip
Sáltate esto si usaste el instalador (Paso 5, Opción A): ya lo hizo.
:::

fail2ban observa tus registros de inicio de sesión y bloquea temporalmente las direcciones IP que fallan demasiados intentos. Esto detiene los ataques automatizados de adivinación de contraseñas.

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

### Desactivar autenticación por contraseña en SSH

Las claves SSH son mucho más seguras que las contraseñas:

```bash
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

::: warning
Solo haz esto después de confirmar que tu inicio de sesión con clave SSH funciona. Si desactivas las contraseñas y pierdes tu clave, quedarás bloqueado.
:::

### Actualizaciones de seguridad automáticas

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Selecciona "Yes" cuando se te pregunte.

## Paso 7: Instalar Tailscale

[Tailscale](https://tailscale.com) crea una red privada entre tus dispositivos usando encriptación WireGuard. Tu servidor Crow se vuelve accesible desde tu teléfono, laptop o cualquier dispositivo en tu red Tailscale — sin abrir puertos al internet público.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Sigue el enlace que aparece en tu terminal para autorizar el dispositivo en tu consola de administración de Tailscale.

**Configura un nombre memorable:**

1. Ve a tu [consola de administración de Tailscale](https://login.tailscale.com/admin/machines)
2. Haz clic en tu instancia de Oracle → Edit → Renombra a `crow`
3. Activa **MagicDNS** si aún no está activado (en configuración de DNS)

Luego pon el gateway detrás de Tailscale Serve, que le da un certificado HTTPS real en tu tailnet. Las reglas de firewall de arriba no abren el `3001` a internet, y la unidad systemd de abajo se ejecuta con `NODE_ENV=production`, así que su cookie de sesión `Secure` necesita el puerto HTTPS de Serve:

```bash
sudo tailscale serve --bg --https=8444 http://localhost:3001
```

Tu servidor ahora es accesible en `https://crow.tu-tailnet.ts.net:8444` desde cualquier dispositivo en tu red Tailscale (tu nombre de host y el de tu tailnet son los que muestra `tailscale status`). Usa URLs `http://` solo en la propia máquina.

## Paso 8: Crear un Servicio systemd

::: warning
Sáltate este paso si usaste el instalador (Paso 5, Opción A). El instalador ya escribió este servicio, con el socket de proxy y el guardia de arranque. Ejecutar el bloque de abajo lo sobrescribiría.
:::

La unidad de abajo es la versión manual simple, para la instalación manual (Paso 5, Opción B). Ejecuta el gateway de Crow como un servicio en segundo plano que inicia automáticamente al arrancar:

```bash
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << 'EOF'
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/.crow/app
ExecStart=/usr/bin/node servers/gateway/index.js
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now crow-gateway
```

Verifica que esté funcionando:

```bash
sudo systemctl status crow-gateway
curl http://localhost:3001/health
```

## Paso 9: Conectar Tu Plataforma de IA

Tu servidor Crow ahora está funcionando y accesible vía Tailscale. Conéctalo desde cualquier plataforma de IA:

- [Claude Web y Móvil](/es/platforms/claude) — `https://crow.tu-tailnet.ts.net:8444/memory/mcp`
- [ChatGPT](/es/platforms/chatgpt) — `https://crow.tu-tailnet.ts.net:8444/memory/sse`
- [Gemini](/es/platforms/gemini) — `https://crow.tu-tailnet.ts.net:8444/memory/mcp`
- [Claude Code](/es/platforms/claude-code) — `https://crow.tu-tailnet.ts.net:8444/memory/mcp`
- [Todas las plataformas](/es/platforms/)

Visita `https://crow.tu-tailnet.ts.net:8444/setup` desde un dispositivo en tu red Tailscale para ver el estado de las integraciones (el paso de `tailscale serve` del Paso 7 es lo que hace funcionar esa dirección HTTPS).

::: tip Pruébalo
Después de conectar tu plataforma de IA, di:

> "Recuerda que hoy es mi primer día usando Crow"
> "¿Qué recuerdas?"
:::

## Opcional: Hacer Tu Blog Público

Por defecto, todo es privado detrás de Tailscale. Si quieres que tu blog sea accesible desde el internet público:

### Opción A: Tailscale Funnel (sin dominio necesario)

```bash
# Primero activa Funnel en tu consola de administración de Tailscale:
# https://login.tailscale.com/admin/dns → Enable Funnel

# Exponer solo las rutas públicas del blog
tailscale funnel --bg --set-path=/blog http://localhost:3001/blog
tailscale funnel --bg --set-path=/robots.txt http://localhost:3001/robots.txt
tailscale funnel --bg --set-path=/sitemap.xml http://localhost:3001/sitemap.xml
tailscale funnel --bg --set-path=/.well-known/ http://localhost:3001/.well-known/
```

Funnel publica a todo el internet, así que solo estas rutas del blog van en él — mapear `/` expondría el inicio de sesión del dashboard del Crow's Nest. El dashboard se queda en `tailscale serve` (solo tailnet, Paso 7): Serve y Funnel comparten el puerto `443` en el mismo host, así que deja el dashboard en el `8444` de Serve y que Funnel se quede con el `443`.

Tu blog estará en `https://crow.tu-tailnet.ts.net/blog`. El Crow's Nest permanece privado — una solicitud que llegue por Funnel a cualquier otra ruta recibe un 403.

### Opción B: Caddy + Dominio personalizado

Para una URL profesional como `blog.tudominio.com`.

**Si usaste el instalador** (Paso 5, Opción A), Caddy y su Caddyfile ya existen. No reemplaces el archivo. Ejecuta `sudo nano /etc/caddy/Caddyfile`. Cambia solo el nombre del sitio, que es la primera línea del bloque (el nombre `.local` de la máquina), por tu dominio (por ejemplo `blog.tudominio.com`). Quita la línea `tls internal` de ese bloque, para que Caddy obtenga un certificado de Let's Encrypt para tu dominio. Deja la línea `reverse_proxy unix//run/crow-proxy/gateway.sock` y el bloque global `admin`. Luego recarga Caddy:

```bash
sudo systemctl reload caddy
```

En Oracle, el instalador pudo dejar cerrado el puerto 443. Si es así, ábrelo con `sudo ufw allow 443/tcp`. El puerto 80 es opcional: solo hace falta para la redirección de HTTP a HTTPS.

**Si usaste la instalación manual** (Paso 5, Opción B), instala Caddy primero (el 443 ya está abierto desde el Paso 6):

```bash
# Instalar Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Luego escribe el Caddyfile con el mismo bloque de sitio, apuntando a `localhost:3001`:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
blog.tudominio.com {
    reverse_proxy localhost:3001
}
EOF

sudo systemctl restart caddy
```

Apunta el registro DNS A de tu dominio a la IP pública de tu instancia de Oracle. Caddy obtiene automáticamente certificados Let's Encrypt. Para los detalles del DNS, consulta [Dominio Personalizado](./custom-domain).

::: warning Caddy en localhost:3001 no pasa
Un Caddy que apunta a `localhost:3001` llega al gateway como una conexión de loopback no verificada, y el Crow's Nest la rechaza. El DNS de tu dominio ya debe apuntar a este servidor, porque el script revisa `/health` a través del dominio. Cuando Caddy esté funcionando, ejecuta `sudo bash scripts/fix-caddy-proxy-socket.sh` en `~/.crow/app`. Eso lo cambia al socket de proxy.
:::

Define la URL pública en tu `.env`:

```bash
echo 'CROW_GATEWAY_URL=https://blog.tudominio.com' >> ~/.crow/app/.env
sudo systemctl restart crow-gateway
```
