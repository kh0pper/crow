---
name: adguard-home
description: Network-wide DNS-based ad/tracker blocking with AdGuard Home
triggers:
  - "dns"
  - "adblock"
  - "block ads"
  - "tracker"
  - "adguard"
  - "privacy filter"
tools:
  - adguard_status
  - adguard_stats
  - adguard_query_log
  - adguard_toggle_protection
---

# AdGuard Home — DNS-based ad and tracker blocking

AdGuard Home is a DNS server that filters queries against curated blocklists.
It's not a per-app content blocker — it decides what your network can resolve.
Point a device's DNS at AdGuard Home and ads/trackers disappear before any
browser plugin gets involved.

## First-run setup

AdGuard Home ships without credentials, and its first start serves its own setup wizard on
port 3000 inside the container. **Crow fills that wizard in itself** at install: the admin
account is `admin`, the password is the one Crow generated, and both are kept in
**Settings → Passwords** (the bundle's `.env` receives `ADGUARD_USERNAME`/`ADGUARD_PASSWORD`
so these MCP tools can log in). The web UI stays on container port 3000 — host-mapped to
3020 — and DNS on container port 53, host-mapped to 5335.

If this install's setup was finished before Crow did it (an older install, or you set it up
yourself), it already has a login of yours: press **Set it up for me** on the Extensions card
to let Crow do it where it still can, or **Save the login you made** so Crow keeps yours.
Either way the credentials must also reach the gateway `.env`:

```
ADGUARD_USERNAME=<your-username>
ADGUARD_PASSWORD=<your-password>
```

## Using Crow DNS on the host

On the host:
```bash
nslookup example.com 127.0.0.1 -port=5335
# or set a single client's DNS to 127.0.0.1:5335
```

To serve the LAN, edit `docker-compose.yml` and change `127.0.0.1:5335:53` to
`0.0.0.0:53:53`. First verify no other resolver (systemd-resolved,
dnsmasq, BIND) is listening on :53 — `sudo ss -tulnp | grep ':53 '`.

## MCP tools

```
adguard_status
```
Version, protection state, upstream DNS, filter list count, queries today.
Start here.

```
adguard_stats
```
Top queried / blocked domains, top clients, total query counts.

```
adguard_query_log { "limit": 50 }
adguard_query_log { "limit": 20, "search": "youtube" }
```
Recent per-query records with timestamp, client, question, response, block
reason.

```
adguard_toggle_protection { "enabled": false, "confirm": "yes" }
```
**Destructive.** Disabling protection stops ALL filtering until re-enabled;
every query resolves through upstream DNS with zero blocking. Useful for
troubleshooting a legitimate site AdGuard is mis-blocking — remember to turn
it back on.

## Common gotchas

- **Port 53 conflict**: every major Linux distro has `systemd-resolved` or
  similar listening on 53. The bundle sidesteps this by exposing DNS on
  :5335 by default. Don't change to :53 without disabling the conflicting
  resolver first, or `docker compose up` will fail with "address already in
  use."
- **Stats empty on first boot**: nothing to show until a client actually
  sends queries. Point one device at `127.0.0.1:5335` to generate traffic.
- **Losing the admin password**: it is in **Settings → Passwords** in Crow. If it was
deleted there, edit `~/.crow/adguard-home/conf/AdGuardHome.yaml` to reset the `users:`
block (password is bcrypt-hashed; generate with `htpasswd -B -n -b <user> <pass>` and
paste the hash in).
