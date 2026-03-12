import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Crow',
  description: 'AI-powered research and project management platform — works with Claude, ChatGPT, Gemini, Grok, Cursor, and more',
  base: '/software/crow/',

  head: [
    ['meta', { name: 'theme-color', content: '#1d1d1f' }],
  ],

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
          { text: 'Managed Hosting', link: '/getting-started/managed-hosting' },
          { text: 'Cross-Platform Guide', link: '/guide/cross-platform' },
          { text: 'Cloud Deploy (Render)', link: '/getting-started/cloud-deploy' },
          { text: 'Desktop Setup', link: '/getting-started/desktop-setup' },
          { text: 'Docker', link: '/getting-started/docker' },
          { text: 'Full Setup (MinIO + Gateway)', link: '/getting-started/full-setup' },
          { text: 'Free Hosting Options', link: '/getting-started/free-hosting' },
          { text: 'Raspberry Pi (Crow OS)', link: '/getting-started/raspberry-pi' },
          { text: 'Tailscale Remote Access', link: '/getting-started/tailscale-setup' },
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
          { text: 'Grok (xAI)', link: '/platforms/grok' },
          { text: 'Cursor', link: '/platforms/cursor' },
          { text: 'Windsurf', link: '/platforms/windsurf' },
          { text: 'Cline', link: '/platforms/cline' },
          { text: 'Qwen Coder CLI', link: '/platforms/qwen-coder' },
          { text: 'OpenClaw', link: '/platforms/openclaw' },
        ],
      },
      {
        text: 'Integrations',
        items: [
          { text: 'All Integrations', link: '/integrations/' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'System Design', link: '/architecture/' },
          { text: 'Memory Server', link: '/architecture/memory-server' },
          { text: 'Project Server', link: '/architecture/project-server' },
          { text: 'Sharing Server', link: '/architecture/sharing-server' },
          { text: 'Storage Server', link: '/architecture/storage-server' },
          { text: 'Blog Server', link: '/architecture/blog-server' },
          { text: "Crow's Nest (Dashboard)", link: '/architecture/dashboard' },
          { text: 'Gateway', link: '/architecture/gateway' },
          { text: 'Crow OS', link: '/architecture/crow-os' },
          { text: 'Portable Identity', link: '/architecture/portable-identity' },
          { text: 'Context Management', link: '/architecture/context-management' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Cross-Platform', link: '/guide/cross-platform' },
          { text: 'Storage', link: '/guide/storage' },
          { text: 'Blog', link: '/guide/blog' },
          { text: "Crow's Nest", link: '/guide/crows-nest' },
          { text: 'Sharing', link: '/guide/sharing' },
          { text: 'Social & Messaging', link: '/guide/social' },
          { text: 'Context & Performance', link: '/guide/context-performance' },
          { text: 'Data Backends', link: '/guide/data-backends' },
          { text: 'Deployment Tiers', link: '/guide/deployment-tiers' },
          { text: 'AI Providers (BYOAI)', link: '/guide/ai-providers' },
          { text: 'Customization', link: '/guide/customization' },
        ],
      },
      {
        text: 'Developers',
        items: [
          { text: 'Developer Program', link: '/developers/' },
          { text: 'Creating Add-ons', link: '/developers/creating-addons' },
          { text: 'Add-on Registry', link: '/developers/addon-registry' },
          { text: 'Creating Panels', link: '/developers/creating-panels' },
          { text: 'Creating Servers', link: '/developers/creating-servers' },
          { text: 'Building Integrations', link: '/developers/integrations' },
          { text: 'Storage API', link: '/developers/storage-api' },
          { text: 'Writing Skills', link: '/developers/skills' },
          { text: 'Core Tools', link: '/developers/core-tools' },
          { text: 'Self-Hosted Bundles', link: '/developers/bundles' },
          { text: 'Community Directory', link: '/developers/directory' },
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
