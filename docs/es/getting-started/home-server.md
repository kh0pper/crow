# Servidor en Casa

Ejecuta Crow en una Raspberry Pi, laptop vieja, NUC o cualquier máquina Linux siempre encendida. Tus datos se quedan en tu propio hardware y tu servidor nunca se apaga.

## ¿Qué Cuenta Como Servidor en Casa?

Cualquier máquina que:
- Ejecute Linux (Debian, Ubuntu o Raspberry Pi OS)
- Se mantenga encendida
- Tenga al menos 1 GB de RAM y 8 GB de almacenamiento
- Esté conectada a tu red doméstica

Opciones comunes:

| Hardware | RAM | Ideal Para |
|---|---|---|
| Raspberry Pi 4 (4 GB) | 4 GB | Crow básico + complementos ligeros |
| Raspberry Pi 5 (8 GB) | 8 GB | Plataforma completa + Ollama con modelos pequeños |
| Laptop o escritorio viejo | 4-32 GB | Todo, incluyendo complementos pesados |
| Intel NUC o mini PC | 8-16 GB | Compacto, silencioso, eficiente |

## Instalación Rápida

Un solo comando instala Crow y todas las dependencias:

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

::: tip ¿Prefieres inspeccionar el script primero?
```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh -o crow-install.sh
less crow-install.sh   # Revisar el script
bash crow-install.sh   # Ejecutarlo
```
:::

El instalador tarda 5-10 minutos y configura:
- Node.js 20, Docker, Caddy, Avahi (mDNS)
- Plataforma Crow con base de datos SQLite local
- Identidad criptográfica (Crow ID)
- Servicio systemd para inicio automático
- HTTPS con certificado autofirmado
- Firewall (UFW) + fail2ban

## Acceso Remoto con Tailscale

Accede a tu Crow desde cualquier lugar con [Tailscale](https://tailscale.com) (gratuito para uso personal):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Configura un nombre memorable en tu [consola de administración de Tailscale](https://login.tailscale.com/admin/machines) — renombra la máquina a `crow`. Con MagicDNS activado, tu servidor es accesible en `http://crow:3001` desde cualquier dispositivo en tu red Tailscale.

## Conectar Tu Plataforma de IA

Una vez que Crow esté funcionando, conéctalo desde cualquier plataforma de IA:

- [Claude Web y Móvil](../../platforms/claude)
- [ChatGPT](../../platforms/chatgpt)
- [Claude Code](../../platforms/claude-code)
- [Todas las plataformas](../../platforms/)

Visita `https://crow.local/setup` (red local) o `http://crow:3001/setup` (Tailscale) para ver el estado de las integraciones.

## Gestionar Tu Crow

```bash
# Estado de la plataforma
crow status

# Ver registros del gateway
sudo journalctl -u crow-gateway -f

# Reiniciar gateway
sudo systemctl restart crow-gateway

# Instalar complementos
crow bundle install ollama
crow bundle start ollama

# Actualizar Crow
bash ~/.crow/app/scripts/crow-update.sh
```

## Usuarios de Raspberry Pi

Para detalles específicos de Pi — formatear tarjetas SD, configuración de mDNS, recomendaciones de hardware y el asistente de configuración — consulta la [Guía de Raspberry Pi](../../getting-started/raspberry-pi).
