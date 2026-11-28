// Session confinement (slashbin-ai-foreman#404): the bubblewrap fence a builder session can be started in.
//
// Why. Every session runs with `--dangerously-skip-permissions` and, unconfined, the host HOME: it can read
// `~/.ssh`, the Doppler login and `~/.claude/projects`, where the 2026-10-01 token leak landed (#62, #71).
// A permission rule cannot hold that line: Claude Code's Read, Grep and Glob run in the CLI's own process,
// and a bypass-mode session has no rule. The boundary is drawn around the process instead, so a file outside
// it does not exist, for `cat` and for Read alike.
//
// What a fenced session sees:
//   - the system folders commands run from, read-only (/usr, /etc, and /bin, /lib, /lib64, /sbin as the
//     host lays them out), a private /tmp, its own /proc and a minimal /dev;
//   - a scratch home of its own (`createSessionHome`, under `<stateDir>/session-homes`), bound at the host
//     home's path so the CLI finds its home where it expects it. The host home itself is absent. The one
//     thing carried in is the CLI's sign-in, `~/.claude/.credentials.json`, read-only;
//   - the agent binary and the Node install, read-only;
//   - `cwd` and `write`, writable, with a linked worktree's git folders (`worktreeGitDirs`); `read`, read-only,
//     even where it lies inside a writable folder;
//   - never another session's scratch home: the folder they live in is masked wherever a bind exposes it.
// The network is shared: a session must reach the model, GitHub and its MCP servers. Name lookup needs the
// files in `NAME_RESOLUTION`; where one is a link out of /etc (WSL points /etc/resolv.conf at
// /mnt/wsl/resolv.conf), its target file alone is bound too, never the folder it sits in, so the link resolves.
// `confineProblems` refuses a fence in which github.com does not resolve.
//
// Ported from slashbin-ai-team `lib/confine.js` (PR #147). That repo is private and this one is public, so
// the argument construction is copied, never imported. This file is the one copy of fence logic here.
//
// With `confineSessions` on, every builder session starts through `confineCommand` (src/session/runner.ts).
// The host home is gone, so git there has no SSH key, no agent and no `~/.gitconfig`: `writeSessionGitConfig`
// gives the scratch home the host's commit identity, rewrites GitHub SSH remotes to HTTPS and answers the
// HTTPS credential prompt with the session's own GH_TOKEN, so a push needs nothing from the host.

import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { stateDir } from "../state-dir.js";

const execFileAsync = promisify(execFile);

/** The folders a fenced session reads system files from, as the host lays them out. */
const CONFINE_SYSTEM = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

/**
 * The files name lookup reads. A link here that leaves the system folders would dangle inside the fence
 * (2026-11-26: WSL's /etc/resolv.conf -> /mnt/wsl/resolv.conf, so every lookup failed with EAI_AGAIN).
 */
export const NAME_RESOLUTION = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/host.conf", "/etc/gai.conf"];

/** The host the start probe resolves inside the fence: a session cannot clone, push or call gh without it. */
const PROBE_HOST = "github.com";

/** The largest git pointer file (`.git`, `commondir`, `gitdir`) read; real ones hold one path. */
const POINTER_MAX = 4096;

/** How long the start probe may take before the sandbox counts as unable to start. */
const PROBE_TIMEOUT_MS = 10_000;

export interface ConfineOptions {
  /** The session's working directory (writable). */
  cwd: string;
  /** The session's scratch home on the host (writable), bound at the host home's path. Must be a plain folder. */
  home: string;
  /** Further read-only files or folders. */
  read?: string[];
  /** Further writable folders. */
  write?: string[];
  /** The bubblewrap binary (default `bwrap`). */
  bwrap?: string;
}

/** The bwrap binary the daemon uses: `AI_AGENT_CONFINE_BWRAP`, else `bwrap`. Never a config key. */
export function confineBwrap(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_AGENT_CONFINE_BWRAP?.trim() || "bwrap";
}

