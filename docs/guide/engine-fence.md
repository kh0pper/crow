---
title: Engine fence
description: The raw-table fence in front of a published engine port, and the root-written published-ports snapshot the dashboard audits.
---

# Engine fence

An engine that answers on this host's **tailnet address** is protected by an interface-pinned rule in the `iptables` raw table: traffic to the published port arriving on anything but loopback, the engine's own Docker network, or the tailnet interface is dropped. Crow never writes those rules itself — they are installed, changed and removed by the operator.

What Crow does do is **report**. The `publishedPorts` health signal in the Nest audits what this host publishes beyond loopback and whether each tailnet-address publish carries that rule. It reads one root-written file and runs nothing itself; that file is what the second half of this page documents.

## The fence: what it puts in the ruleset

The script is `scripts/fence/crow-engine-fence`. It writes one chain in the **raw** table, `CROW-ENGINE-FENCE`, and for every published engine port one rule per address family:

```
-A CROW-ENGINE-FENCE -d <tailnet address> -p tcp -m tcp --dport <port> ! -i tailscale0 \
   -m comment --comment "crow-engine-fence:<id>:g<generation>" -j DROP
```

Why the raw table: raw `PREROUTING` runs before conntrack, before Docker's DNAT and before `FORWARD`, so the rule matches the destination address and the port only — no connection state, no source match on a tailnet-IP publish — and it covers the userland-proxy and IPv6 paths as well as the DNAT one.

Ahead of that DROP, in the same chain, are the exemptions, as `RETURN`s: `-i lo`, one per `bridge` line in the conf, and — for a `publish lan` line only — one per consumer address. They are `RETURN` and not `ACCEPT` on purpose: a `RETURN` ends only this chain, while an `ACCEPT` in raw `PREROUTING` would end raw processing and skip Docker's own raw drops for other ports. A tailnet-IP publish carries **no** source exemptions.

The chain is filled first and jumped to from `PREROUTING` at position 1 only afterwards (`-C`, then `-I`), so the jump never points at an empty or half-built chain. The whole chain is loaded in one `iptables-restore --noflush` transaction per family, so there is no RETURN-only interval.

When tailscale reports no address for a family — logged out, or the boot race — every tailnet port gets the stricter **port-only** rule for that family instead of a failed unit:

```
-A CROW-ENGINE-FENCE -p tcp -m tcp --dport <port> -m addrtype --dst-type LOCAL \
   ! -i tailscale0 -m comment --comment "crow-engine-fence:<id>:g<generation>:portonly" -j DROP
```

The address is resolved on every apply (`tailscale ip -4` / `-6`, each call bounded by `timeout 3` — a wedged daemon means the address is unresolvable, not that the unit hangs) and is never stored in the conf or the script. `publish lan` never falls back: its address is in the conf.

IPv6 rules exist when the kernel runs a v6 stack (`/proc/net/if_inet6` exists) **and** `ip6tables-restore` is installed, unless the conf carries `ipv6 unfenced`. That is decided by the stack, not by whether `ip6tables` is installed: a host with the binary and no v6 module gets no v6 rules and no warning about them. A host **with** the stack, **without** `ip6tables-restore`, and with any publish that applies to v6 — a `publish tailnet`, a `publish port-only`, or a `publish lan` on a v6 address — is refused with exit `19`: the v4 rules would look healthy while a v6-reachable publish stayed reachable from every interface, so the fence fails closed. A host whose conf carries `ipv6 unfenced` writes no v6 rules instead, records `"v6": "unfenced-by-operator"` in the state file, and `status` warns that the family is unfenced. A host with no v6 stack is unchanged: no v6 rules, no error. When a family does end up with no rules at all — a publish that moved family, the last LAN publish removed — the chain is restored empty, so a stale DROP never lingers; a family whose chain never existed is left alone, so a v4-only host gains no empty v6 chain.

Every call that touches a table passes `-w 10`: the xtables lock, so a call waits for another holder (tailscaled takes it at boot) instead of failing outright, as iptables-legacy does.

## The conf

`/etc/crow/engine-fence.conf`, root-owned, mode 0640, one directive per line. The shipped example is `scripts/fence/engine-fence.conf.example`:

```
interface tailscale0
bridge crow-eng-ex
publish tailnet 8003
publish port-only 8030
publish lan 192.0.2.10 8011 consumer 192.0.2.20
#ipv6 unfenced
```

