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

# Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# Verificar
node --version   # Debería ser 20.x
npm --version
```

## Paso 5: Instalar Crow

Puedes usar el instalador de un comando o instalar manualmente.

**Opción A: Instalador de un comando**

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

**Opción B: Instalación manual**

```bash
git clone https://github.com/kh0pper/crow.git ~/.crow/app
cd ~/.crow/app
npm run setup
```

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

Tu servidor ahora es accesible en `http://crow:3001` desde cualquier dispositivo en tu red Tailscale.

## Paso 8: Crear un Servicio systemd

Ejecuta el gateway de Crow como un servicio en segundo plano que inicia automáticamente al arrancar:

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
Restart=unless-stopped
RestartSec=5
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

- [Claude Web y Móvil](../../platforms/claude) — `http://crow:3001/memory/mcp`
- [ChatGPT](../../platforms/chatgpt) — `http://crow:3001/memory/sse`
- [Gemini](../../platforms/gemini) — `http://crow:3001/memory/mcp`
- [Claude Code](../../platforms/claude-code) — `http://crow:3001/memory/mcp`
- [Todas las plataformas](../../platforms/)

Visita `http://crow:3001/setup` desde un dispositivo en tu red Tailscale para ver el estado de las integraciones.

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

tailscale funnel --bg --https=443 http://localhost:3001
```

Tu blog estará en `https://crow.tu-tailnet.ts.net/blog`.

### Opción B: Caddy + Dominio personalizado

Para una URL profesional como `blog.tudominio.com`:

```bash
# Instalar Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Configurar proxy reverso
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
blog.tudominio.com {
    reverse_proxy localhost:3001
}
EOF

sudo systemctl restart caddy
```

Apunta el registro DNS A de tu dominio a la IP pública de tu instancia de Oracle. Caddy obtiene automáticamente certificados Let's Encrypt.