function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** Whether `p` is `root` or lies inside it. */
function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** `bin` as PATH resolves it, or null. */
function which(bin: string): string | null {
  for (const d of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const p = join(d, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * The bubblewrap command that starts `bin args` fenced. Throws when `home` is not a plain folder (missing,
 * a file, or a link): a session that could point its home elsewhere would be handed that place, writable. Also
 * throws when `cwd/.git` is a gitdir file that fails `worktreeGitDirs`' check.
 */
export function confineCommand(bin: string, args: string[], opts: ConfineOptions): { bin: string; args: string[] } {
  const { cwd, home, read = [], write = [], bwrap = "bwrap" } = opts;
  const hostHome = homedir();

  let homeStat;
  try {
    homeStat = lstatSync(home);
  } catch {
    throw new Error(`Confined session refused: its home ${home} does not exist`);
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error(`Confined session refused: its home ${home} is not a plain folder`);
  }

  const out = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  // A merged-/usr host links /bin to usr/bin: a link is recreated as one rather than bound over.
  for (const p of CONFINE_SYSTEM) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) out.push("--symlink", readlinkSync(p), p);
    else out.push("--ro-bind", p, p);
  }
  out.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const target of nameResolutionTargets()) out.push("--ro-bind", target, target);

  // The scratch home at the host home's path; the sign-in carried in read-only, so a session can use it and
  // cannot change or truncate the file every session shares.
  out.push("--bind", real(home), hostHome, "--dir", join(hostHome, ".claude"));
  const credentials = join(hostHome, ".claude", ".credentials.json");
  if (existsSync(credentials)) out.push("--ro-bind", credentials, credentials);

  // The agent binary at the path it is started by and at its real path (a versioned install is a link into
  // a folder of releases), and Node, which MCP servers and hooks start.
  const ro = new Set<string>();
  const binPath = bin.includes("/") ? resolve(bin) : which(bin);
  if (binPath) {
    const binReal = real(binPath);
    ro.add(dirname(binReal));
    if (binPath !== binReal) out.push("--ro-bind", binReal, binPath);
  }
  ro.add(dirname(dirname(real(process.execPath))));
  // Playwright's browsers, at their default home under the host home, which the scratch home hides: e2e and
  // Lighthouse runs start them. Read-only, and only when the host has them.
  const browsers = join(hostHome, ".cache", "ms-playwright");
  if (existsSync(browsers)) ro.add(real(browsers));
  for (const p of read) ro.add(real(p));

  const rw = new Set([real(cwd), ...worktreeGitDirs(cwd, hostHome), ...write.map(real)]);
  // Shallower paths bind first so a deeper one lands on top. A read-only path inside a writable one is bound
  // again after it, so it stays read-only rather than inheriting the writable bind.
  const depth = (p: string) => p.split(sep).length;
  const byDepth = (a: string, b: string) => depth(a) - depth(b);
  const insideRw = (p: string) => [...rw].some((w) => within(p, w));
  const roAll = [...ro].filter((p) => existsSync(p));
  const rwList = [...rw].filter((p) => existsSync(p));
  for (const p of roAll.filter((p) => !insideRw(p)).sort(byDepth)) out.push("--ro-bind", p, p);
  for (const p of rwList.sort(byDepth)) out.push("--bind", p, p);

  // Every scratch home lives in one folder, under the state directory, which can sit inside a bound checkout
  // (the Foreman managing itself, with the default state directory `.`). Masked there, a session cannot
  // read, change or delete another's home; its own stays reachable at the host home's path.
  const homes = real(sessionHomesDir());
  if ([...roAll, ...rwList].some((p) => within(homes, p)) && existsSync(homes)) out.push("--tmpfs", homes);

  for (const p of roAll.filter(insideRw).sort(byDepth)) out.push("--ro-bind", p, p);

  out.push("--chdir", real(cwd), "--", binPath ?? bin, ...args);
  return { bin: bwrap, args: out };
}

/**
 * The git folders a linked worktree at `cwd` needs besides itself: its `.git` is a file naming a gitdir
 * (`<common>/worktrees/<name>`) outside the checkout, and that gitdir's `commondir` names the shared one with
 * the objects and refs. Both are bound writable; no other checkout's working files are. [] for a plain checkout.
 *
 * Both pointers are files a session can rewrite, so neither is trusted alone: a gitdir is accepted only when it
 * is `<common>/worktrees/<name>` inside a folder laid out as a git dir, its `commondir` resolves to that same
 * `<common>`, and its own `gitdir` file points back at this checkout's `.git`. Pointing them at a folder the
 * session cannot already write (the host home, say) cannot pass, because the back-pointer would have to be
 * written there first. The shape is checked before any file outside the checkout is read, and a pointer file is
 * read only when it is a small regular file, never through a link. A `.git` file that fails throws a fixed
 * message naming no path or content it read: the session is refused, never started with the pointer dropped or
 * followed.
 */
