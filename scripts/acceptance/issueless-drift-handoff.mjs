#!/usr/bin/env node
/**
 * Acceptance for the issue-less drift handoff. A person merges to `develop` with no Foreman issue: the promote
 * phase's stall check (`noteStall`) only logged "promotion is STALLED and no issue names the work. Nothing was
 * commented." (two service repos, 2026-11-20) and nothing reached production.
 * The fix files one handoff issue per repo at `pr approved`, and closes it when the drift is gone.
 *
 * Front door: the BUILT Foreman's `tryPromotion` (the promote phase's entry point), over the real GitHub plugins,
 * with a FAKE `gh` first on PATH serving a compare, an issue board and the issue writes. One child process per
 * scenario so no read cache crosses scenarios. No GitHub call.
 *
 *   S1 develop ahead with production files, zero open issues -> one issue created, label `pr approved`,
 *      body has the compare URL and "merged with no Foreman issue" and "no dev verification ran"
 *   S2 second check with that handoff open at `pr approved` -> zero creates, one stall comment on it
 *   S3 the handoff is labelled `blocked` only -> zero creates
 *   S4 files===0, handoff at `pr approved` -> one comment, then the issue is closed once
 *   S5 files===0, handoff at `ready for prod release` -> not closed
 *
 * RED TODAY (develop 36f8c36): S1 (nothing is created, only the WARN) and S4 (nothing is commented or closed) fail.
 * S2, S3 and S5 pass today (the existing stall comment, no create) and must keep passing.
 *
 *   npm run build && node scripts/acceptance/issueless-drift-handoff.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = fileURLToPath(import.meta.url);
const REPO = "example/acceptance";
const TITLE = "Release the work merged to develop with no Foreman issue";
const HANDOFF = { number: 50, title: TITLE };

const SCENARIOS = {
  S1: { files: 3, issues: [] },
  S2: { files: 3, issues: [{ ...HANDOFF, labels: ["pr approved"] }] },
  S3: { files: 3, issues: [{ ...HANDOFF, labels: ["blocked"] }] },
  S4: { files: 0, issues: [{ ...HANDOFF, labels: ["pr approved"] }] },
  S5: { files: 0, issues: [{ ...HANDOFF, labels: ["ready for prod release"] }] },
};

// ───────────────────────────── child: one scenario ─────────────────────────────
async function child() {
  const sc = SCENARIOS[process.env.ACC_SCENARIO];
  const tmp = mkdtempSync(join(tmpdir(), "foreman-drift-"));
  const out = { creates: [], comments: [], closes: 0, unknown: [], error: null };
  try {
    const bin = join(tmp, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
    const calls = join(tmp, "calls.jsonl");
    const compare = { ahead: sc.files > 0 ? 4 : 1, behind: 0, files: sc.files, paths: Array.from({ length: sc.files }, (_, i) => `src/f${i}.ts`) };
    const board = sc.issues.map((i) => ({ number: i.number, title: i.title, state: "OPEN", labels: i.labels.map((name) => ({ name })) }));
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs=require("fs");const a=process.argv.slice(2);
const log=(kind,extra)=>fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({kind,args:a,...extra})+"\\n");
const opt=(f)=>{const i=a.indexOf(f);return i<0?undefined:a[i+1];};
const labelsOf=(f)=>a.reduce((r,x,i)=>x===f?[...r,a[i+1]]:r,[]);
const out=(v)=>{process.stdout.write(typeof v==="string"?v:JSON.stringify(v));process.exit(0);};
const board=${JSON.stringify(board)};
if(a[0]==="api"&&/\\/compare\\//.test(a[1]))out(${JSON.stringify(compare)});
if(a[0]==="issue"&&a[1]==="list")out(board);
if(a[0]==="issue"&&a[1]==="view"){const n=Number(a[2]);const i=board.find(x=>x.number===n);out(i?{...i,body:""}:{});}
if(a[0]==="issue"&&a[1]==="create"){log("create",{title:opt("--title"),body:opt("--body"),labels:labelsOf("--label")});out("https://github.com/${REPO}/issues/99\\n");}
if(a[0]==="issue"&&a[1]==="comment"){log("comment",{n:Number(a[2]),body:opt("--body")});out("");}
if(a[0]==="issue"&&a[1]==="close"){log("close",{n:Number(a[2])});out("");}
if(a[0]==="pr"&&a[1]==="list")out([]);
log("unknown");out(a[0]==="api"?"{}":[]);
`);
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.FOREMAN_GITHUB_TOKEN = "acceptance-dummy-not-a-token";
    process.env.FOREMAN_STATE_DIR ||= join(tmp, "state");

    const imp = (f) => import(pathToFileURL(join(DIR, "dist", f)).href);
    const { loadConfig } = await imp("config.js");
    const { setStateDir } = await imp("state-dir.js");
    const { registerPlugin, startPlugins, resetRegistryForTests } = await imp("plugins/registry.js");
    const { GitHubPlugin } = await imp("plugins/github.js");
    const { ForemanRuntime } = await imp("runtime.js");
    const { tryPromotion } = await imp("phases/promote.js");
    const github = await imp("github.js");
    github.configureIssueCache?.({ ttlMs: 0 });

    const repoDir = join(tmp, "repo"); mkdirSync(repoDir);
    const cfgPath = join(tmp, "cfg.json");
    writeFileSync(cfgPath, JSON.stringify({ paperclip: { enabled: false }, repos: [{ name: "acceptance", repoPath: repoDir, githubRepo: REPO, baseBranch: "develop", productionBranch: "main" }] }));
    setStateDir(join(tmp, "state.json"));
    const config = loadConfig(cfgPath);
    const repo = config.repos[0];
    const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
    resetRegistryForTests();
    registerPlugin(new GitHubPlugin());
    await startPlugins(config, { logger, configText: () => null });

    const rt = new ForemanRuntime();
    // Cycle 0 is a stall-check cycle (every STALL_CHECK_CYCLE_INTERVAL); one check per scenario.
    await tryPromotion(rt, repo, logger, 0, true);
    if (existsSync(calls)) {
      for (const l of readFileSync(calls, "utf8").split("\n").filter(Boolean)) {
        const c = JSON.parse(l);
        if (c.kind === "create") out.creates.push(c);
        else if (c.kind === "comment") out.comments.push(c);
        else if (c.kind === "close") out.closes++;
        else out.unknown.push(c.args.slice(0, 3).join(" "));
      }
    }
  } catch (err) {
    out.error = err instanceof Error ? err.stack ?? err.message : String(err);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.stdout.write(`\nACC_RESULT ${JSON.stringify(out)}\n`);
  process.exit(0);
}

// ─────────────────────────────── parent: checks ───────────────────────────────
function run(name) {
  const r = spawnSync(process.execPath, [SELF], { env: { ...process.env, ACC_CHILD: "1", ACC_SCENARIO: name }, encoding: "utf8", timeout: 120_000 });
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("ACC_RESULT "));
  if (!line) return { error: `child produced no result (status ${r.status}): ${(r.stderr || "").slice(-400)}`, creates: [], comments: [], closes: 0, unknown: [] };
  return JSON.parse(line.slice("ACC_RESULT ".length));
}

async function parent() {
  for (const f of ["config.js", "phases/promote.js"]) {
    if (!existsSync(join(DIR, "dist", f))) { console.error(`no build at ${join(DIR, "dist", f)}`); process.exit(2); }
  }
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
    if (!ok) failed++;
  };
  const r = Object.fromEntries(Object.keys(SCENARIOS).map((k) => [k, run(k)]));
  const show = (x) => x.error ?? `creates=${x.creates.length} comments=${x.comments.length} closes=${x.closes} unknown=${JSON.stringify(x.unknown)}`;
  const ok = (x) => !x.error;

  const c1 = r.S1.creates[0];
  check("S1 one issue created, label `pr approved`, body has compare URL and both fixed statements",
    ok(r.S1) && r.S1.creates.length === 1 && c1.labels.length === 1 && c1.labels[0] === "pr approved" &&
    c1.body.includes(`https://github.com/${REPO}/compare/main...develop`) &&
    c1.body.includes("merged with no Foreman issue") && c1.body.includes("no dev verification ran"), show(r.S1));
  check("S2 handoff already open -> zero creates, one stall comment on it",
    ok(r.S2) && r.S2.creates.length === 0 && r.S2.comments.length === 1 && r.S2.comments[0].n === 50, show(r.S2));
  check("S3 handoff labelled `blocked` only -> zero creates", ok(r.S3) && r.S3.creates.length === 0, show(r.S3));
  check("S4 files===0, handoff at `pr approved` -> one comment, then closed once",
    ok(r.S4) && r.S4.comments.length === 1 && r.S4.comments[0].n === 50 && r.S4.closes === 1, show(r.S4));
  check("S5 files===0, handoff at `ready for prod release` -> not closed", ok(r.S5) && r.S5.closes === 0 && r.S5.comments.length === 0, show(r.S5));

  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

if (process.env.ACC_CHILD) await child(); else await parent();
