# Windows (WSL2)

Run Crow on Windows using WSL2 (Windows Subsystem for Linux). You get a real Ubuntu Linux environment running alongside Windows, and Crow installs there exactly the way it does on any Linux home server — same install script, same systemd service, same dashboard.

## Prerequisites

- **Windows 11** (Windows 10 build 19041+ also works, but Windows 11 has the smoothest WSL2 experience)
- **Virtualization enabled in your BIOS/UEFI** — WSL2 runs a real lightweight VM, so hardware virtualization (Intel VT-x / AMD-V) must be turned on. Most machines ship with it on; if `wsl --install` fails with a virtualization error, check your BIOS settings and enable it.
- **systemd must be enabled in WSL2** — The Crow installer requires a working systemd service manager. Current `wsl --install` Ubuntu has systemd enabled by default, but if you're on an older WSL2 installation or Windows 10, your distribution may have systemd disabled. You'll check this after installing Ubuntu and enable it if needed (see the **Ensure systemd is active** section below).

## Install WSL2 + Ubuntu

Open **PowerShell as Administrator** and run:

```powershell
wsl --install
```

This installs WSL2 and Ubuntu (the default distribution) in one step. Reboot when prompted.

After the reboot, Ubuntu finishes its first-run setup automatically and asks you to create a Linux username and password (independent of your Windows login — pick anything).

::: tip Already have WSL installed?
If `wsl --install` reports WSL is already present, install Ubuntu specifically with `wsl --install -d Ubuntu`, then launch it from the Start menu.
:::

## Ensure systemd is active

Once Ubuntu is running, verify that systemd is working inside WSL2:

```bash
systemctl is-system-running
```

