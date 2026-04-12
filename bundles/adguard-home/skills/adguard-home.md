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

## First-run setup (required)

The image ships without credentials. Before any MCP tool will work:

1. `docker compose up -d` inside the bundle directory
2. Open `http://localhost:3020` in a browser
3. Walk through the setup wizard:
   - **Admin web interface port**: leave as 3000 (container-side; host-mapped
     to 3020)
   - **DNS server port**: leave as 53 (container-side; host-mapped to 5335)
   - **Admin credentials**: pick a username + strong password
4. Copy the credentials into your Crow `.env`:
   ```
   ADGUARD_USERNAME=<your-username>
   ADGUARD_PASSWORD=<your-password>
   ```
5. Restart Crow gateway so it picks up the new env.

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
- **Losing the admin password**: edit `~/.crow/adguard-home/conf/AdGuardHome.yaml`
  to reset the `users:` block (password is bcrypt-hashed; generate with
  `htpasswd -B -n -b <user> <pass>` and paste the hash in).