- `interface` — the one inbound interface allowed to reach a published port. Exactly one, required. `lo`, `docker0`, Docker's gateway bridge and the well-known hypervisor/CNI defaults are refused (a fence pinned to a shared interface fences nothing), and so is any name beginning with `-` (it would be read as an option).
- `bridge` — a bridge Crow itself created for one engine, by its `com.docker.network.bridge.name` (at most 15 characters). `docker0`, Docker's gateway bridge and the well-known hypervisor/CNI defaults are refused: a `RETURN` for a shared interface fences nothing.
- `publish tailnet <port>` — a publish on this host's tailnet address. A `consumer` clause on this line refuses the conf.
- `publish port-only <port>` — no destination match. Protects a wildcard or unknown-address publish during a migration. No consumer clause.
- `publish lan <addr> <port> consumer <addr> …` — a LAN-address publish, the only place source exemptions are allowed. One address per consumer, and every process on the consumer host counts as the consumer. A range needs the operator's explicit `confirm-range` token at the end of the line, because it widens who may reach the port; its prefix must be a number in range (1–32 for v4, 1–128 for v6) and `/0` is refused, since an exemption that matches everything makes the DROP beside it unreachable. Every consumer must be an address of the publish's own family. A tailnet address as the publish destination is refused: that is `publish tailnet`, which carries no source exemptions.
- `ipv6 unfenced` — the operator's explicit acceptance of an unfenced v6 family. On a host that runs a v6 stack but has no `ip6tables-restore`, a conf with a publish that applies to v6 is refused (exit `19`) unless this line is present. With it, no v6 rule is written, `state.json` records `"v6": "unfenced-by-operator"`, and `status` warns. This is a risk taken on purpose: a v6-reachable publish is then reachable from every interface. The safe answer is to install `ip6tables` and delete the line.

An unknown directive, a port outside 1-65535, a port published twice, a malformed address or a refused combination fails the whole conf, and a failed conf changes no rule. There is no directive for `docker0` and none for a wildcard address.

## Install (operator, as root)

```bash
install -m 0755 scripts/fence/crow-engine-fence /usr/local/sbin/crow-engine-fence
install -m 0644 scripts/fence/crow-engine-fence.service /etc/systemd/system/
install -m 0644 scripts/fence/crow-engine-fence-reapply.service /etc/systemd/system/
install -m 0644 scripts/fence/crow-engine-fence-reapply.timer /etc/systemd/system/
[ -d /etc/crow ] || install -d -m 0750 /etc/crow
install -m 0640 scripts/fence/engine-fence.conf.example /etc/crow/engine-fence.conf
printf 'CROW_ENGINE_FENCE_GROUP=%s\n' '<group>' > /etc/crow/engine-fence.env
chmod 0640 /etc/crow/engine-fence.env
systemctl daemon-reload
systemd-analyze verify crow-engine-fence.service crow-engine-fence-reapply.service crow-engine-fence-reapply.timer
```

Edit `/etc/crow/engine-fence.conf` first: the example holds placeholders only.

`<group>` is the group of the user the gateway runs as (`id -gn <gateway-user>`). It must be a local `/etc/group` entry: a directory-service group can make the unit fail at early boot, before the directory service is up. The unit's `RuntimeDirectory=crow-engine-fence` creates `/run/crow-engine-fence` as `root:root` 0750 before the sandbox namespace is built, and the script then sets that group on the directory and the state file (it has `CAP_CHOWN`). Without it the state file stays root-only and the start block cannot read it. The group is never written into the shipped units — they read `/etc/crow/engine-fence.env`.

Then, with docker up:

```bash
crow-engine-fence check      # validates the conf, reads the backend and the bridges, saves the facts
crow-engine-fence apply      # check + the rules
crow-engine-fence status     # the live rules, the addresses used, the generation (read-only)
systemctl enable crow-engine-fence.service crow-engine-fence-reapply.timer
```