You should see `running` or `degraded` (degraded just means some non-Crow unit isn't happy — check `systemctl --failed` if you want to know which). If you get an error saying systemd isn't running, enable it:

```bash
sudo nano /etc/wsl.conf
```

Add (or edit) this section:

```ini
[boot]
systemd=true
```

Save and exit, then restart WSL2 from **PowerShell** (not from inside Ubuntu):

```powershell
wsl --shutdown
```

Reopen the Ubuntu app and verify again:

```bash
systemctl is-system-running
```

Once systemd is confirmed active, proceed to install Crow.

## Install Crow

Open the **Ubuntu** app from the Start menu (this drops you into a real Linux shell) and run the same one-liner used for [Home Server](./home-server) installs:

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

The installer detects Debian/Ubuntu and runs normally — Node.js, the Crow platform, a systemd service, and a self-signed HTTPS certificate all get set up inside the WSL2 Ubuntu environment. It takes 5-10 minutes, same as a native Linux install.

## The Three WSL2 Quirks

WSL2 behaves like Linux for almost everything, but three things work differently than a native Linux box. Each is covered below.

### 1. Browser access: use `localhost`, not `.local`

The installer prints a closing URL like `https://<hostname>.local/setup` — that's the **mDNS address**, and it does not resolve from your Windows browser inside a WSL2 setup. Don't use it here.

Instead, use:

```
http://localhost:3001/setup
```

WSL2 automatically forwards `localhost` traffic between Windows and the Ubuntu VM, so this works with no extra configuration — open it directly in your Windows browser (Edge, Chrome, Firefox, whatever you use).

If you've also set up [Tailscale](./tailscale-setup) inside the WSL2 Ubuntu environment, the tailnet HTTPS URL (`https://<tailscale-hostname>…ts.net/setup`) works too, from any device on your tailnet — that one isn't WSL2-specific.

::: warning Verify the port
The gateway's default port is `3001` — confirm against what the installer actually prints at the end of the run before relying on this URL, in case your instance is configured differently.
:::

### 2. Disk: keep data on the Linux side, not `/mnt/c`

Install Crow inside your Ubuntu **home directory** (the default `~` when you're logged into Ubuntu, e.g. `/home/<user>/.crow`) — not under `/mnt/c/...`, even though that path (your Windows `C:\`) is reachable from inside WSL2.

Reasons this matters:

- **Speed**: file access across the Windows/Linux boundary (`/mnt/c/...`) is dramatically slower than native Linux filesystem access. Crow's SQLite database and any downloaded model files use memory-mapped I/O (`mmap`), which depends on fast, native filesystem behavior — running from `/mnt/c` will make Crow (and any local model you download) noticeably slower.
- **Correctness**: SQLite's file locking doesn't work reliably across the 9P protocol WSL2 uses to bridge to Windows drives, which can cause database corruption under concurrent access.

If you ever need to browse your Crow data from **Windows** (Explorer, not the dashboard), it's reachable at:

```
\\wsl$\Ubuntu\home\<your-linux-username>\.crow\
```

Browse it read-only from there if you want to peek at files — just don't move the actual install there.

### 3. Network: who can reach Crow

Crow's gateway listens on all interfaces inside the Ubuntu environment, so whether another device on your network can reach it depends on how WSL2 hands out network addresses. That is a Windows-side setting, not a Crow one, and it is the difference between "reachable from this PC" and "reachable from the whole LAN".

**In the default mode (NAT), other devices cannot reach Crow.** WSL2 gives its virtual machine a virtualized ethernet adapter with its own private IP address behind Windows, so a phone or a laptop on your LAN has no route to the gateway. Reaching a server inside WSL2 from another device is the same problem as reaching a VM, and Microsoft's documented answer is a port proxy (`netsh interface portproxy add v4tov4 …`). **Don't do that for Crow** — use [Tailscale](./tailscale-setup) instead, which reaches Crow from your other devices over a private network without publishing a port to your LAN. From Windows itself, `localhost` works in this mode with no configuration: WSL2 forwards it to the virtual machine automatically.

::: warning Before you use mirrored mode
If you set `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig` (Windows 11 22H2 and later), Microsoft lists "Connect to WSL directly from your local area network (LAN)" as a benefit — so Crow's port can become reachable from your network. On Windows 11 22H2 with WSL 2.0.9 or newer the Hyper-V firewall is turned on by default and filters inbound and outbound traffic for WSL, but Microsoft does not document its default inbound action, so **check it instead of assuming it**. In an admin PowerShell:

```powershell
Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
```

That prints `DefaultInboundAction`. Do not set it to `Allow`, and do not add an inbound rule for Crow's port — either one lets the whole of your LAN reach the Crow's Nest's login page. The rules that already exist are listed with:

```powershell
Get-NetFirewallHyperVRule -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
```

`.wslconfig`'s `firewall` key (a boolean, `true` by default) is what lets Windows Firewall and the Hyper-V rules filter WSL traffic at all: leave it on. `.wslconfig` changes only take effect after `wsl --shutdown` and a restart of WSL.
:::

Never use a port proxy (`netsh interface portproxy add v4tov4 …`) for Crow's port in either mode: it publishes the gateway, dashboard login included, to your network for as long as the rule exists.

**Which mode are you in?** Look for `networkingMode` under `[wsl2]` in `%UserProfile%\.wslconfig`. That file does not exist by default, and no file (or no such key) means NAT.

ufw inside the Ubuntu environment still filters what reaches the Linux side — the installer enables it — but it is a second layer, not a replacement for the Windows side.

## GPU Acceleration: NVIDIA vs. AMD vs. CPU-only

Be aware that **Crow's own hardware probe currently runs every WSL2 install in CPU-only mode**, regardless of your GPU. This is a deliberate v1 limitation, not a bug: the probe (`servers/gateway/models/probe.js`) detects the WSL2 environment and forces `accel: cpu` without attempting any GPU passthrough detection, because no CUDA-in-WSL2 asset is wired into the model catalog yet. The setup wizard and model catalog UI will show CPU-only acceleration under WSL2 today, on any GPU vendor.

This means:

- **NVIDIA GPUs**: Windows + WSL2 does support CUDA passthrough at the OS level (NVIDIA ships WSL2-compatible drivers), so local inference *can* be GPU-accelerated in principle — but Crow's model catalog doesn't offer a CUDA-in-WSL2 build yet, so today you'll get CPU-only performance through Crow specifically.
- **AMD GPUs**: no ROCm/ HIP passthrough path exists for WSL2 at all today, on Windows or through Crow — CPU-only is the ceiling regardless.

If local model performance matters to you, the two paths that get real GPU acceleration today are a native Linux install (dual-boot or a separate machine) or [Docker](./docker) targeting a machine with working GPU passthrough. Otherwise, CPU-only inference works fine for smaller models and for BYOAI cloud providers (see [Free Cloud AI Options](./free-cloud-ai)), which don't touch local hardware at all.

## Tested Walkthrough Checklist

Because WSL2 support depends on upstream Windows/WSL2 releases that change over time, this section is a **manual runbook** to re-verify per Crow release rather than an automated test. If you're validating a new release against Windows/WSL2, walk through this list on a clean Windows 11 VM or machine:

- [ ] `wsl --install` completes and reboots without error
- [ ] Ubuntu first-run creates a Linux user successfully
- [ ] Inside Ubuntu, `systemctl is-system-running` returns `running` or `degraded` (if it errors, enable systemd via `/etc/wsl.conf` and `wsl --shutdown` before proceeding)
- [ ] The `crow-install.sh` one-liner completes all steps without a Debian/Ubuntu-detection failure or systemd errors
- [ ] `http://localhost:3001/setup` loads in a Windows browser (Edge and Chrome at minimum) with no extra configuration
- [ ] The `.local` mDNS URL the installer prints does **not** load from Windows (confirms the doc's guidance still matches reality — if this ever starts working, the doc needs an update)
- [ ] After installation, `sudo systemctl status crow-gateway` is active
- [ ] After `wsl --shutdown` + reopen, `crow-gateway` is still active (survives the restart)
- [ ] The setup wizard's hardware probe step reports CPU-only acceleration (confirm this still matches `probe.js`'s WSL2 branch — if Crow ships a CUDA-in-WSL2 asset in the future, this doc's GPU section needs a rewrite, not just a footnote)
- [ ] `\\wsl$\Ubuntu\home\<user>\.crow\` is browsable from Windows Explorer
- [ ] Record the Crow version, Windows build number, and WSL version (`wsl --version`) tested against, and the date, at the top of the test notes

## Next Steps

- [Connect your AI platform](../platforms/) once the dashboard is reachable
- [Tailscale Setup](./tailscale-setup) for remote access from your phone or other devices
- [Free Cloud AI Options](./free-cloud-ai) if you'd rather use a cloud model than wait on CPU-only local inference
