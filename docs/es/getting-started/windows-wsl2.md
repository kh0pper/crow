# Windows (WSL2)

Ejecuta Crow en Windows usando WSL2 (Subsistema de Windows para Linux). Obtienes un entorno real de Ubuntu Linux corriendo junto a Windows, y Crow se instala ahí exactamente igual que en cualquier servidor Linux casero — el mismo script de instalación, el mismo servicio systemd, el mismo panel.

## Requisitos Previos

- **Windows 11** (Windows 10 build 19041+ también funciona, pero Windows 11 tiene la experiencia WSL2 más fluida)
- **Virtualización habilitada en tu BIOS/UEFI** — WSL2 ejecuta una VM ligera real, así que la virtualización por hardware (Intel VT-x / AMD-V) debe estar activada. La mayoría de las máquinas la traen activada de fábrica; si `wsl --install` falla con un error de virtualización, revisa la configuración de tu BIOS y actívala.

## Instalar WSL2 + Ubuntu

Abre **PowerShell como Administrador** y ejecuta:

```powershell
wsl --install
```

Esto instala WSL2 y Ubuntu (la distribución por defecto) en un solo paso. Reinicia cuando se te indique.

Después de reiniciar, Ubuntu termina automáticamente su configuración inicial y te pide crear un usuario y contraseña de Linux (independientes de tu inicio de sesión de Windows — elige lo que quieras).

::: tip ¿Ya tienes WSL instalado?
Si `wsl --install` reporta que WSL ya está presente, instala Ubuntu específicamente con `wsl --install -d Ubuntu`, y luego ábrelo desde el menú Inicio.
:::

## Instalar Crow

Abre la aplicación **Ubuntu** desde el menú Inicio (esto te lleva a una terminal Linux real) y ejecuta el mismo comando único usado para instalaciones de [Servidor en Casa](./home-server):

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

El instalador detecta Debian/Ubuntu y se ejecuta normalmente — Node.js, la plataforma Crow, un servicio systemd y un certificado HTTPS autofirmado se configuran dentro del entorno Ubuntu de WSL2. Toma de 5 a 10 minutos, igual que una instalación nativa de Linux.

## Las Tres Peculiaridades de WSL2

WSL2 se comporta como Linux para casi todo, pero tres cosas funcionan distinto a una máquina Linux nativa. Cada una tiene una solución sencilla.

### 1. Acceso desde el navegador: usa `localhost`, no `.local`

El instalador imprime una URL final como `https://<hostname>.local/setup` — esa es la **dirección mDNS**, y no se resuelve desde tu navegador de Windows en una configuración WSL2. No la uses aquí.

En su lugar, usa:

```
http://localhost:3001/setup
```

WSL2 reenvía automáticamente el tráfico de `localhost` entre Windows y la VM de Ubuntu, así que esto funciona sin configuración adicional — ábrelo directamente en tu navegador de Windows (Edge, Chrome, Firefox, el que uses).

Si además configuraste [Tailscale](./tailscale-setup) dentro del entorno Ubuntu de WSL2, la URL HTTPS de tu tailnet (`https://<nombre-tailscale>…ts.net/setup`) también funciona, desde cualquier dispositivo en tu tailnet — esa no es específica de WSL2.

::: warning Verifica el puerto
El puerto por defecto del gateway es `3001` — confirma contra lo que realmente imprime el instalador al final de la ejecución antes de confiar en esta URL, por si tu instancia está configurada de otra forma.
:::

### 2. Inicio automático: habilita systemd en WSL2

El instalador configura un servicio systemd `crow-gateway`, pero las distribuciones WSL2 no ejecutan systemd por defecto — sin él, el servicio no sobrevive a un reinicio de WSL2 (y Crow no volverá a levantarse después de cerrar y reabrir la ventana de Ubuntu o reiniciar Windows).

Habilita systemd una sola vez, desde dentro de Ubuntu:

```bash
sudo nano /etc/wsl.conf
```

Agrega (o edita) esta sección:

```ini
[boot]
systemd=true
```

Guarda y sal, luego reinicia WSL2 desde **PowerShell** (no desde dentro de Ubuntu):

```powershell
wsl --shutdown
```

Vuelve a abrir la aplicación Ubuntu — WSL2 reinicia con systemd activo. Verifica que funcionó:

```bash
systemctl is-system-running
```

Deberías ver `running` o `degraded` (degraded solo significa que alguna unidad ajena a Crow no está contenta — revisa `systemctl --failed` si quieres saber cuál) en lugar de un error diciendo que systemd no se está ejecutando. Luego confirma que Crow específicamente arrancó:

```bash
sudo systemctl status crow-gateway
```

Si te saltas este paso, Crow igual funciona — solo que tienes que iniciarlo manualmente después de cada reinicio de WSL2 con `sudo systemctl start crow-gateway` (que a su vez solo funciona una vez que systemd está habilitado) o ejecutando `node servers/gateway/index.js` directamente desde el directorio `~/.crow/app`.

### 3. Disco: mantén los datos del lado de Linux, no en `/mnt/c`

