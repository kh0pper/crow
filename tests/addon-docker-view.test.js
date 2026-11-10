/**
 * The docker snapshot the add-on wall reads: published ports, container
 * addresses, bridge ranges, and which compose project belongs to which add-on.
 *
 * Everything here is a fake `run`: the fixtures are the JSON a `docker ps` /
 * `docker inspect` / `docker network …` pair answers with, so no rule depends
 * on the machine running the suite. The home paths are fixtures that do not
 * exist, so the path comparison falls back to the raw label value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDockerView } from "../scripts/addon-sandbox/docker-view.mjs";

const HOME = "/home/alex/.crow";
const APP = "/home/alex/crow";
const OTHER = "/home/alex/.crow-other";

const labels = (project, workingDir) => ({
  ...(project ? { "com.docker.compose.project": project } : {}),
  ...(workingDir ? { "com.docker.compose.project.working_dir": workingDir } : {}),
});

/** One `docker inspect` container entry. */
const containerEntry = ({ id, name, project, workingDir, v4, v6, ports }) => ({
  Id: id,
  Name: "/" + name,
  Config: { Labels: labels(project, workingDir) },
  NetworkSettings: {
    Ports: ports || {},
    Networks: { bridge: { IPAddress: v4 || "", GlobalIPv6Address: v6 || "" } },
  },
});

const INSPECT = [
  containerEntry({
    id: "c1", name: "media-app", project: "home-media", workingDir: HOME + "/bundles/media", v4: "172.18.0.5",
    ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "18000" }], "9000/udp": [{ HostIp: "0.0.0.0", HostPort: "19000" }] },
  }),
  containerEntry({
    id: "c2", name: "installed-one", project: "app-installed", workingDir: APP + "/bundles/installed-one", v4: "172.18.0.6",
    ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }, { HostIp: "::", HostPort: "8081" }] },
  }),
  containerEntry({
    id: "c3", name: "missing-one", project: "app-missing", workingDir: APP + "/bundles/missing-one", v4: "172.18.0.7",
  }),
  containerEntry({
    id: "c4", name: "kiosk", project: "other-kiosk", workingDir: OTHER + "/bundles/kiosk", v4: "", v6: "fd00:1234::9",
  }),
  containerEntry({
    id: "c5", name: "checkout", project: "repo-checkout", workingDir: "/srv/app", v4: "172.18.0.8",
  }),
  containerEntry({
    id: "c6", name: "conflict-a", project: "two-owners", workingDir: HOME + "/bundles/alpha", v4: "172.18.0.9",
  }),
  containerEntry({
    id: "c7", name: "conflict-b", project: "two-owners", workingDir: OTHER + "/bundles/beta", v4: "172.18.0.10",
  }),
  containerEntry({
    id: "c8", name: "no-labels", project: "", workingDir: HOME + "/bundles/media", v4: "172.18.0.11",
  }),
];

const NETWORKS = [
  { Name: "bridge", Driver: "bridge", IPAM: { Config: [{ Subnet: "172.18.0.0/16" }, { Subnet: "fd00:1234::/64" }] } },
  { Name: "host", Driver: "host", IPAM: { Config: [{ Subnet: "172.19.0.0/16" }] } },
  { Name: "none", Driver: "null", IPAM: { Config: [] } },
];

/** A fake docker: the four reads the snapshot makes, from fixtures. */
function fakeRun({ ps = INSPECT.map((c) => c.Id), inspect = INSPECT, netLs = ["n1", "n2", "n3"], networks = NETWORKS } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const [verb, ...rest] = args;
    if (verb === "ps") return ps.join("\n") + (ps.length ? "\n" : "");
    if (verb === "inspect") return JSON.stringify(inspect);
    if (verb === "network" && rest[0] === "ls") return netLs.join("\n") + (netLs.length ? "\n" : "");
    if (verb === "network" && rest[0] === "inspect") return JSON.stringify(networks);
    throw new Error("unexpected docker call: " + args.join(" "));
  };
  return { run, calls };
}

const viewOf = (over = {}) => {
  const { run, calls } = fakeRun(over.run || {});
  const view = createDockerView({
    run, ttlMs: 5000, ownHome: HOME, appRoot: APP, otherHomes: [OTHER],
    installedIds: () => new Set(["installed-one"]), ...over.options,
  });
  return { view, calls };
};

test("a snapshot holds published tcp ports, container addresses and bridge subnets", async () => {
  const { view, calls } = viewOf();
  const s = await view.snapshot();
  assert.deepEqual(calls, [["ps", "-q", "--no-trunc"], ["inspect", ...INSPECT.map((c) => c.Id)],
    ["network", "ls", "-q", "--no-trunc"], ["network", "inspect", "n1", "n2", "n3"]]);

  const byProject = (p) => s.publishes.filter((e) => e.project === p);
  assert.deepEqual(byProject("home-media"), [{ hostIp: "127.0.0.1", hostPort: 18000, project: "home-media" }], "udp is not a published tcp port");
  assert.deepEqual(byProject("app-installed"), [
    { hostIp: "0.0.0.0", hostPort: 8080, project: "app-installed" },
    { hostIp: "::", hostPort: 8081, project: "app-installed" },
  ]);
  assert.deepEqual(s.publishes.filter((e) => e.hostPort === 19000), []);

  const media = s.containers.find((c) => c.id === "c1");
  assert.deepEqual([media.name, media.project, media.ips], ["/media-app", "home-media", ["172.18.0.5"]]);
  assert.deepEqual(s.containers.find((c) => c.id === "c4").ips, ["fd00:1234::9"]);
  assert.deepEqual(s.containers.find((c) => c.id === "c5").ips, ["172.18.0.8"]);

  assert.deepEqual(s.subnets, ["172.18.0.0/16", "fd00:1234::/64"], "only bridge networks name ranges");
});

