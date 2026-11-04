---
title: Engine fence
description: The raw-table fence in front of a published engine port, and the root-written published-ports snapshot the dashboard audits.
---

# Engine fence

An engine that answers on this host's **tailnet address** is protected by an interface-pinned rule in the `iptables` raw table: traffic to the published port arriving on anything but loopback, the engine's own Docker network, or the tailnet interface is dropped. Crow never writes those rules itself — they are installed, changed and removed by the operator.

What Crow does do is **report**. The `publishedPorts` health signal in the Nest audits what this host publishes beyond loopback and whether each tailnet-address publish carries that rule. It reads one root-written file and runs nothing itself; that file is what this page documents.

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