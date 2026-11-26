// Session confinement, part (b) (slashbin-ai-foreman#404): with `confine` on, the session spawn goes through
// bubblewrap with a scratch home that pushes over HTTPS. A stub bwrap checks the wiring anywhere; the real-fence
// test runs a fake `claude` inside real bubblewrap and is skipped on a host where bwrap cannot start a sandbox.
// Every token here is a dummy; nothing reaches GitHub (the credential helper is asked, never used).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnClaudeWithOptions } from "../dist/session/runner.js";
import { buildSessionEnv } from "../dist/session/env.js";
import { confineProblems, writeSessionGitConfig } from "../dist/session/confine.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { setStateDir, stateDir } from "../dist/state-dir.js";

const DUMMY_TOKEN = "dummy-session-token-0000";
let tmp, hostHome, bin, repo, savedState, savedEnv, rt;

const logger = () => {
  const lines = [];
  const at = (lvl) => (m) => lines.push(`${lvl} ${m}`);
  return { lines, logger: { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") } };
};

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "foreman-confine-spawn-")));
  // A host home holding what a fenced session must never see, and the global identity it must carry in.
  hostHome = join(tmp, "host-home");
  mkdirSync(join(hostHome, ".ssh"), { recursive: true });
  writeFileSync(join(hostHome, ".ssh", "id_ed25519"), "dummy key\n");
  writeFileSync(join(hostHome, ".gitconfig"), "[user]\n\tname = Fence Test\n\temail = fence@example.invalid\n");
  bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  repo = join(tmp, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:example/fenced.git"]);
  savedState = stateDir();
  setStateDir(join(tmp, "state"));
  savedEnv = { ...process.env };
});

after(() => {
  setStateDir(savedState);
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv, { HOME: hostHome, PATH: `${bin}:${savedEnv.PATH}`, SSH_AUTH_SOCK: "/run/dummy-agent.sock" });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.AI_AGENT_CONFINE_BWRAP;
  delete process.env.GIT_CONFIG_GLOBAL;
  rt = new ForemanRuntime();
  rt.trust.configure({ enabled: true });
});

const opts = (extra = {}) => ({
  trust: rt.trust,
  cwd: repo,
  sessionEnv: [],
  ghToken: DUMMY_TOKEN,
  triggerLabel: "approved",
  lifecycleLabels: {},
  allowedTools: [],
  maxTurns: 1,
  maxDurationMs: 30_000,
  ...extra,
});

const homes = () => {
  const d = join(stateDir(), "session-homes");
  return existsSync(d) ? readdirSync(d) : [];
};