`check` is the only mode that talks to docker (`iptables --version`, `docker info` for the firewall backend, `docker network inspect` for each `bridge`). `apply --boot` is what the units run and makes **no** docker call at all: it reads the firewall backend from `/etc/docker/daemon.json` (an absent file or key means Docker's default backend; an explicit `nftables` backend or an unreadable file is refused), the iptables flavour from `iptables --version`, and the bridge facts from `/etc/crow/engine-fence.facts.json`.

That facts file is written by `check` and by an interactive `apply`. `apply --boot` refuses when it is missing, when the conf changed since it was written, or when `/etc/docker/daemon.json` or a `docker.service` drop-in changed: re-run `check` after any of those edits. `status` warns about the same mismatches. **Any edit to `daemon.json`, to a file in `/etc/systemd/system/docker.service.d/`, or to the unit's `ExecStart` makes the next boot fail closed — docker will not start — until `crow-engine-fence check` is re-run.** The facts file stores the hash of exactly that text, and the boot path compares it before it touches a rule.

`status` is read-only: it prints the live rules, the addresses, the generation and each family's state (`fenced`, or the reason that family is not), and it never writes the state file. It warns on any family that is unfenced — an `ipv6 unfenced` conf, a v6 stack with publishes but no `ip6tables-restore` — so a gap is never silent. The state file is written by `apply` and by `remove`, so what it holds is what was last applied, not what a look at the host would like it to say.

- `/etc/crow/engine-fence.facts.json` — root, 0640: the backend, the per-bridge facts, the conf hash, the Docker-flags hash, `saved_at`.
- `/run/crow-engine-fence/state.json` — root, 0640, group `<group>`, inside the unit's `0750` RuntimeDirectory: the generation, `applied_at`, the backend, the v6 family's state (`fenced`, `unfenced-by-operator`, `no-stack`, …), the resolved tailnet addresses, and one entry per rule (`id`, family, address, `addressed`/`port-only`, port, interface, exemptions). Nothing else — no process names, no environment.
- `/run/crow-engine-fence/applied.sha256` — root, 0640, group `<group>`: the hash of the transaction text that was last really restored. A re-apply run that would restore the same bytes restores nothing (see the timer below). It lives on `/run`, so a reboot starts without it and the boot apply always writes its rules.
- `/run/crow-engine-fence/applied.counts` — root, 0640, group `<group>`: the number of rules the last apply or `remove` left in each family. The skip compares it with the live chain, so a flushed chain or a deleted jump is restored even when the transaction text has not changed, and `remove` records its reduced count here so the timer leaves the removal alone.

### RequiredBy or WantedBy

The shipped `crow-engine-fence.service` is `RequiredBy=docker.service`: docker does not start unless the fence applied (fail closed). Use it on any host whose tailnet comes from the host's own `tailscaled`.

Hosts whose tailnet is provided by the `tailscale` **bundle** (a docker container) cannot have an address before dockerd starts. There, `RequiredBy` is the wrong link, and the shipped `crow-engine-fence-wantedby.service` variant is installed instead — identical except for its `[Install]` line (`WantedBy=docker.service`, fail open: docker starts even if the fence failed). On such a host the port-only rule still applies at boot, the re-apply timer upgrades it once tailscale is up, and the dashboard's `publishedPorts` warn plus Crow's own refusal to start a published engine while the fence is inactive are the remaining guards.

| host's tailnet comes from | unit | failure mode |
|---|---|---|
| host `tailscaled` | `crow-engine-fence.service` | fail closed: docker waits for the fence |
| the `tailscale` bundle (container) | `crow-engine-fence-wantedby.service` | fail open: docker starts anyway |

Install exactly one of the two under `/etc/systemd/system/crow-engine-fence.service`.

### The re-apply timer

`crow-engine-fence-reapply.timer` re-runs `crow-engine-fence apply --boot` (idempotent, no docker) and has two phases:

- the first 15 minutes after boot, **once a minute** — one `OnBootSec=` trigger per minute, because that is the window in which tailscaled may still have no address and the boot apply installed the stricter port-only rule;
- from then on, **every 15 minutes** on the calendar (`OnCalendar=*:0/15`).

Either phase does nothing at all when the transaction it would restore is byte-identical to the last applied one **and** the live chain still matches the rule count that apply left (the PREROUTING jump present, the expected number of `-A` lines): no `iptables-restore`, no `ip6tables-restore`, no state rewrite. The applied hash is `/run/crow-engine-fence/applied.sha256`, and `/run/crow-engine-fence/applied.counts` records the counts. That is what makes the minute-by-minute window cheap, and it is also why `remove <id>` survives the timer: the conf's transaction is unchanged and `remove` writes the reduced counts, so the run skips. A conf edit changes the transaction (a new generation) and the next run restores the full set — the removed rule included, if the conf still lists it — and so does an interactive `crow-engine-fence apply`, which never skips. A flush or a hand-deleted jump is restored on the next run even without a conf edit.

The unit declares **no** `RuntimeDirectory=` — `/run/crow-engine-fence` belongs to the fence unit — and it never restarts or stops the fence unit or docker.

### Sandbox and the strict variant

The shipped unit deliberately has no `ProtectSystem=strict`: `iptables` creates `/run/xtables.lock` even to list rules, which a strict namespace forbids. If you want strict anyway, install both files, exactly as for the snapshot job:

```
# /etc/tmpfiles.d/crow-xtables-lock.conf
f /run/xtables.lock 0600 root root
```

```
# /etc/systemd/system/crow-engine-fence.service.d/strict.conf
[Service]
ProtectSystem=strict
ReadWritePaths=/run/xtables.lock /run/crow-engine-fence
```

then `systemd-tmpfiles --create` and `systemctl daemon-reload`. The `ReadWritePaths=` entries have no `-` prefix on purpose: with the tmpfiles line in place the lock exists, and if it ever does not the unit should fail loudly rather than run in a namespace that cannot create it.

## Changing rules, and the break-glass

**To change rules: `crow-engine-fence apply`** — never `systemctl restart crow-engine-fence`: `docker.service` requires this unit, so a restart is passed along to docker and restarts it, and a stop of the unit stops docker.

**Break-glass, when a bad conf or an unreadable backend keeps docker down:**

```bash
systemctl disable --now crow-engine-fence-reapply.timer
systemctl disable crow-engine-fence
systemctl start docker
```

Both lines matter: `disable` removes the `docker.service.requires` link, so docker starts without the fence, and disabling the re-apply timer stops a later run from restoring the fence's rules behind you while you are working around a broken conf. Fix the conf, run `crow-engine-fence check` and `crow-engine-fence apply`, then `systemctl enable crow-engine-fence` and `systemctl enable --now crow-engine-fence-reapply.timer` again. The break-glass is never `mask`: masking `crow-engine-fence` keeps docker down (docker requires the unit), which is the outage the break-glass exists to end. A late, dead or logged-out `tailscaled` does **not** block docker — that is what the port-only rule and the timer are for. Only a conf that fails validation, an unknown backend or a missing/stale facts file blocks it.

## Acceptance probes (once per install, in a window)

1. From the tailnet: connect to the published port. It must answer.
2. From loopback on the host: it must answer.
3. From a LAN host that is **not** the consumer, add a route for the tailnet address via the engine host's LAN address and connect to the port. It can succeed without the fence; with the fence it must not.
4. From a container on the default bridge, dial the tailnet address and the port. It must not answer: `docker0` is never exempt.
5. Repeat 1-4 for IPv6 on a host with a v6 tailnet address.
6. `crow-engine-fence status` shows the rules, the addresses used and no `WARN`.
7. A `systemctl restart docker` and a reboot, in a registered window: the fence is present before the engine container is up.

## Converting an existing fence

`crow-engine-fence swap-check --old-tag <tag>` prints the old rules and compares **destination coverage**, not just ports. A `-d` rule covers one address; a wildcard publish is reachable on more than one, so an addressed rule never covers it and the old rules stay until the new set has a port-only rule for that port. It deletes nothing: the operator removes the old rules by hand, one at a time, re-probing after each.

## Removal

```bash
crow-engine-fence remove <id>        # one publish's rules, live only; the conf still lists it
crow-engine-fence status             # warns about a conf entry with no live rule
```

`remove <id>` edits the live rules only, never the conf: the conf is the operator's file. The rules it leaves behind are built from **the conf** with that id skipped, never from the live chain — a chain that had already drifted would otherwise be recorded as the new baseline — and it records those conf-derived counts next to the applied hash, so the re-apply timer's run keeps skipping and the removal stands. Before it removes anything it compares the live chain with the rule count the last `apply` recorded and refuses (non-zero) if they differ, naming the command to run: a host whose chain was flushed or edited by hand needs `crow-engine-fence apply` first. A removal also comes back after a reboot (the applied hash and counts live on `/run`) and after any change in the resolved tailnet address (the transaction is then no longer the one that was applied); an interactive `crow-engine-fence apply` or any edit to the conf restores the rule as well. To retire a publish for good, edit the conf too; to stop using the fence entirely:

```bash
systemctl disable --now crow-engine-fence-reapply.timer
systemctl disable crow-engine-fence
crow-engine-fence remove <id>        # for every published port
rm -f /etc/systemd/system/crow-engine-fence.service \
      /etc/systemd/system/crow-engine-fence-reapply.service \
      /etc/systemd/system/crow-engine-fence-reapply.timer
rm -f /usr/local/sbin/crow-engine-fence /etc/crow/engine-fence.conf /etc/crow/engine-fence.facts.json
systemctl daemon-reload
```

Removing the chain from the raw table is `iptables -t raw -D PREROUTING -j CROW-ENGINE-FENCE` and `iptables -t raw -F CROW-ENGINE-FENCE` (plus the `ip6tables` equivalents) — the script itself never deletes a chain.

### Exit codes

`0` ok, `2` usage, `10` conf unreadable, `11` a conf line is invalid, `12` the conf is refused on principle, `13` unknown iptables flavour, `14` docker unreadable, `15` unknown Docker firewall backend, `16` a Docker bridge fact is wrong or missing, `17` the facts file is missing, `18` the facts are stale, `19` the restore transaction failed, or a family that has to be fenced cannot be (a v6 stack with v6 publishes and no `ip6tables-restore`), `20` a check refused (including `remove` on a chain that no longer matches the last apply), `21` another run holds the lock, `22` the state directory is unusable.

## The published-ports snapshot

A `systemd` oneshot job writes one JSON document every 5 minutes:

```
/var/lib/crow-fence/snapshot.json        mode 0640, owner root, group <group>
```

The audit reads that path (override with `CROW_PUBLISH_SNAPSHOT`). A snapshot older than 15 minutes is treated as stale, and a missing, unreadable or malformed one is reported as **unknown** — never as "nothing is published beyond loopback". A file that was never written and a file that says everything is loopback must not look the same.

The job runs as root because reading every container's inspect document, the raw tables and the socket table needs it. The gateway's audit stays unprivileged and never shells out to `docker`, `iptables` or `tailscale`.

### What it holds

| Field | Contents |
|---|---|
| `taken_at` | when the snapshot was written |
| `docker` | `version`, `firewall_backend`, `userland_proxy` |
| `containers[]` | per running container: short id, name, its `crow.*` labels plus `com.docker.compose.project` and `com.docker.compose.project.working_dir`, the host network mode, the port bindings (`HostIp`/`HostPort`), the network names |
| `listeners[]` | `ss -ltn` rows, address and port only |
| `raw_rules` | `v4` and `v6`: `iptables -t raw -S` and `ip6tables -t raw -S` |
| `fence` | `unit_active` and the raw `unit_state` word from `systemctl is-active` |
| `tailscale` | `v4` and `v6` from `tailscale ip -4` / `-6` |
| `errors[]` | one entry per command that failed; the section it fed is `null` |

**Never in the file:** environment variables, command lines, entrypoints, mounts, image metadata, or process names from `ss` (the job never passes `-p`). Each inspect field is selected explicitly, so an inspect dump holding a token cannot end up here by accident.

A command that fails does not fail the run: that section is written as `null` with an entry under `errors`, and the rest of the document is still written. A section that could not be read is never written as an empty list.

Stopped containers are not listed — a stopped container publishes nothing.

## Install (operator, as root)

```bash
install -m 0755 scripts/fence/crow-publish-snapshot /usr/local/sbin/crow-publish-snapshot
install -m 0644 scripts/fence/crow-publish-snapshot.service /etc/systemd/system/
install -m 0644 scripts/fence/crow-publish-snapshot.timer /etc/systemd/system/
[ -d /etc/crow ] || install -d -m 0750 /etc/crow
printf 'CROW_SNAPSHOT_GROUP=%s\n' '<group>' > /etc/crow/publish-snapshot.env
chmod 0640 /etc/crow/publish-snapshot.env
install -d -m 0750 -o root -g '<group>' /var/lib/crow-fence
systemctl daemon-reload
systemd-analyze verify crow-publish-snapshot.service crow-publish-snapshot.timer
systemctl enable --now crow-publish-snapshot.timer
systemctl start crow-publish-snapshot.service
```

The first run writes the file immediately; the timer then refreshes it every 5 minutes of uptime (the first fire is 2 minutes after boot). Read the result with `cat /var/lib/crow-fence/snapshot.json`.

The job never starts or stops anything: not docker, not tailscaled. It asks `systemctl is-active --quiet docker.service` first, and while docker is not active it runs **no** docker CLI call at all — docker.service is socket activated, so even `docker version` would bring dockerd back. In that state the `docker` object and `containers` are `null` with one `docker.service not active` error entry. The same holds for tailscaled: a daemon that is down becomes a `null` section with an error entry rather than a failed unit.

### Choosing the group

The snapshot is `0640 root:<group>` inside a `0750 root:<group>` directory, so `<group>` has to be the group of the user the gateway runs as. Otherwise the audit cannot read the file and reports **unknown**.

Find the group name with `id -gn <gateway-user>` and put it in `/etc/crow/publish-snapshot.env`:

```
CROW_SNAPSHOT_GROUP=<group>
```

The group is never written into the shipped script or unit — the unit reads it from that env file, and a host without the file simply leaves the snapshot root-only (the job warns about it in the journal, and the audit says unknown). To change the group later, edit the env file and `systemctl start crow-publish-snapshot.service`; the timer picks the next run up anyway.

The job creates and prepares its own dedicated directory — `install -d -m 0750 -o root -g <group> /var/lib/crow-fence` — and applies the group only there, so the gateway's group can traverse it. The directory keeps `0750`: the group may read, others may not. The unit deliberately has **no** `StateDirectory=`: with no `User=`/`Group=` systemd would re-chown the directory to `root:root` on every start, which makes the snapshot unreadable to the gateway during the run and for good after a failed one.

If you prefer tmpfiles to create it, install this line instead (or as well; the job's `install -d` is idempotent):

```
# /etc/tmpfiles.d/crow-fence.conf
d /var/lib/crow-fence 0750 root <group>
```

then `systemd-tmpfiles --create`. An `--output` outside `/var/lib/crow-fence` is used exactly as it is: the job changes the mode and group of the dedicated directory only, and refuses an output directory that is sticky, world-writable or not owned by root rather than writing a snapshot into it.

### The strict sandbox variant (optional)

The shipped unit uses `ProtectSystem=full` on purpose. `iptables` takes the xtables lock even to list rules, and creates `/run/xtables.lock` when it is absent — which a `ProtectSystem=strict` namespace forbids. To harden further, add both files:

```
# /etc/tmpfiles.d/crow-xtables-lock.conf
f /run/xtables.lock 0600 root root
```

```
# /etc/systemd/system/crow-publish-snapshot.service.d/strict.conf
[Service]
ProtectSystem=strict
ReadWritePaths=/run/xtables.lock /var/lib/crow-fence
```

then `systemd-tmpfiles --create` and `systemctl daemon-reload`. The `ReadWritePaths=` entries have no `-` prefix on purpose: with the tmpfiles line in place the lock exists, and if it ever does not, the unit should fail loudly instead of running in a namespace that cannot create it. The state directory is listed because there is no `StateDirectory=` to make it writable under `strict`; without the entry the job could neither write the snapshot nor apply the directory's mode and group.

## What the audit makes of it

- a publish on loopback: silent.
- a publish on the tailnet address **with** the raw fence rule for that address and port: info, listed as fenced.
- a publish on the tailnet address **without** the rule: warn. A snapshot that is stale, or a rule pinned to a different tailnet address than the one in `tailscale`, also warns — the fence is then unknown, not assumed.
- a wildcard, empty-host, LAN or bridge publish: warn, one issue per container and port.
- a Crow-labelled engine on host networking: warn.

`unit_active` is the fence unit's `is-active` word, so an inactive fence shows up as a publish that is not fenced rather than as a silent gap. The facts/conf/docker-flags hashes stay with the fence job's own `status` output; the snapshot does not recompute them.

## Limits it states about itself

- rootless Docker and podman use a different socket: their containers never appear in the snapshot.
- it checks the systemd unit named `docker.service`; a host whose Docker runs under another unit name (a snap install, for example) reads as "unknown" every run, which fails safe.
- a listener inside another network namespace is invisible to `ss`.
- a host-networked container publishes nothing and listens on every address; it is flagged from its network mode, not from the listener rows.
- listener rows carry no owner and no process name, so they are a hint for the operator, never a claim about which container is listening.

## Removing it

```bash
systemctl disable --now crow-publish-snapshot.timer
rm -f /etc/systemd/system/crow-publish-snapshot.service /etc/systemd/system/crow-publish-snapshot.timer
rm -f /usr/local/sbin/crow-publish-snapshot /etc/crow/publish-snapshot.env
systemctl daemon-reload
```

The audit needs nothing else removed: it reports the remaining file as **unknown** once it is older than 15 minutes, and nothing else on the host reads it. `rm -rf /var/lib/crow-fence` deletes it entirely.