export function worktreeGitDirs(cwd: string, hostHome: string = homedir()): string[] {
  const root = real(cwd);
  const dotGit = join(root, ".git");
  let st;
  try {
    st = lstatSync(dotGit);
  } catch {
    return [];
  }
  if (st.isDirectory()) return [];
  const refuse = (why: string): never => {
    throw new Error(`Confined session refused: the checkout's .git ${why}`);
  };
  /** A pointer file's text: a regular file (not a link) of at most POINTER_MAX bytes, else null. */
  const pointer = (file: string): string | null => {
    try {
      const f = lstatSync(file);
      if (!f.isFile() || f.size > POINTER_MAX) return null;
      return readFileSync(file, "utf-8").trim();
    } catch {
      return null;
    }
  };
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const dotGitText = pointer(dotGit) ?? refuse("is neither a folder nor a gitdir file");
  const m = dotGitText.match(/^gitdir:\s*(.+)$/m) ?? refuse("names no gitdir");
  const gitDir = real(resolve(root, m[1].trim()));
  const common = dirname(dirname(gitDir));
  const shaped =
    basename(dirname(gitDir)) === "worktrees" &&
    isDir(gitDir) &&
    isDir(join(common, "objects")) &&
    isDir(join(common, "refs")) &&
    pointer(join(common, "HEAD")) !== null;
  if (!shaped) refuse("names a folder that is not a linked worktree's git dir");
  const commonRaw = pointer(join(gitDir, "commondir")) ?? refuse("names a git dir without a readable commondir");
  if (real(isAbsolute(commonRaw) ? commonRaw : resolve(gitDir, commonRaw)) !== common) {
    refuse("names a git dir whose commondir does not hold it");
  }
  const back = pointer(join(gitDir, "gitdir")) ?? refuse("names a git dir without a readable back-pointer");
  if (real(resolve(gitDir, back)) !== dotGit) refuse("names a git dir that belongs to another checkout");
  const home = real(hostHome);
  if ([gitDir, common].some((d) => within(home, d))) refuse("names a git dir that would cover the home");
  return [gitDir, common].filter((d) => !within(d, root));
}

/**
 * The real files behind `NAME_RESOLUTION` entries that are links leading out of the system folders the fence
 * binds. Only regular files: a target that is a folder (or missing) is left out, never bound whole.
 */
export function nameResolutionTargets(files: string[] = NAME_RESOLUTION): string[] {
  const out = new Set<string>();
  for (const f of files) {
    try {
      if (!lstatSync(f).isSymbolicLink()) continue;
      const target = realpathSync.native(f);
      if (CONFINE_SYSTEM.some((d) => within(target, d))) continue;
      if (statSync(target).isFile()) out.add(target);
    } catch {
      /* missing or dangling on the host too: nothing to carry in */
    }
  }
  return [...out];
}

/** Run `bin args` to its exit within the probe timeout; true on exit 0. */
function probe(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return new Promise<boolean>((done) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: "ignore", timeout: PROBE_TIMEOUT_MS, env });
    } catch {
      done(false);
      return;
    }
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
}

/** Whether bubblewrap starts a sandbox at all; [] when it does. The mount tests use this alone. */
export async function bwrapProblems({ bwrap = "bwrap" }: { bwrap?: string } = {}): Promise<string[]> {
  return (await probe(bwrap, ["--ro-bind", "/", "/", "--", "true"]))
    ? []
    : [
        `confineSessions is on but bubblewrap (${bwrap}) cannot start a sandbox on this host within ` +
          `${PROBE_TIMEOUT_MS / 1000}s. Install bwrap (or set AI_AGENT_CONFINE_BWRAP), or turn confineSessions off; ` +
          `a fenced session never runs open`,
      ];
}

/**
 * Why a fenced session cannot start on this host, or [] when it can: bubblewrap must start a sandbox, and inside
 * the real fence (`confineCommand`, a throwaway checkout and home) Node must resolve github.com. A fence that
 * starts but cannot look a name up would fail every session's clone, push and model call.
 */
