// End to end through trySyncDrift with the real GitHub code host and a stateful fake `gh`: a sync PR an
// older Foreman headed with the production branch, BEHIND its base, is closed; the next cycle opens a
// dedicated sync-branch PR; that one is branch-updated and then merges. Every write is checked in the
// fake's own state, the Foreman-token close included.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { setCodeHost, resetRegistryForTests } from "../dist/plugins/registry.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { trySyncDrift } from "../dist/phases/promote.js";

const dir = mkTmp("fake-gh-lifecycle-");
const stateFile = join(dir, "state.json");
const callLog = join(dir, "calls");
const save = (s) => writeFileSync(stateFile, JSON.stringify(s));
const load = () => JSON.parse(readFileSync(stateFile, "utf8"));
writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, a.join(" ") + "\\n");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const num = Number(a[2]);
const pr = s.prs.find((p) => p.number === num);
const done = (out) => { fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(s)); if (out !== undefined) console.log(out); process.exit(0); };
const fail = (m) => { console.error(m); process.exit(1); };
const cmd = a[0] + " " + a[1];
if (cmd === "pr list") done(JSON.stringify(s.prs.filter((p) => p.open).map((p) => ({ number: p.number, url: "https://github.com/o/r/pull/" + p.number, title: "t", body: "", headRefName: p.head, baseRefName: "develop", headRefOid: "x", isDraft: false, mergeStateStatus: p.merge }))));
if (cmd === "pr view") done(pr.merge + " " + pr.head);
if (cmd === "pr review") done("");
if (cmd === "pr merge") { if (pr.merge !== "CLEAN") fail("Pull request is not mergeable"); pr.open = false; s.behind = 0; done(""); }
if (cmd === "pr close") { pr.open = false; done(""); }
if (cmd === "pr create") { const head = a[a.indexOf("--head") + 1]; s.prs.push({ number: 99, head, open: true, merge: "BEHIND" }); done("https://github.com/o/r/pull/99"); }
if (a[0] === "api" && /compare/.test(a[1])) done(JSON.stringify({ ahead: 0, behind: s.behind, files: 0, paths: [] }));
if (a[0] === "api" && a.includes("PUT")) { { const m = /pulls\\/(\\d+)\\/update-branch/.exec(a.join(" ")); const p = s.prs.find((x) => x.number === Number(m[1])); p.merge = "CLEAN"; } done(""); }
if (a[0] === "api" && /git\\/ref\\/heads\\/develop/.test(a[1])) done("abc123");
done("");
`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.TECHLEAD_GITHUB_KEY = "t-test-token";
process.env.FOREMAN_GITHUB_TOKEN = "f-test-token";
const lines = [];
const logger = { debug() {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m, x) => lines.push(m + JSON.stringify(x ?? {})), child() { return this; } };
const repoConfig = { name: "r", githubRepo: "o/r", repoPath: tmpdir(), productionBranch: "main", baseBranch: "develop" };
const calls = () => readFileSync(callLog, "utf8");

test("a production-headed BEHIND sync PR is closed, replaced by a dedicated sync PR, which is updated and merges", async () => {
  resetRegistryForTests();
  setCodeHost(githubCodeHost());
  writeFileSync(callLog, "");
  save({ behind: 1, prs: [{ number: 5, head: "main", open: true, merge: "BEHIND" }] });

  // Cycle 1: merge refused, BEHIND on a production head: closed, never updated.
  assert.equal(await trySyncDrift(repoConfig, logger, 1), false);
  assert.equal(load().prs.find((p) => p.number === 5).open, false, "legacy PR not closed: " + calls() + lines.join("\n"));
  assert.doesNotMatch(calls(), /pulls\/5\/update-branch/);

  // Cycle 2: no open sync PR is found; a dedicated one is cut from the base and opened.
  assert.equal(await trySyncDrift(repoConfig, logger, 2), true);
  assert.match(calls(), /merges -f base=foreman\/sync-main-into-develop -f head=main/);
  const created = load().prs.find((p) => p.number === 99);
  assert.equal(created.head, "foreman/sync-main-into-develop");
  assert.equal(created.open, true, "the immediate merge was refused while it is BEHIND");

  // Cycle 3: the dedicated PR is found, refused, BEHIND on a sync branch: updated.
  assert.equal(await trySyncDrift(repoConfig, logger, 3), false);
  assert.match(calls(), /api -X PUT repos\/o\/r\/pulls\/99\/update-branch/);
  assert.equal(load().prs.find((p) => p.number === 99).merge, "CLEAN");

  // Cycle 4: it merges; develop is no longer behind.
  assert.equal(await trySyncDrift(repoConfig, logger, 4), true);
  assert.equal(load().prs.find((p) => p.number === 99).open, false);
  assert.equal(load().behind, 0);

  // Cycle 5: nothing left to do, and production was never written.
  assert.equal(await trySyncDrift(repoConfig, logger, 5), false);
  assert.doesNotMatch(calls(), /base=main\b/);
  resetRegistryForTests();
});
