// The fixed renderLayout options behind classic-layout-snapshot.html. The
// snapshot was captured from main's renderLayout BEFORE the shell variant
// landed; the test re-renders these options and compares byte for byte
// (with the one added crow-mode meta line removed).
export const CLASSIC_OPTS = {
  title: "Snapshot <Page>",
  content: '<section id="snap-content"><p>Body &amp; text</p></section>',
  activePanel: "memory",
  panels: [
    { id: "nest", name: "Crow's Nest", icon: "health", route: "/dashboard/nest", navOrder: 1 },
    { id: "memory", name: "Memory", icon: "memory", route: "/dashboard/memory", navOrder: 2, preload: true },
    { id: "custom", name: "Custom Panel", icon: "unknown-icon", route: "/dashboard/custom", navOrder: 3 },
  ],
  navGroups: [
    { id: "core", name: "Core", panels: [
      { id: "nest", name: "Crow's Nest", icon: "health", route: "/dashboard/nest" },
      { id: "memory", name: "Memory", icon: "memory", route: "/dashboard/memory", preload: true },
    ] },
    { id: "extras", name: "Extras", collapsed: true, panels: [
      { id: "custom", name: "Custom Panel", icon: "unknown-icon", route: "/dashboard/custom" },
    ] },
  ],
  scripts: "window.__snapScript = 1;",
  afterContent: '<div id="crow-player-bar" data-turbo-permanent></div>',
  headerIcons: '<button id="crow-tama" class="snap-bird">bird</button>',
  lang: "es",
  instanceTabs: [
    { id: "local", name: "Crow", status: "online", isLocal: true },
    { id: "peer1", name: "Peer <One>", status: "offline", isLocal: false },
  ],
  head: '<meta name="snap-head" content="1">',
};
