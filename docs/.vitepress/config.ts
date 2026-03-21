import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Crow',
  description: 'AI-powered research and project management platform — works with Claude, ChatGPT, Gemini, Grok, Cursor, and more',
  base: '/software/crow/',

  srcExclude: ['superpowers/**'],

  head: [
    ['meta', { name: 'theme-color', content: '#1d1d1f' }],
  ],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
    },
    es: {
      label: 'Español',
      lang: 'es',
      themeConfig: {
        nav: [
          { text: 'Primeros Pasos', link: '/es/getting-started/' },
        ],
        sidebar: [
          {
            text: 'Primeros Pasos',
            items: [
              { text: 'Descripción General', link: '/es/getting-started/' },
              { text: 'Oracle Cloud Nivel Gratuito', link: '/es/getting-started/oracle-cloud' },
              { text: 'Google Cloud Nivel Gratuito', link: '/es/getting-started/google-cloud' },
              { text: 'Servidor en Casa', link: '/es/getting-started/home-server' },
              { text: 'Instalación de Escritorio', link: '/es/getting-started/desktop-install' },
              { text: 'Hosting Administrado', link: '/es/getting-started/managed-hosting' },
            ],
          },
          {
            text: 'Guías',
            items: [
              { text: 'Uso de Skills', link: '/es/guide/skills' },
              { text: 'Compartir', link: '/es/guide/sharing' },
              { text: 'Blog', link: '/es/guide/blog' },
              { text: 'Cancionero', link: '/es/guide/songbook' },
              { text: 'Multi-Instancia', link: '/es/guide/instances' },
              { text: 'Panel de Datos', link: '/es/guide/data-dashboard' },
              { text: 'Contactos', link: '/es/guide/contacts' },
            ],
          },
          {
            text: 'Plataformas',
            items: [
              { text: 'Claude Web y Móvil', link: '/es/platforms/claude' },
              { text: 'ChatGPT', link: '/es/platforms/chatgpt' },
              { text: 'Claude Code (CLI)', link: '/es/platforms/claude-code' },
              { text: 'Aplicacion Android', link: '/es/platforms/android' },
            ],
          },
          {
            text: 'Integraciones',
            items: [
              { text: 'Jellyfin', link: '/es/integrations/jellyfin' },
              { text: 'Plex', link: '/es/integrations/plex' },
              { text: 'IPTV', link: '/es/integrations/iptv' },
              { text: 'Kodi', link: '/es/integrations/kodi' },
              { text: 'TriliumNext', link: '/es/integrations/trilium' },
            ],
          },
        ],
      },
    },
  },

  themeConfig: {
    nav: [
      { text: 'Getting Started', link: '/getting-started/' },
      { text: 'Platforms', link: '/platforms/' },
      { text: 'Integrations', link: '/integrations/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'Developers', link: '/developers/' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/getting-started/' },
          { text: 'Oracle Cloud Free Tier', link: '/getting-started/oracle-cloud' },
          { text: 'Google Cloud Free Tier', link: '/getting-started/google-cloud' },
          { text: 'Home Server', link: '/getting-started/home-server' },
          { text: 'Desktop Install', link: '/getting-started/desktop-install' },
          { text: 'Managed Hosting', link: '/getting-started/managed-hosting' },
          { text: 'Tailscale Remote Access', link: '/getting-started/tailscale-setup' },
          { text: 'Custom Domain', link: '/getting-started/custom-domain' },
          { text: 'Docker', link: '/getting-started/docker' },
          { text: 'Free Hosting Comparison', link: '/getting-started/free-hosting' },
          { text: 'Cloud Deploy (Legacy)', link: '/getting-started/cloud-deploy' },
          { text: 'Cross-Platform Guide', link: '/guide/cross-platform' },
          { text: 'Desktop Setup (Claude Desktop)', link: '/getting-started/desktop-setup' },
          { text: 'Full Setup (MinIO + Gateway)', link: '/getting-started/full-setup' },
          { text: 'Raspberry Pi (Crow OS)', link: '/getting-started/raspberry-pi' },
          { text: 'Multi-Device Quick Start', link: '/getting-started/multi-device' },
        ],
      },
      {
        text: 'Platforms',
        items: [
          { text: 'Compatibility', link: '/platforms/' },
          { text: 'Claude Web & Mobile', link: '/platforms/claude' },
          { text: 'Claude Desktop', link: '/platforms/claude-desktop' },
          { text: 'Claude Code (CLI)', link: '/platforms/claude-code' },
          { text: 'ChatGPT', link: '/platforms/chatgpt' },
          { text: 'Gemini', link: '/platforms/gemini' },
          { text: 'Gemini CLI', link: '/platforms/gemini-cli' },
          { text: 'Grok (xAI)', link: '/platforms/grok' },
          { text: 'Cursor', link: '/platforms/cursor' },
          { text: 'Windsurf', link: '/platforms/windsurf' },
          { text: 'Cline', link: '/platforms/cline' },
          { text: 'Qwen CLI', link: '/platforms/qwen-cli' },
          { text: 'Qwen Coder CLI', link: '/platforms/qwen-coder' },
          { text: 'OpenClaw', link: '/platforms/openclaw' },
          { text: 'Android App', link: '/platforms/android' },
        ],
      },
      {
        text: 'Integrations',
        items: [
          { text: 'All Integrations', link: '/integrations/' },
          { text: 'GitHub', link: '/integrations/github' },
          { text: 'Brave Search', link: '/integrations/brave-search' },
          { text: 'Slack', link: '/integrations/slack' },
          { text: 'Notion', link: '/integrations/notion' },
          { text: 'Trello', link: '/integrations/trello' },
          { text: 'Discord', link: '/integrations/discord' },
          { text: 'Google Workspace', link: '/integrations/google-workspace' },
          { text: 'Canvas LMS', link: '/integrations/canvas-lms' },
          { text: 'Microsoft Teams', link: '/integrations/microsoft-teams' },
          { text: 'Zotero', link: '/integrations/zotero' },
          { text: 'Home Assistant', link: '/integrations/home-assistant' },
          { text: 'Obsidian', link: '/integrations/obsidian' },
          { text: 'Render', link: '/integrations/render' },
          { text: 'Jellyfin', link: '/integrations/jellyfin' },
          { text: 'Plex', link: '/integrations/plex' },
          { text: 'IPTV', link: '/integrations/iptv' },
          { text: 'Kodi', link: '/integrations/kodi' },
          { text: 'TriliumNext', link: '/integrations/trilium' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'System Design', link: '/architecture/' },
          { text: 'Memory Server', link: '/architecture/memory-server' },
          { text: 'Project Server', link: '/architecture/project-server' },
          { text: 'Sharing Server', link: '/architecture/sharing-server' },
          { text: 'Relay Protocol', link: '/architecture/relay-protocol' },
          { text: 'Storage Server', link: '/architecture/storage-server' },
          { text: 'Blog Server', link: '/architecture/blog-server' },
          { text: 'Songbook', link: '/architecture/songbook' },
          { text: "Crow's Nest", link: '/architecture/dashboard' },
          { text: 'Gateway', link: '/architecture/gateway' },
          { text: 'Crow OS', link: '/architecture/crow-os' },
          { text: 'Portable Identity', link: '/architecture/portable-identity' },
          { text: 'Context Management', link: '/architecture/context-management' },
          { text: 'Multi-Instance Sync', link: '/architecture/instances' },
          { text: 'Data Dashboard', link: '/architecture/data-dashboard' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Using Skills', link: '/guide/skills' },
          { text: 'Cross-Platform', link: '/guide/cross-platform' },
          { text: 'Integration Overview', link: '/guide/integration-overview' },
          { text: 'Storage', link: '/guide/storage' },
          { text: 'Blog', link: '/guide/blog' },
          { text: 'Podcast', link: '/guide/podcast' },
          { text: 'Songbook', link: '/guide/songbook' },
          { text: 'Blog Discovery', link: '/guide/blog-discovery' },
          { text: "Crow's Nest", link: '/guide/crows-nest' },
          { text: 'Home Screen', link: '/guide/home-screen' },
          { text: 'Sharing', link: '/guide/sharing' },
          { text: 'Relays', link: '/guide/relays' },
          { text: 'Social & Messaging', link: '/guide/social' },
          { text: 'Contact Discovery', link: '/guide/contact-discovery' },
          { text: 'OpenClaw Bridge', link: '/guide/openclaw-bridge' },
          { text: 'Context & Performance', link: '/guide/context-performance' },
          { text: 'Data Backends', link: '/guide/data-backends' },
          { text: 'Deployment Tiers', link: '/guide/deployment-tiers' },
          { text: 'AI Providers (BYOAI)', link: '/guide/ai-providers' },
          { text: 'DashScope Coding Plan', link: '/guide/dashscope-coding' },
          { text: 'Z.AI Coding Plan', link: '/guide/zai-coding' },
          { text: 'Citations & Verification', link: '/guide/citations' },
          { text: 'Ideation', link: '/guide/ideation' },
          { text: 'Customization', link: '/guide/customization' },
          { text: 'Brand & Design', link: '/guide/brand' },
          { text: 'Scheduling', link: '/guide/scheduling' },
          { text: 'Extensions', link: '/guide/extensions' },
          { text: 'Tax Filing Assistant', link: '/guide/tax-filing' },
          { text: 'Browser Automation', link: '/guide/browser-automation' },
          { text: 'Multi-Instance Chaining', link: '/guide/instances' },
          { text: 'Data Dashboard', link: '/guide/data-dashboard' },
          { text: 'Data Sharing', link: '/guide/data-sharing' },
          { text: 'Contacts', link: '/guide/contacts' },
        ],
      },
      {
        text: 'Developers',
        items: [
          { text: 'Developer Program', link: '/developers/' },
          { text: 'Creating Add-ons', link: '/developers/creating-addons' },
          { text: 'Add-on Registry', link: '/developers/addon-registry' },
          { text: 'Community Stores', link: '/developers/community-stores' },
          { text: 'Platform Capabilities', link: '/developers/platform-capabilities' },
          { text: 'Creating Panels', link: '/developers/creating-panels' },
          { text: 'Creating Servers', link: '/developers/creating-servers' },
          { text: 'Building Integrations', link: '/developers/integrations' },
          { text: 'Storage API', link: '/developers/storage-api' },
          { text: 'Writing Skills', link: '/developers/skills' },
          { text: 'Core Tools', link: '/developers/core-tools' },
          { text: 'Self-Hosted Bundles', link: '/developers/bundles' },
          { text: 'Community Directory', link: '/developers/directory' },
          { text: 'Data Dashboard Dev', link: '/developers/data-dashboard' },
          { text: 'Nominatim GIS Dev', link: '/developers/nominatim' },
        ],
      },
      {
        text: 'Skills',
        items: [
          { text: 'Overview', link: '/skills/' },
        ],
      },
      {
        text: 'Roadmap',
        items: [
          { text: 'Roadmap', link: '/roadmap' },
        ],
      },
      {
        text: 'Showcase',
        items: [
          { text: 'Showcase', link: '/showcase' },
        ],
      },
      {
        text: 'Legal',
        items: [
          { text: 'Managed Hosting Terms', link: '/legal/managed-hosting-terms' },
        ],
      },
      {
        text: 'Help',
        items: [
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/kh0pper/crow' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the MIT License.',
    },
  },
})
