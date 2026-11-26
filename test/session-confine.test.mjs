// Session confinement, part (a) (slashbin-ai-foreman#404): the confineSessions switch, the daemon-start
// probe and the scratch-home sweep. Offline: a fake `gh` answers the start-up token check, and a stub bwrap
// stands in for a working sandbox here. The real fence (dummy secrets unreadable through real bwrap) is
// checked by the EM's acceptance script, which runs the built module against a temp host home.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { confineStartRefusal } from "../dist/session/confine.js";
import { setStateDir, stateDir } from "../dist/state-dir.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let tmp, bin, stubLog, stub, savedState;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-confine-test-"));
  bin = join(tmp, "bin");
  mkdirSync(bin);
  // `gh api user --include`, the start-up token check, answers 200; anything else is an empty list.
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nif [ \"$1\" = api ]; then printf 'HTTP/2.0 200 OK\\n\\n{\"login\":\"fake\"}\\n'; else echo '[]'; fi\n");
  chmodSync(join(bin, "gh"), 0o755);
  // A bwrap that starts every sandbox it is asked for, and records each call.
  stubLog = join(tmp, "bwrap.log");
  stub = join(bin, "bwrap-stub");
  writeFileSync(stub, `#!/bin/sh\necho "$*" >> ${JSON.stringify(stubLog)}\nexit 0\n`);
  chmodSync(stub, 0o755);
  savedState = stateDir();
  setStateDir(join(tmp, "state"));
});

after(() => {
  setStateDir(savedState);
  rmSync(tmp, { recursive: true, force: true });
});

const homes = () => join(stateDir(), "session-homes");

function configFile(top) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    paperclip: { enabled: false }, skillSync: { enabled: false }, metrics: { enabled: false },
    ...top,
    repos: [{ name: `cf-${Math.random().toString(36).slice(2)}`, repoPath: tmp, githubRepo: "example/fake" }],
  }));
  return p;
}

test("start refuses with exit 78 when the sandbox cannot start", () => {
  const cfg = configFile({ confineSessions: true });
  const repo = JSON.parse(readFileSync(cfg, "utf8")).repos[0].name;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOREMAN_GITHUB_TOKEN: "test-fake",
    GH_TOKEN: "", GITHUB_TOKEN: "", AI_AGENT_CONFINE_BWRAP: "/nonexistent/bwrap",
    FOREMAN_STATE_DIR: join(tmp, "cli-state") };
  for (const k of Object.keys(env)) if (k.startsWith("AI_AGENT_") && k !== "AI_AGENT_CONFINE_BWRAP") delete env[k];
  // The daemon (no --once), scoped to this test's repo so its PID file is its own.
  const run = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "--config", cfg, "--repo", repo],
    { cwd: tmp, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 78, `exit ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout + run.stderr, /Refusing to start: confineSessions is on but bubblewrap \(\/nonexistent\/bwrap\) cannot start a sandbox/);
  assert.ok(!existsSync(join(root, `.agent-${repo}.pid`)), "a refused start claims no PID file");
});

test("the start gate runs in the daemon branch before the build check and the PID claim", () => {
  const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");
  const daemon = cli.slice(cli.indexOf("// Daemon mode."));
  const gate = daemon.indexOf("await confineStartRefusal(config)");
  assert.ok(gate > 0, "the daemon branch calls confineStartRefusal");
  assert.ok(gate < daemon.indexOf("buildRefusal(__dirname)") && gate < daemon.indexOf("claimPidFile("), "before buildRefusal and claimPidFile");
  assert.match(daemon.slice(gate, gate + 200), /Refusing to start: \$\{unfenced\}`\);\s*process\.exit\(78\)/);
});

test("start passes the confinement probe with a working bwrap", async () => {
  rmSync(stubLog, { force: true });
  assert.equal(await confineStartRefusal({ confineSessions: true }, { AI_AGENT_CONFINE_BWRAP: stub }), null);
  assert.equal(readFileSync(stubLog, "utf8").trim(), "--ro-bind / / -- true", "the probe asked bwrap for one sandbox");
});

test("no probe runs when confineSessions is off", async () => {
  rmSync(stubLog, { force: true });
  mkdirSync(join(homes(), "kept"), { recursive: true });
  assert.equal(await confineStartRefusal({ confineSessions: false }, { AI_AGENT_CONFINE_BWRAP: "/nonexistent/bwrap" }), null);
  assert.equal(await confineStartRefusal({ confineSessions: false }, { AI_AGENT_CONFINE_BWRAP: stub }), null);
  assert.ok(!existsSync(stubLog), "bwrap was not called");
  assert.ok(existsSync(join(homes(), "kept")), "nothing swept either");
  assert.equal(loadConfig(configFile({})).confineSessions, false, "off by default");
});

for (const name of ["HOME", "CLAUDE_CONFIG_DIR", "SSH_AUTH_SOCK"]) {
  test(`sessionEnv ${name} is refused when confineSessions is on`, () => {
    assert.throws(() => loadConfig(configFile({ confineSessions: true, sessionEnv: ["LANG", name] })),
      new RegExp(`sessionEnv must not name "${name}" while confineSessions is on`));
  });
}

test("the same sessionEnv loads when confineSessions is off", () => {
  const sessionEnv = ["LANG", "HOME", "CLAUDE_CONFIG_DIR", "SSH_AUTH_SOCK"];
  const config = loadConfig(configFile({ confineSessions: false, sessionEnv }));
  assert.equal(config.confineSessions, false);
  assert.deepEqual(config.sessionEnv, sessionEnv);
});

test("AI_AGENT_CONFINE_SESSIONS overrides the file, and a value that is not a boolean stops the load", () => {
  const saved = process.env.AI_AGENT_CONFINE_SESSIONS;
  try {
    process.env.AI_AGENT_CONFINE_SESSIONS = "true";
    assert.equal(loadConfig(configFile({ confineSessions: false })).confineSessions, true);
    process.env.AI_AGENT_CONFINE_SESSIONS = "off";
    assert.equal(loadConfig(configFile({ confineSessions: true })).confineSessions, false);
    process.env.AI_AGENT_CONFINE_SESSIONS = "ture";
    assert.throws(() => loadConfig(configFile({})), /confineSessions/);
  } finally {
    if (saved === undefined) delete process.env.AI_AGENT_CONFINE_SESSIONS;
    else process.env.AI_AGENT_CONFINE_SESSIONS = saved;
  }
});

test("daemon start sweeps leftover session homes", async () => {
  mkdirSync(join(homes(), "s-crashed", ".claude"), { recursive: true });
  writeFileSync(join(homes(), "s-crashed", ".claude", "x.jsonl"), "{}");
  assert.equal(await confineStartRefusal({ confineSessions: true }, { AI_AGENT_CONFINE_BWRAP: stub }), null);
  assert.ok(!existsSync(homes()), "the stranded home is gone");
});