/** A fake `claude` that reports, as one JSON line, what a session in its place can see and do. */
const writeReporter = () => {
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("fs"); const { execFileSync } = require("child_process");
const git = (args, input) => { try { return execFileSync("git", args, { input, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim(); } catch { return null; } };
const home = process.env.HOME;
const cred = git(["credential", "fill"], "protocol=https\\nhost=github.com\\n\\n") ?? "";
let trust = null; try { trust = JSON.parse(fs.readFileSync(home + "/.claude.json", "utf8")).projects?.[process.cwd()] ?? null; } catch {}
process.stdout.write(JSON.stringify({
  ssh: fs.existsSync(home + "/.ssh/id_ed25519"),
  pushUrl: git(["remote", "get-url", "--push", "origin"]),
  credUser: (cred.match(/^username=(.*)$/m) || [])[1] ?? null,
  credIsSessionToken: (cred.match(/^password=(.*)$/m) || [])[1] === process.env.GH_TOKEN,
  name: git(["config", "user.name"]), email: git(["config", "user.email"]),
  agentSock: process.env.SSH_AUTH_SOCK ?? null, trust,
}) + "\\n");
`);
  chmodSync(join(bin, "claude"), 0o755);
};

test("env: a fenced session drops the agent socket, runtime folder and TMPDIR and keeps HOME; unfenced keeps them", () => {
  process.env.XDG_RUNTIME_DIR = "/run/user/dummy";
  process.env.TMPDIR = "/tmp/dummy";
  const fenced = buildSessionEnv(opts({ confine: true }));
  for (const n of ["SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "TMPDIR"]) assert.equal(n in fenced, false, n);
  assert.equal(fenced.HOME, hostHome);
  assert.equal(fenced.GH_TOKEN, DUMMY_TOKEN);
  const open = buildSessionEnv(opts());
  assert.equal(open.SSH_AUTH_SOCK, "/run/dummy-agent.sock");
  assert.equal(open.TMPDIR, "/tmp/dummy");
});

test("gitconfig: host identity, both GitHub SSH forms rewritten, the token helper the only one for github", async () => {
  const home = mkdtempSync(join(tmp, "gc-"));
  await writeSessionGitConfig(home);
  const get = (...a) => execFileSync("git", ["config", "--file", join(home, ".gitconfig"), ...a], { encoding: "utf8" }).trim();
  assert.equal(get("--get", "user.name"), "Fence Test");
  assert.equal(get("--get", "user.email"), "fence@example.invalid");
  assert.deepEqual(get("--get-all", "url.https://github.com/.insteadOf").split("\n"), ["git@github.com:", "ssh://git@github.com/"]);
  const helpers = execFileSync("git", ["config", "--file", join(home, ".gitconfig"), "--get-all", "credential.https://github.com.helper"],
    { encoding: "utf8" }).replace(/\n$/, "").split("\n");
  assert.equal(helpers.length, 2);
  assert.equal(helpers[0], "", "the empty first value resets any helper named before it");
  assert.match(helpers[1], /^!f\(\) .*password=\$GH_TOKEN/);
  assert.equal(readFileSync(join(home, ".gitconfig"), "utf8").includes(DUMMY_TOKEN), false, "the token is never written");
});

test("gitconfig: offline, the scratch home pushes an SSH remote over HTTPS with the session token", async () => {
  const home = mkdtempSync(join(tmp, "gc-"));
  await writeSessionGitConfig(home);
  const env = { ...process.env, HOME: home, GH_TOKEN: DUMMY_TOKEN, GIT_TERMINAL_PROMPT: "0" };
  delete env.SSH_AUTH_SOCK;
  assert.equal(execFileSync("git", ["-C", repo, "remote", "get-url", "--push", "origin"], { env, encoding: "utf8" }).trim(),
    "https://github.com/example/fenced.git");
  const cred = execFileSync("git", ["credential", "fill"], { env, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  assert.match(cred, /^username=x-access-token$/m);
  assert.equal(cred.match(/^password=(.*)$/m)?.[1], DUMMY_TOKEN);
});

test("spawn: confined, bwrap starts claude with its args in a scratch home that is gone afterwards", async () => {
  // A bwrap stub: records its argv and env, and what the scratch home held when the session started.
  const out = join(tmp, "stub.json");
  const stub = join(bin, "bwrap-stub");
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2);
const i = a.indexOf("--bind"); const home = a[i + 1];
let gitconfig = null, trust = null;
try { gitconfig = fs.readFileSync(home + "/.gitconfig", "utf8"); } catch {}
try { trust = JSON.parse(fs.readFileSync(home + "/.claude.json", "utf8")).projects?.[${JSON.stringify(repo)}] ?? null; } catch {}
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: a, home, gitconfig, trust, agentSock: process.env.SSH_AUTH_SOCK ?? null }));
`);
  chmodSync(stub, 0o755);
  writeReporter();
  process.env.AI_AGENT_CONFINE_BWRAP = stub;
  const { logger: log } = logger();
  const r = await spawnClaudeWithOptions("hello", opts({ confine: true }), log);
  assert.equal(r.exitCode, 0, r.stderr);
  const seen = JSON.parse(readFileSync(out, "utf8"));
  const sep = seen.args.indexOf("--");
  assert.ok(sep > 0, "a `--` separates the fence from the command");
  assert.equal(seen.args[sep + 1], join(bin, "claude"));
  assert.deepEqual(seen.args.slice(sep + 2, sep + 4), ["--print", seen.args[sep + 3]]);
  assert.ok(seen.args.includes("--dangerously-skip-permissions"));
  assert.deepEqual(seen.args.slice(seen.args.indexOf("--bind"), seen.args.indexOf("--bind") + 3), ["--bind", seen.home, hostHome]);
  assert.match(seen.gitconfig, /insteadOf = git@github.com:/);
  assert.deepEqual(seen.trust, { hasTrustDialogAccepted: true }, "trust is written to the scratch home");
  assert.equal(seen.agentSock, null);
  assert.equal(existsSync(seen.home), false, "the scratch home is removed when the session ends");
  assert.deepEqual(homes(), []);
  assert.equal(existsSync(join(hostHome, ".claude.json")), false, "the host home's Claude config is not touched");
});

test("spawn: a bwrap that cannot start fails the session and still removes the scratch home", async () => {
  writeReporter();
  process.env.AI_AGENT_CONFINE_BWRAP = join(tmp, "no-such-bwrap");
  const { logger: log } = logger();
  const r = await spawnClaudeWithOptions("hello", opts({ confine: true }), log);
  assert.equal(r.exitCode, -1);
  assert.equal(r.stdout, "", "claude never ran open");
  assert.deepEqual(homes(), []);
});

test("spawn: unconfined is unchanged: claude starts directly with the host home and agent socket", async () => {
  writeReporter();
  process.env.AI_AGENT_CONFINE_BWRAP = join(tmp, "no-such-bwrap");
  const { logger: log } = logger();
  const r = await spawnClaudeWithOptions("hello", opts(), log);
  assert.equal(r.exitCode, 0, r.stderr);
  const seen = JSON.parse(r.stdout.trim());
  assert.equal(seen.ssh, true);
  assert.equal(seen.agentSock, "/run/dummy-agent.sock");
  assert.equal(seen.pushUrl, "git@github.com:example/fenced.git");
  assert.deepEqual(homes(), []);
});

test("real fence: no host SSH key or agent, push URL is HTTPS, the token answers git, identity and trust carried in", async (t) => {
  if ((await confineProblems({ bwrap: "bwrap" })).length) return t.skip("bubblewrap cannot start a sandbox on this host");
  writeReporter();
  const { logger: log } = logger();
  const r = await spawnClaudeWithOptions("hello", opts({ confine: true }), log);
  assert.equal(r.exitCode, 0, r.stderr);
  const seen = JSON.parse(r.stdout.trim());
  assert.deepEqual(seen, {
    ssh: false,
    pushUrl: "https://github.com/example/fenced.git",
    credUser: "x-access-token",
    credIsSessionToken: true,
    name: "Fence Test",
    email: "fence@example.invalid",
    agentSock: null,
    trust: { hasTrustDialogAccepted: true },
  });
  assert.deepEqual(homes(), []);
});
