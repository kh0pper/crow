# Configuración de Raspberry Pi (Crow OS)

Convierte una Raspberry Pi en un dispositivo dedicado a Crow. No se requiere SSH después de la configuración inicial — todo se configura desde un navegador web.

## Requisitos de Hardware

| | Mínimo | Recomendado |
|---|---|---|
| **Placa** | Raspberry Pi 4 (4 GB) | Raspberry Pi 5 (8 GB) |
| **Almacenamiento** | microSD de 32 GB | SSD NVMe vía HAT |
| **Red** | Ethernet o Wi-Fi | Ethernet |
| **Alimentación** | Fuente oficial | Fuente oficial |

**Uso de recursos:** el gateway ~100 MB de RAM, SQLite insignificante, Docker ~200 MB base. Cada complemento varía (Ollama necesita 2-4 GB para los modelos, Nextcloud ~500 MB).

## Paso 1: Flashear Raspberry Pi OS

1. Descarga [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Selecciona **Raspberry Pi OS Lite (64-bit)** — el entorno de escritorio no es necesario
3. Haz clic en el ícono de engranaje para preconfigurar:
   - **Habilita SSH** con autenticación por contraseña
   - **Define usuario y contraseña** (p. ej., `crow` / tu-contraseña)
   - **Configura Wi-Fi** si no vas a usar Ethernet
   - **Define el hostname** como `crow`
4. Flashea tu tarjeta SD o SSD

## Paso 2: Primer Arranque y Conexión

1. Inserta la tarjeta SD, conecta Ethernet (si lo usas) y enciende
2. Espera ~2 minutos para el primer arranque
3. Encuentra tu Pi en la red:
   ```bash
   # Desde otra computadora en la misma red
   ping crow.local
   # O revisa la lista de clientes DHCP de tu router
   ```
4. Conéctate por SSH:
   ```bash
   ssh crow@crow.local
   ```

## Paso 3: Ejecutar el Instalador

Un solo comando instala todo:

```bash
curl -sSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

::: tip ¿Prefieres inspeccionar el script primero?
```bash
curl -sSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh -o crow-install.sh
less crow-install.sh   # Revisar el script
bash crow-install.sh   # Ejecutarlo
```
:::

El instalador tarda 5-10 minutos y configura:
- Node.js 20, Docker, Caddy, Avahi (mDNS)
- Plataforma Crow con base de datos SQLite
- Identidad criptográfica (Crow ID)
- Servicio systemd para inicio automático
- HTTPS con certificado autofirmado
- Firewall (UFW) + fail2ban

## Paso 4: Abrir el Asistente de Configuración

Desde cualquier dispositivo en tu red, abre:

```
https://crow.local/setup
```

::: warning Advertencia del Navegador
Verás una advertencia de certificado porque los navegadores no confían en el certificado autofirmado. Esto es normal para el acceso en red local. Haz clic en "Avanzado" → "Continuar" para seguir. Para certificados válidos, configura [Tailscale](#opcional-acceso-remoto-con-tailscale) o agrega un dominio.
:::

El asistente de configuración te guía por:
1. **Definir la contraseña del Crow's Nest** — requerida antes de acceder al Crow's Nest
2. **Ver tu Crow ID** — tu identidad criptográfica para compartir P2P
3. **Configurar integraciones** — agrega claves de API para GitHub, Gmail, etc.

::: tip ¿Quieres que tu blog sea accesible desde internet?
Tu blog está disponible en tu red local en `https://crow.local/blog`. Para hacerlo accesible públicamente, consulta [Cómo Hacer Público Tu Blog](#como-hacer-publico-tu-blog) en la sección de Tailscale más abajo.
:::

## Paso 5: Conectar Tu Plataforma de IA

Tu instancia de Crow ya está funcionando. Conéctala desde cualquier plataforma de IA:

**Claude Web/Móvil:** Configuración → Integraciones → Agregar personalizada → `https://crow.local/memory/mcp`

**ChatGPT:** Configuración → Apps → Crear → `https://crow.local/memory/sse`

**Claude Code:** Agrega a `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "crow-memory": {
      "url": "https://crow.local/memory/mcp"
    }
  }
}
```

Consulta la [guía de Plataformas](/es/platforms/) para todos los clientes de IA compatibles.

## Gestionar Tu Crow

### Comandos Útiles

```bash
# Estado de la plataforma
crow status

# Ver registros del gateway
sudo journalctl -u crow-gateway -f

# Reiniciar gateway
sudo systemctl restart crow-gateway

# Instalar un complemento
crow bundle install ollama
crow bundle start ollama

# Actualizar Crow
bash ~/.crow/app/scripts/crow-update.sh
```

### Crow's Nest

Accede al Crow's Nest en `https://crow.local/dashboard` — gestiona mensajes, publicaciones del blog, archivos y configuración desde tu navegador.

### Instalar Complementos

Instala servicios autoalojados como complementos:

```bash
crow bundle install ollama      # Modelos de IA locales
crow bundle install nextcloud   # Sincronización de archivos
crow bundle install immich      # Biblioteca de fotos
```

O pídele a tu IA: "Instala el complemento de Ollama."

## Opcional: Acceso Remoto con Tailscale

Accede a tu Crow desde cualquier lugar con [Tailscale](https://tailscale.com) (gratuito para uso personal):

```bash
# Instalar Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Obtener tu hostname de Tailscale
tailscale status
```

Luego actualiza Caddy para obtener certificados HTTPS válidos automáticamente:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
crow.your-tailnet.ts.net {
    reverse_proxy localhost:3001
}
EOF
sudo systemctl restart caddy
```

Consulta la [Guía de Configuración de Tailscale](/es/getting-started/tailscale-setup) para instrucciones detalladas.

::: tip Encadena con una instancia en la nube
Tu Pi puede sincronizarse con una instancia en la nube siempre gratuita para tener redundancia. Si la Pi se desconecta, tus datos siguen accesibles desde la nube. Configura [Oracle Cloud](./oracle-cloud) o [Google Cloud](./google-cloud), y luego [encadénalas](./multi-device) — las memorias se sincronizan automáticamente cuando la Pi vuelve a estar en línea.
:::

### Cómo Hacer Público Tu Blog

Una vez instalado Tailscale, puedes usar [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) para hacer tu blog accesible desde el internet público — sin port forwarding ni registro de dominio.

```bash
# Primero habilita Funnel en tu consola de administración de Tailscale:
# https://login.tailscale.com/admin/dns → Enable Funnel

# Exponer tu gateway públicamente
tailscale funnel --bg --https=443 http://localhost:3001
```

Tu blog ahora está en `https://<hostname>.your-tailnet.ts.net/blog`. El Crow's Nest permanece privado — las IPs públicas reciben una respuesta 403, así que en la práctica solo el blog es visible.

Para definir la URL pública y que los enlaces de RSS/vista previa social sean correctos:

```bash
# Agrega a tu .env
CROW_GATEWAY_URL=https://<hostname>.your-tailnet.ts.net
```

## Opcional: Dominio Personalizado

Si tienes un dominio, apúntalo a la IP de tu Pi y actualiza el Caddyfile:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
crow.yourdomain.com {
    reverse_proxy localhost:3001
}
EOF
sudo systemctl restart caddy
```

Caddy aprovisiona certificados de Let's Encrypt automáticamente.

## Solución de Problemas

### No se encuentra crow.local

- Asegúrate de que Avahi esté corriendo: `sudo systemctl status avahi-daemon`
- mDNS puede no funcionar entre VLANs — usa la dirección IP directamente
- En Windows, instala [Bonjour Print Services](https://support.apple.com/kb/DL999) para tener soporte de mDNS

### El gateway no arranca

```bash
sudo systemctl status crow-gateway
sudo journalctl -u crow-gateway --no-pager -n 50
```

### Sin espacio en disco

```bash
# Revisar uso de disco
df -h

# Limpiar imágenes de Docker
docker system prune -a

# Revisar el tamaño de los datos de Crow
du -sh ~/.crow/data/
```

### Rendimiento

- Usa un SSD NVMe en lugar de microSD para un rendimiento de I/O dramáticamente mejor
- La Pi 5 es ~2-3x más rápida que la Pi 4 para cargas de trabajo de Node.js
- Si ejecutas Ollama, usa los modelos más pequeños (llama3.2:1b, phi3:mini) — los modelos más grandes serán muy lentos en ARM