export async function confineProblems({ bwrap = "bwrap" }: { bwrap?: string } = {}): Promise<string[]> {
  const started = await bwrapProblems({ bwrap });
  if (started.length) return started;
  const root = mkdtempSync(join(tmpdir(), "foreman-confine-probe-"));
  try {
    const cwd = join(root, "checkout");
    const home = join(root, "home");
    mkdirSync(cwd);
    mkdirSync(home);
    const lookup = `require("node:dns").lookup(${JSON.stringify(PROBE_HOST)}, (e) => process.exit(e ? 1 : 0))`;
    const { bin, args } = confineCommand(process.execPath, ["-e", lookup], { cwd, home, bwrap });
    // Without NODE_OPTIONS: a preload or require named there lives outside the fence (its /tmp is private)
    // and would kill node before the lookup, refusing the start for a reason that is not DNS.
    const { NODE_OPTIONS: _drop, ...env } = process.env;
    if (await probe(bin, args, env)) return [];
    return [
      `confineSessions is on but ${PROBE_HOST} does not resolve inside the bubblewrap fence within ` +
        `${PROBE_TIMEOUT_MS / 1000}s; a session could not reach GitHub or the model. Check that every file in ` +
        `NAME_RESOLUTION (src/session/confine.ts) is readable in the fence, or turn confineSessions off`,
    ];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The folder every scratch home lives in. */
function sessionHomesDir(): string {
  return resolve(stateDir(), "session-homes");
}

/** A new, empty scratch home for one session. */
export async function createSessionHome(): Promise<string> {
  const dir = sessionHomesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(dir, "s-"));
}

/**
 * The git credential helper a fenced session uses for https://github.com: the session's GH_TOKEN, read when git
 * asks, so the token is never written to disk. `store` and `erase` are ignored.
 */
export const SESSION_GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

/** The GitHub SSH remote forms a fenced session's git rewrites to HTTPS: it has no SSH key or agent. */
export const SESSION_GIT_SSH_FORMS = ["git@github.com:", "ssh://git@github.com/"];

/**
 * Write `<home>/.gitconfig` for a fenced session: the host's global commit identity (`user.name`, `user.email`,
 * when set), every GitHub SSH remote rewritten to HTTPS, and the GH_TOKEN credential helper as the only one for
 * https://github.com (the empty first value resets any the system config names). Nothing else of the host's
 * git config crosses.
 */
export async function writeSessionGitConfig(home: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = join(home, ".gitconfig");
  const set = (key: string, value: string, add = false) =>
    execFileAsync("git", ["config", "--file", file, ...(add ? ["--add"] : []), key, value], { env });
  for (const key of ["user.name", "user.email"]) {
    let value = "";
    try {
      value = (await execFileAsync("git", ["config", "--global", "--get", key], { env })).stdout.trim();
    } catch {
      /* unset on the host: git asks for it inside, as it would outside */
    }
    if (value) await set(key, value);
  }
  for (const [i, form] of SESSION_GIT_SSH_FORMS.entries()) await set("url.https://github.com/.insteadOf", form, i > 0);
  await set("credential.https://github.com.helper", "");
  await set("credential.https://github.com.helper", SESSION_GIT_CREDENTIAL_HELPER, true);
}

/** Remove a session's scratch home. A missing one is a no-op. */
export async function removeSessionHome(path: string): Promise<void> {
  rmSync(path, { recursive: true, force: true });
}

/** Remove every scratch home. Run once at daemon start: only a crash strands one, and none is in use yet. */
export async function sweepSessionHomes(): Promise<void> {
  rmSync(sessionHomesDir(), { recursive: true, force: true });
}

/**
 * The daemon-start gate. With `confineSessions` off it does nothing (no probe, no sweep). On, it sweeps the
 * scratch homes a crash left, then probes bubblewrap; a problem is the refusal to print, else null.
 */
export async function confineStartRefusal(
  config: { confineSessions: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (!config.confineSessions) return null;
  await sweepSessionHomes();
  const problems = await confineProblems({ bwrap: confineBwrap(env) });
  return problems.length ? problems.join("; ") : null;
}
