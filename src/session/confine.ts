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
//   - `cwd` and `write`, writable; `read`, read-only.
// The network is shared: a session must reach the model, GitHub and its MCP servers.
//
// Ported from slashbin-ai-team `lib/confine.js` (PR #147). That repo is private and this one is public, so
// the argument construction is copied, never imported. This file is the one copy of fence logic here.
//
// Nothing starts a session through this yet: the spawn wiring is the sibling card. Until then
// `confineSessions: true` only refuses a start on a host that cannot run a sandbox.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { stateDir } from "../state-dir.js";

/** The folders a fenced session reads system files from, as the host lays them out. */
const CONFINE_SYSTEM = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

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
 * a file, or a link): a session that could point its home elsewhere would be handed that place, writable.
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
  for (const p of read) ro.add(real(p));

  const rw = new Set([real(cwd), ...write.map(real)]);
  // A read-only path inside a writable one is already visible; shallower paths bind first so a deeper
  // writable one lands on top.
  const depth = (p: string) => p.split(sep).length;
  const roList = [...ro].filter((p) => existsSync(p) && ![...rw].some((w) => within(p, w)));
  const rwList = [...rw].filter((p) => existsSync(p));
  for (const p of roList.sort((a, b) => depth(a) - depth(b))) out.push("--ro-bind", p, p);
  for (const p of rwList.sort((a, b) => depth(a) - depth(b))) out.push("--bind", p, p);

  out.push("--chdir", real(cwd), "--", binPath ?? bin, ...args);
  return { bin: bwrap, args: out };
}

/** Why a fenced session cannot start on this host, or [] when it can: bubblewrap must start a sandbox. */
export async function confineProblems({ bwrap = "bwrap" }: { bwrap?: string } = {}): Promise<string[]> {
  const ok = await new Promise<boolean>((done) => {
    let child;
    try {
      child = spawn(bwrap, ["--ro-bind", "/", "/", "--", "true"], { stdio: "ignore", timeout: PROBE_TIMEOUT_MS });
    } catch {
      done(false);
      return;
    }
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
  return ok
    ? []
    : [
        `confineSessions is on but bubblewrap (${bwrap}) cannot start a sandbox on this host within ` +
          `${PROBE_TIMEOUT_MS / 1000}s. Install bwrap (or set AI_AGENT_CONFINE_BWRAP), or turn confineSessions off; ` +
          `a fenced session never runs open`,
      ];
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
