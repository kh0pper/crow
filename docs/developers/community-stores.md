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
| Volume mounts | Named volumes + allowlisted paths | Named volumes only |
| Privileged mode | Case-by-case | Never allowed |

### Compose File Validation

Before installing a community add-on, Crow validates the `docker-compose.yml`:

- **Rejected**: mounts to `/`, `/etc`, `~/.ssh`, `~/.crow/data`, or any host path outside `~/.crow/bundles/<id>/data`
- **Rejected**: `privileged: true`
- **Rejected**: `NET_ADMIN` or `SYS_ADMIN` capabilities
- **Allowed**: named Docker volumes, `~/.crow/bundles/<id>/data`

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