test("a compose project belongs to the add-on its working_dir names", async () => {
  const { view } = viewOf();
  const s = await view.snapshot();
  assert.equal(s.addonProjects.get("home-media"), "media");
  assert.equal(s.addonProjects.get("app-installed"), "installed-one");
  assert.equal(s.addonProjects.get("app-missing"), undefined, "an app-root bundle that is not installed has no owner");
  assert.equal(s.addonProjects.get("other-kiosk"), "other-instance:kiosk");
  assert.equal(s.addonProjects.get("repo-checkout"), undefined, "a working dir outside every bundles folder has no owner");
  assert.equal(s.addonProjects.get("two-owners"), undefined, "a project with two owners has no owner at all");
  assert.equal(s.addonProjects.size, 3, "no placeholder value stands in for an owner");
  assert.equal(s.addonProjects.get(""), undefined, "no project label is not a project");
  // A container of a project whose folder is an add-on's: the owner is the id.
  const nested = containerEntry({ id: "c9", name: "nested", project: "sub", workingDir: HOME + "/bundles/kiosk/sub/dir" });
  const { view: v2 } = viewOf({ run: { inspect: [...INSPECT, nested] } });
  assert.equal((await v2.snapshot()).addonProjects.get("sub"), "kiosk");
});

test("a working_dir with no usable bundle id, and an unreadable installed list, give no owner", async () => {
  const odd = [
    containerEntry({ id: "d1", name: "dots", project: "p1", workingDir: HOME + "/bundles/../etc" }),
    containerEntry({ id: "d2", name: "caps", project: "p2", workingDir: HOME + "/bundles/Kiosk" }),
    containerEntry({ id: "d3", name: "empty", project: "p3", workingDir: HOME + "/bundles/" }),
    containerEntry({ id: "d4", name: "root", project: "p4", workingDir: APP + "/bundles/installed-one" }),
  ];
  const { view } = viewOf({
    run: { inspect: odd },
    options: { installedIds: () => { throw new Error("installed.json is gone"); } },
  });
  const s = await view.snapshot();
  assert.equal(s.addonProjects.size, 0);
});

test("two snapshot calls inside the window run docker once, and one after it again", async () => {
  let clock = 1000;
  const { view, calls } = viewOf({ options: { ttlMs: 500, now: () => clock } });
  await view.snapshot();
  const first = calls.length;
  clock = 1400;
  await view.snapshot();
  assert.equal(calls.length, first, "the second answer came from the snapshot");
  clock = 1600;
  await view.snapshot();
  assert.ok(calls.length > first, "past the window docker is asked again");
});

test("a failed read rejects and is not remembered", async () => {
  let fail = true;
  const { run, calls } = fakeRun();
  const flaky = async (args) => { if (fail) throw new Error("docker socket gone"); return run(args); };
  const view = createDockerView({
    run: flaky, ttlMs: 5000, ownHome: HOME, appRoot: APP, installedIds: () => new Set(["installed-one"]),
  });
  await assert.rejects(() => view.snapshot(), /docker socket gone/);
  const before = calls.length;
  fail = false;
  const s = await view.snapshot();
  assert.ok(calls.length > before, "the next call reads again");
  assert.equal(s.addonProjects.get("home-media"), "media");
});

test("no containers means no docker inspect", async () => {
  const { view, calls } = viewOf({ run: { ps: [], netLs: [] } });
  const s = await view.snapshot();
  assert.deepEqual(s.publishes, []);
  assert.deepEqual(s.containers, []);
  assert.deepEqual(s.subnets, []);
  assert.equal(s.addonProjects.size, 0);
  assert.deepEqual(calls, [["ps", "-q", "--no-trunc"], ["network", "ls", "-q", "--no-trunc"]]);
});
test("a project that mixes an add-on's container with one from elsewhere is left out of the map", async () => {
  const inspected = [
    { Id: "a", Name: "/x-1", Config: { Labels: { "com.docker.compose.project": "mixed", "com.docker.compose.project.working_dir": "/home/alex/.crow/bundles/paperless" } }, NetworkSettings: { Networks: {}, Ports: {} } },
    { Id: "b", Name: "/x-2", Config: { Labels: { "com.docker.compose.project": "mixed", "com.docker.compose.project.working_dir": "/home/alex/elsewhere" } }, NetworkSettings: { Networks: {}, Ports: {} } },
  ];
  const run = async (args) => {
    if (args[0] === "ps") return "a\nb\n";
    if (args[0] === "inspect") return JSON.stringify(inspected);
    if (args[0] === "network" && args[1] === "ls") return "";
    throw new Error("unexpected " + args.join(" "));
  };
  const view = createDockerView({ run, ownHome: "/home/alex/.crow", appRoot: "/home/alex/crow" });
  const snap = await view.snapshot();
  assert.equal(snap.addonProjects.has("mixed"), false, "a project of two owners belongs to no add-on");
});

test("concurrent snapshot calls share one docker read sequence", async () => {
  const { run, calls } = fakeRun();
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = async (args) => { await gate; return run(args); };
  const view = createDockerView({ run: slow, ttlMs: 0, ownHome: HOME, appRoot: APP });

  const calls3 = [view.snapshot(), view.snapshot(), view.snapshot()];
  release();
  const answers = await Promise.all(calls3);

  assert.deepEqual(calls, [
    ["ps", "-q", "--no-trunc"],
    ["inspect", ...INSPECT.map((c) => c.Id)],
    ["network", "ls", "-q", "--no-trunc"],
    ["network", "inspect", "n1", "n2", "n3"],
  ], "one docker sequence for the whole burst");
  assert.equal(answers[0], answers[1]);
  assert.equal(answers[1], answers[2]);
});
