// Session confinement mount plan (slashbin-ai-foreman#404, review of PR #409), through real bubblewrap: another
// session's scratch home is masked where a checkout exposes it, a linked worktree's git works inside the fence,
// and a read-only file inside the writable checkout stays read-only. Skipped where bwrap cannot start a sandbox.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confineCommand, confineProblems, createSessionHome, worktreeGitDirs } from "../dist/session/confine.js";
import { setStateDir, stateDir } from "../dist/state-dir.js";

let tmp, savedState, canFence;

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "foreman-confine-mounts-")));
  savedState = stateDir();
  canFence = (await confineProblems({ bwrap: "bwrap" })).length === 0;
});

after(() => {
  setStateDir(savedState);
  rmSync(tmp, { recursive: true, force: true });
});

/** Run `script` under sh inside the fence; stdout lines as `key=value` pairs. */
const fenced = (script, opts) => {
  const { bin, args } = confineCommand("sh", ["-c", script], opts);
  const r = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(r.status, 0, `fenced script failed: ${r.stderr}`);
  return Object.fromEntries(r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("=")));
};

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("homes: with the state directory inside the checkout, another session's home is invisible, its own usable", async (t) => {
  if (!canFence) return t.skip("bubblewrap cannot start a sandbox on this host");
  const cwd = join(tmp, "self-managed");
  mkdirSync(cwd);
  setStateDir(cwd);
  const mine = await createSessionHome();
  const other = await createSessionHome();
  writeFileSync(join(other, "secret"), "other-session");
  const homes = join(cwd, "session-homes");
  const out = fenced(
    `echo listing=$(ls -A ${homes} | wc -l); ` +
      `cat ${join(other, "secret")} >/dev/null 2>&1 && echo readOther=yes || echo readOther=no; ` +
      `rm -rf ${other} 2>/dev/null; ` +
      `echo own > "$HOME/note" && echo ownHome=yes || echo ownHome=no; ` +
      `echo w > ${join(cwd, "work")} && echo checkout=yes || echo checkout=no`,
    { cwd, home: mine },
  );
  assert.deepEqual(out, { listing: "0", readOther: "no", ownHome: "yes", checkout: "yes" });
  assert.equal(readFileSync(join(other, "secret"), "utf8"), "other-session", "the other home survives");
  assert.equal(readFileSync(join(mine, "note"), "utf8"), "own\n", "the own home is the scratch home");
});

test("worktree: a linked worktree's git works inside the fence; the main checkout's files stay out", async (t) => {
  if (!canFence) return t.skip("bubblewrap cannot start a sandbox on this host");
  setStateDir(join(tmp, "state"));
  const main = join(tmp, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README"), "main\n");
  git(main, "add", "README");
  git(main, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  const wt = join(tmp, "wt");
  git(main, "worktree", "add", "-q", "-b", "feature", wt);
  assert.equal(worktreeGitDirs(wt).length, 2, "gitdir and common dir");
  const home = await createSessionHome();
  const out = fenced(
    `git status --porcelain >/dev/null 2>&1 && echo status=ok || echo status=fail; ` +
      `git -c user.name=T -c user.email=t@example.invalid commit -q --allow-empty -m fenced >/dev/null 2>&1 ` +
      `&& echo commit=ok || echo commit=fail; ` +
      `test -e ${join(main, "README")} && echo mainFiles=visible || echo mainFiles=hidden`,
    { cwd: wt, home },
  );
  assert.deepEqual(out, { status: "ok", commit: "ok", mainFiles: "hidden" });
  assert.equal(git(main, "log", "-1", "--format=%s", "feature"), "fenced", "the commit landed in the shared repo");
});

test("read-only: a mandatory read file inside the writable checkout cannot be changed from inside", async (t) => {
  if (!canFence) return t.skip("bubblewrap cannot start a sandbox on this host");
  setStateDir(join(tmp, "state"));
  const cwd = join(tmp, "ro-inside");
  mkdirSync(cwd);
  const gate = join(cwd, "gate.json");
  writeFileSync(gate, "{}");
  const home = await createSessionHome();
  const out = fenced(
    `echo x >> ${gate} 2>/dev/null && echo gate=writable || echo gate=readonly; ` +
      `echo w > ${join(cwd, "other")} && echo checkout=yes || echo checkout=no`,
    { cwd, home, read: [gate] },
  );
  assert.deepEqual(out, { gate: "readonly", checkout: "yes" });
  assert.equal(readFileSync(gate, "utf8"), "{}");
});

/** A main repo with one linked worktree, under `tmp/<name>`. */
const repoWithWorktree = (name) => {
  const base = join(tmp, name);
  const main = join(base, "main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  git(main, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(base, "wt");
  git(main, "worktree", "add", "-q", "-b", name, wt);
  return { base, main, wt, admin: join(main, ".git", "worktrees", "wt") };
};

test("worktree pointers: a .git or commondir a session rewrote to name the host home refuses the session", async () => {
  setStateDir(join(tmp, "state"));
  const { base, wt, admin } = repoWithWorktree("hostile");
  const hostHome = join(base, "host-home");
  mkdirSync(join(hostHome, ".ssh"), { recursive: true });
  writeFileSync(join(hostHome, ".ssh", "id_ed25519"), "dummy");
  const home = await createSessionHome();
  const good = readFileSync(join(wt, ".git"), "utf8");
  assert.equal(worktreeGitDirs(wt, hostHome).length, 2, "the untouched worktree passes");

  // R1/R2: .git names the host home (or a folder inside it) directly.
  for (const target of [hostHome, join(hostHome, ".ssh")]) {
    writeFileSync(join(wt, ".git"), `gitdir: ${target}\n`);
    assert.throws(() => worktreeGitDirs(wt, hostHome), /Confined session refused/);
    assert.throws(() => confineCommand("sh", ["-c", "true"], { cwd: wt, home }), /Confined session refused/);
  }
  // A forged admin folder inside the checkout whose commondir names the host home.
  const forged = join(wt, "forged", "worktrees", "x");
  mkdirSync(forged, { recursive: true });
  writeFileSync(join(forged, "commondir"), hostHome);
  writeFileSync(join(forged, "gitdir"), join(wt, ".git"));
  writeFileSync(join(wt, ".git"), `gitdir: ${forged}\n`);
  assert.throws(() => worktreeGitDirs(wt, hostHome), /not a worktree of/);

  // R4: .git untouched, the writable admin folder's commondir rewritten to the host home.
  writeFileSync(join(wt, ".git"), good);
  const commondir = readFileSync(join(admin, "commondir"), "utf8");
  writeFileSync(join(admin, "commondir"), hostHome);
  assert.throws(() => worktreeGitDirs(wt, hostHome), /not a worktree of/);
  writeFileSync(join(admin, "commondir"), commondir);

  // Another checkout's admin folder: its back-pointer names that checkout, not this one.
  const other = join(base, "wt2");
  git(join(base, "main"), "worktree", "add", "-q", "-b", "hostile2", other);
  writeFileSync(join(wt, ".git"), readFileSync(join(other, ".git"), "utf8"));
  assert.throws(() => worktreeGitDirs(wt, hostHome), /another checkout/);

  // A common dir that would cover the host home.
  writeFileSync(join(wt, ".git"), good);
  assert.throws(() => worktreeGitDirs(wt, join(base, "main", ".git", "hooks")), /cover the home/);
});