Instala Crow dentro de tu directorio personal de Ubuntu (el `~` por defecto cuando has iniciado sesión en Ubuntu, por ejemplo `/home/<usuario>/.crow`) — no bajo `/mnt/c/...`, aunque esa ruta (tu `C:\` de Windows) sea accesible desde dentro de WSL2.

Razones por las que esto importa:

- **Velocidad**: el acceso a archivos a través del límite Windows/Linux (`/mnt/c/...`) es notablemente más lento que el acceso nativo al sistema de archivos de Linux. La base de datos SQLite de Crow y cualquier archivo de modelo descargado usan E/S mapeada en memoria (`mmap`), que depende de un comportamiento rápido y nativo del sistema de archivos — ejecutar desde `/mnt/c` hará que Crow (y cualquier modelo local que descargues) sea notablemente más lento.
- **Correctitud**: el bloqueo de archivos de SQLite no funciona de forma confiable a través del protocolo 9P que usa WSL2 para conectarse con las unidades de Windows, lo cual puede causar corrupción de la base de datos bajo acceso concurrente.

Si alguna vez necesitas explorar tus datos de Crow desde **Windows** (el Explorador, no el panel), están accesibles en:

```
\\wsl$\Ubuntu\home\<tu-usuario-de-linux>\.crow\
```

Explóralos solo de lectura desde ahí si quieres echar un vistazo a los archivos — simplemente no muevas la instalación real ahí.

## Aceleración por GPU: NVIDIA vs. AMD vs. Solo CPU

Ten en cuenta que **el detector de hardware de Crow actualmente ejecuta cada instalación de WSL2 en modo solo-CPU**, sin importar tu GPU. Esta es una limitación deliberada de v1, no un error: el detector (`servers/gateway/models/probe.js`) detecta el entorno WSL2 y fuerza `accel: cpu` sin intentar ninguna detección de paso-directo de GPU, porque todavía no hay ningún recurso CUDA-en-WSL2 conectado al catálogo de modelos. El asistente de configuración y la interfaz del catálogo de modelos mostrarán aceleración solo-CPU bajo WSL2 hoy en día, sin importar el fabricante de la GPU.

Esto significa:

- **GPUs NVIDIA**: Windows + WSL2 sí soporta paso-directo de CUDA a nivel de sistema operativo (NVIDIA distribuye drivers compatibles con WSL2), así que la inferencia local *puede* acelerarse por GPU en principio — pero el catálogo de modelos de Crow todavía no ofrece una compilación CUDA-en-WSL2, así que hoy obtendrás rendimiento solo-CPU a través de Crow específicamente.
- **GPUs AMD**: no existe ninguna ruta de paso-directo ROCm/HIP para WSL2 hoy en día, ni en Windows ni a través de Crow — solo-CPU es el techo sin importar el escenario.

Si el rendimiento de los modelos locales te importa, las dos rutas que hoy obtienen aceleración real por GPU son una instalación nativa de Linux (dual-boot o una máquina separada) o [Docker](./docker) apuntando a una máquina con paso-directo de GPU funcional. De lo contrario, la inferencia solo-CPU funciona bien para modelos pequeños y para proveedores de IA en la nube vía BYOAI (ver [Opciones de IA Gratuita en la Nube](./free-cloud-ai)), que no tocan el hardware local en absoluto.

## Lista de Verificación de Prueba

Debido a que el soporte de WSL2 depende de lanzamientos de Windows/WSL2 que cambian con el tiempo, esta sección es una **guía de verificación manual** para reconfirmar en cada lanzamiento de Crow, no una prueba automatizada. Si estás validando un nuevo lanzamiento contra Windows/WSL2, recorre esta lista en una VM o máquina limpia con Windows 11:

- [ ] `wsl --install` se completa y reinicia sin errores
- [ ] La configuración inicial de Ubuntu crea un usuario de Linux exitosamente
- [ ] El comando único `crow-install.sh` completa todos los pasos sin un fallo de detección de Debian/Ubuntu
- [ ] `http://localhost:3001/setup` carga en un navegador de Windows (Edge y Chrome como mínimo) sin configuración adicional
- [ ] La URL mDNS `.local` que imprime el instalador **no** carga desde Windows (confirma que la guía sigue coincidiendo con la realidad — si esto alguna vez empieza a funcionar, la guía necesita actualizarse)
- [ ] Antes de habilitar systemd: `crow-gateway` no sobrevive a `wsl --shutdown` + reapertura
- [ ] Después de agregar `[boot]\nsystemd=true` a `/etc/wsl.conf` y `wsl --shutdown`: `systemctl is-system-running` devuelve `running` o `degraded`, y `crow-gateway` está activo al reabrir Ubuntu sin inicio manual
- [ ] El paso de detección de hardware del asistente de configuración reporta aceleración solo-CPU (confirma que esto sigue coincidiendo con la rama WSL2 de `probe.js` — si Crow llega a distribuir un recurso CUDA-en-WSL2 en el futuro, la sección de GPU de esta guía necesita una reescritura, no solo una nota)
- [ ] `\\wsl$\Ubuntu\home\<usuario>\.crow\` es accesible desde el Explorador de Windows
- [ ] Registra la versión de Crow, el número de build de Windows, y la versión de WSL (`wsl --version`) probadas, junto con la fecha, al inicio de las notas de prueba

## Próximos Pasos

- [Conecta tu plataforma de IA](../platforms/) una vez que el panel sea accesible
- [Configuración de Tailscale](./tailscale-setup) para acceso remoto desde tu teléfono u otros dispositivos
- [Opciones de IA Gratuita en la Nube](./free-cloud-ai) si prefieres usar un modelo en la nube en lugar de esperar la inferencia local solo-CPU
