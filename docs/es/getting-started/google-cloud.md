---
title: Google Cloud Nivel Gratuito
description: Configura Crow en la VM e2-micro siempre gratuita de Google Cloud con Tailscale y encadénala con tus otras instancias.
---

# Google Cloud Nivel Gratuito

La VM e2-micro siempre gratuita de Google Cloud te da un servidor permanente con 1 GB de RAM y 30 GB de disco — suficiente para el Crow base. Encadénala con una instancia de Oracle Cloud para un Crow redundante y multi-nube.

::: tip ¿Por qué Google Cloud como secundario?
- **Siempre gratuito** — la e2-micro nunca expira, sin cargos sorpresa
- **1 GB de RAM, 30 GB de disco** — ejecuta el Crow base cómodamente
- **Se encadena con Oracle Cloud** — dos nubes gratuitas, sincronizadas automáticamente
- **Regiones de EE. UU.** — us-west1, us-central1 o us-east1 (restricción del nivel gratuito)
:::

## Paso 1: Crea una Cuenta de Google Cloud

1. Ve a [cloud.google.com](https://cloud.google.com) y haz clic en **Comenzar gratis**
2. Inicia sesión con tu cuenta de Google
3. Ingresa la información de facturación — Google requiere una tarjeta de crédito para verificación. La instancia e2-micro es genuinamente gratuita y no se te cobrará mientras te mantengas dentro de los límites del nivel gratuito.
4. Recibirás $300 en créditos de prueba gratuita (válidos por 90 días) pero no los necesitas — la e2-micro está en el nivel **Always Free**, separado de la prueba.

## Paso 2: Crea una VM e2-micro

1. Ve a la [Consola de Google Cloud](https://console.cloud.google.com)
2. Navega a **Compute Engine → Instancias de VM** (habilita la API si te lo pide)
3. Haz clic en **Crear instancia**
4. Configura:
   - **Nombre:** `crow`
   - **Región:** `us-central1` (o `us-west1`, `us-east1` — **solo estas tres regiones son gratuitas**)
   - **Zona:** cualquier zona disponible en la región que elegiste
   - **Tipo de máquina:** bajo **Uso general → E2**, selecciona **e2-micro** (0.25 vCPU, 1 GB de RAM)
     - Busca "1 free e2-micro instance per month" en la documentación del nivel Always Free
   - **Disco de arranque:** haz clic en **Cambiar** → Ubuntu 22.04 LTS → Tamaño: **30 GB** → Disco persistente estándar
   - **Firewall:** NO marques "Permitir tráfico HTTP" ni "Permitir tráfico HTTPS" — usaremos Tailscale para acceso privado
5. Haz clic en **Crear**

La VM tarda alrededor de un minuto en iniciar. Anota la **IP externa** en la lista de instancias.

::: warning Límites del nivel gratuito
El nivel gratuito de la e2-micro incluye 1 instancia, 30 GB de disco y 1 GB de salida al mes hacia regiones fuera de Norteamérica. Exceder estos límites genera cargos. Monitorea tu panel de facturación.
:::

## Paso 3: Conéctate por SSH

Haz clic en el botón **SSH** junto a tu VM en la Consola, o desde tu máquina local:

```bash
# Agrega tu clave SSH a la VM desde la Consola:
# Compute Engine → Metadatos → Claves SSH → Agregar clave SSH
ssh your-username@<EXTERNAL_IP>
```

## Paso 4: Instala Crow

```bash
# Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Clonar y configurar Crow
git clone https://github.com/kh0pper/crow.git ~/crow
cd ~/crow
npm install
npm run setup
npm run init-db
```

Verifica:
```bash
node servers/memory/index.js
# Debería iniciar sin errores — presiona Ctrl+C para detenerlo
```

## Paso 5: Endurecimiento de Seguridad

```bash
# Habilitar el firewall — permitir solo SSH y Tailscale
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 41641/udp  # Tailscale
sudo ufw enable

# Instalar fail2ban
sudo apt install -y fail2ban
sudo systemctl enable fail2ban

# Deshabilitar la autenticación por contraseña en SSH (usar solo claves)
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# Habilitar actualizaciones de seguridad automáticas
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Elimina también las reglas de firewall predeterminadas de GCP que permiten HTTP/HTTPS desde cualquier lugar:
1. Ve a **Red de VPC → Firewall** en la Consola de Google Cloud
2. Busca `default-allow-http` y `default-allow-https`
3. Elimínalas (o márcalas como deshabilitadas) — Tailscale maneja todo el acceso

## Paso 6: Instala Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Sigue la URL de autenticación. Una vez conectado:

```bash
# Anota tu IP de Tailscale
tailscale ip -4
```

Permite el puerto del gateway de Crow a través de UFW para el tráfico de Tailscale:
```bash
# Permitir el puerto 3001 solo desde la red de Tailscale
sudo ufw allow from 100.64.0.0/10 to any port 3001
```

## Paso 7: Inicia el Gateway

```bash
cd ~/crow

# Crear un servicio systemd para persistencia
# Reemplaza YOUR_USERNAME con tu nombre de usuario real (ejecuta `whoami` para verificarlo)
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << 'EOF'
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/crow
ExecStart=/usr/bin/node servers/gateway/index.js --no-auth
Restart=always
RestartSec=5
Environment=PORT=3001

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable crow-gateway
sudo systemctl start crow-gateway
```

Verifica:
```bash
sudo systemctl status crow-gateway
curl http://localhost:3001/health
```

## Paso 8: Conecta Tu Plataforma de IA

Tu servidor de Crow ya está funcionando y es accesible vía Tailscale. Conéctalo desde cualquier plataforma de IA:

- [Claude Web y Móvil](/es/platforms/claude) — `http://<tailscale-ip>:3001/memory/mcp`
- [ChatGPT](/es/platforms/chatgpt) — `http://<tailscale-ip>:3001/memory/sse`
- [Gemini](/es/platforms/gemini) — `http://<tailscale-ip>:3001/memory/mcp`
- [Claude Code](/es/platforms/claude-code) — `http://<tailscale-ip>:3001/memory/mcp`
- [Todas las plataformas](/es/platforms/)

Visita `http://<tailscale-ip>:3001/setup` desde un dispositivo en tu red de Tailscale para ver el estado de las integraciones y las URLs de los endpoints.

::: tip Pruébalo
Después de conectar tu plataforma de IA, di:

> "Recuerda que hoy es mi primer día usando Crow"
> "¿Qué recuerdas?"
:::

## Paso 9: Encadena con Oracle Cloud

Si tienes una [instancia de Oracle Cloud](./oracle-cloud) ejecutando Crow, puedes encadenarlas para que las memorias se sincronicen automáticamente y puedas llamar herramientas de cualquiera de las dos desde cualquiera de las dos.

### Exporta la identidad desde Oracle Cloud

En tu instancia de Oracle Cloud (la instancia home):

```bash
cd ~/crow
npm run identity:export
```

Copia el archivo exportado a tu instancia de Google Cloud:
```bash
scp ~/.crow/identity-export.enc your-username@<google-cloud-external-ip>:~/
```

### Importa la identidad en Google Cloud

En Google Cloud:
```bash
cd ~/crow
npm run identity:import
# Ingresa la misma frase de contraseña usada durante la exportación
```

Verifica que ambas tengan el mismo Crow ID:
```bash
npm run identity
# Debería mostrar el mismo crow:xxxxxxxxxx en ambas máquinas
```

### Registra las instancias

Dile a tu IA en la instancia de **Oracle Cloud**:
```
"Registra mi instancia de Google Cloud como satélite en http://<google-tailscale-ip>:3001,
hostname google-cloud, nombre Cloud Satellite"
```

Dile a tu IA en la instancia de **Google Cloud**:
```
"Registra mi instancia de Oracle Cloud como home en http://<oracle-tailscale-ip>:3001,
hostname oracle-cloud, nombre Oracle Home"
```

### Verifica la federación

En cualquiera de las dos máquinas:
```
"Lista las instancias"
```

Deberías ver ambas listadas. Prueba la sincronización:
```
# En Oracle Cloud
"Recuerda que mi satélite de Google Cloud está funcionando"

# En Google Cloud (espera un momento)
"Busca en las memorias el satélite de Google Cloud"
```

La memoria debería aparecer en ambas instancias.

::: tip Lo que obtienes al encadenar
- **Redundancia** — si una nube se cae, la otra tiene tus datos
- **Federación** — llama herramientas de Oracle desde Google Cloud y viceversa
- **Acumulación de niveles gratuitos** — Oracle (1 GB de RAM) + Google Cloud (1 GB de RAM) = más capacidad para cargas de trabajo separadas
:::

Para la referencia completa multi-dispositivo, consulta el [Inicio Rápido Multi-Dispositivo](./multi-device).

## Opcional: Haz Público Tu Blog

Para la configuración del blog público, consulta la [sección de blog de la guía de Oracle Cloud](./oracle-cloud) — los pasos son idénticos para Google Cloud.

## Qué Hacer Si Te Comprometen el Servidor

1. **Detén la instancia** — Compute Engine → Instancias de VM → Detener
2. **Respalda tus datos** — si todavía puedes entrar por SSH: `cd ~/crow && npm run backup`
3. **Rota las claves SSH** — elimina las claves antiguas desde los Metadatos en la Consola y agrega nuevas
4. **Revisa los registros** — `sudo grep "Failed password" /var/log/auth.log | tail -20`
5. **Reinstala la imagen si es necesario** — elimina y recrea la VM. Restaura los datos con `npm run restore`
