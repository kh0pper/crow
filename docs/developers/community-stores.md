# Community Add-on Stores

Crow supports community-maintained add-on stores, similar to Umbrel's community app stores. Any GitHub repository following the store template can be added as an add-on source.

## How It Works

1. Community members create a GitHub repo following the store template
2. Users add the store URL in the Extensions panel settings
3. The Extensions panel merges add-ons from all configured stores
4. Community add-ons show a "Community" badge (not verified by Crow)

## Store Template

A community store is a GitHub repository with this structure:

```
my-crow-store/
├── crow-store.json          # Store metadata
├── my-addon/
│   ├── manifest.json        # Add-on metadata (same format as official)
│   ├── docker-compose.yml   # For bundle type
│   └── server/              # For mcp-server type
├── another-addon/
│   ├── manifest.json
│   └── ...
└── README.md
```

### `crow-store.json`

```json
{
  "id": "my-store",
  "name": "My Community Store",
  "author": "your-github-username",
  "description": "A collection of add-ons for data analysis",
  "url": "https://github.com/your-username/my-crow-store"
}
```

### Add-on Manifests

Each add-on in a community store uses the same `manifest.json` format as the [official registry](/developers/addon-registry). The Extensions panel reads these manifests to display add-on cards.

## Security Model

Community stores have additional restrictions compared to the official registry:

| | Official | Community |
|---|---|---|
| Verified badge | Yes | No ("Community" badge) |
| Auto-updates | Supported | Manual confirmation required |
| Docker network | Host network available | Isolated network only |
| Volume mounts | Named volumes, the add-on's own folders, folders you allowed | Named volumes, the add-on's own folders, folders you allowed |
| Privileged mode | Case-by-case | Never allowed |

### Compose File Validation

Before installing a community add-on, and again every time Crow starts its containers, Crow checks the compose project. It asks Docker Compose for the configuration it will actually apply (`docker compose config`: anchors, `include`, `extends`, override files and `${VAR}` values resolved) and checks that, following symlinks. If Compose can't read the project, the install is refused.

- **Outside Crow's folders, only folders you allowed**: a host folder outside Crow's home and data folder is mounted only if you typed it for this extension in its install form or Configure, on this machine's own dashboard (signed in with its password: not from a paired instance, not through a peer sign-in). A default or example value from the extension never counts, and an allowed folder counts only while that setting still names it, so a hand edit of `.env` shows the setting in Configure again. Allowed folders may not sit inside, or contain, another extension's allowed folder. The only fixed host entries are `/etc/localtime` read-only, `/proc` and `/sys` read-only with consent, and the Docker socket read-only with consent.
- **Rejected**: host mounts of `/`, your home folder, `/etc`, `/root`, `/boot`, `/run`, `/dev`, `~/.ssh`, Docker's own data, Crow's folder, data folder, secrets folder and `.env`, other extensions' folders, or any parent of these. Exceptions: `/etc/localtime` read-only; the add-on's own `<data folder>/<id>` subfolder
- **Rejected**: `env_file`, `secrets`/`configs` files and the build context outside the add-on's own folder
- **Rejected**: a second compose file (`compose.yaml`, `docker-compose.override.yml`, …) shipped next to `docker-compose.yml`, `include:`/`extends: file:`, and `COMPOSE_*` settings in its `.env`
- **Rejected for community add-ons, and only with consent for first-party ones**: `privileged`, dangerous capabilities (`NET_ADMIN`, `SYS_ADMIN`, `ALL`, …), host or another container's network, the host's PID/IPC/user namespaces, `unconfined` security options, `volumes_from`, and host devices other than GPU render nodes
- **Allowed**: named Docker volumes and paths inside the add-on's folder

### Network Isolation

Community add-on containers run in an isolated Docker network by default. They can only access ports explicitly declared in their `manifest.json`. Host network access (`network_mode: host`) is blocked for community add-ons.

## Managing Stores

### Adding a Store

In the Extensions panel settings, enter the GitHub repository URL:

```
https://github.com/your-username/my-crow-store
```

Stores are saved in `~/.crow/stores.json`:

```json
{
  "stores": [
    {
      "id": "my-store",
      "url": "https://github.com/your-username/my-crow-store",
      "enabled": true,
      "addedAt": "2026-03-12T00:00:00Z"
    }
  ]
}
```

### Removing a Store

Disable or remove a store from the Extensions panel settings. Installed add-ons from that store continue to work but won't receive updates.

## Creating a Community Store

1. Use the [crow-community-store-template](https://github.com/kh0pper/crow-community-store-template) as a starting point
2. Add your add-ons following the manifest format
3. Test each add-on locally with `crow bundle install`
4. Push to a public GitHub repository
5. Share the URL with the community

## Best Practices

- Pin Docker image versions (don't use `:latest`)
- Document all required environment variables
- Include resource requirements in the manifest
- Test on Raspberry Pi if your target audience includes ARM devices
- Keep add-ons focused — one service per add-on
