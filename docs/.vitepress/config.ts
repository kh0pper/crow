import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Crow AI Platform',
  description: 'AI-powered research and project management platform — works with Claude, ChatGPT, Gemini, Grok, Cursor, and more',
  base: '/crow/',

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
          { text: 'Cross-Platform Guide', link: '/guide/cross-platform' },
          { text: 'Cloud Deploy (Render)', link: '/getting-started/cloud-deploy' },
          { text: 'Desktop Setup', link: '/getting-started/desktop-setup' },
          { text: 'Docker', link: '/getting-started/docker' },
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
          { text: 'Research Server', link: '/architecture/research-server' },
          { text: 'Sharing Server', link: '/architecture/sharing-server' },
          { text: 'Gateway', link: '/architecture/gateway' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Cross-Platform', link: '/guide/cross-platform' },
          { text: 'Sharing', link: '/guide/sharing' },
          { text: 'Social & Messaging', link: '/guide/social' },
        ],
      },
      {
        text: 'Developers',
        items: [
          { text: 'Developer Program', link: '/developers/' },
          { text: 'Building Integrations', link: '/developers/integrations' },
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
