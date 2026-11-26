// The EM plugin files the follow-up for a shipped verify hold that stayed unresolved: it asks the EM's
// `verify-disposition.mjs file`, reads the one result line back, and says `failed` on anything else so the caller
// never closes a card whose follow-up is not filed. Offline: the EM is a fake checkout, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { fileVerifyFollowUpViaEm, EmPlugin } from "../dist/plugins/em.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const repo = { name: "r", githubRepo: "o/r" };
const INPUT = {
  prNumber: 41, card: 7, originatedAt: "2026-11-01T00:00:00Z", reason: "prod-verify-failed",
  verdict: "the order never reached the label queue", evidence: ["log line 1", "log line 2"], epic: 12, owner: "em",
};

function fakeEm(body) {
  const dir = mkTmp("fake-em-fu-");
  mkdirSync(join(dir, "scripts/routines"), { recursive: true });
  writeFileSync(join(dir, "scripts/routines/verify-disposition.mjs"), body);
  return { emRepoPath: dir, sessionEnv: [] };
}
const record = (log, out, code = 0) =>
  `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })); ${out} process.exit(${code});`;

test("fileVerifyFollowUpViaEm: asks the EM's file command with the hold's facts and returns filed", async () => {
  const log = join(mkTmp("fu-log-"), "argv.json");
  const cfg = fakeEm(record(log, `console.log("preview"); console.log("follow-up filed o/r#99 https://github.com/o/r/issues/99");`));
  const r = await fileVerifyFollowUpViaEm(repo, cfg, INPUT, logger);
  assert.deepEqual(r, { kind: "filed", issue: 99, url: "https://github.com/o/r/issues/99" });
  const seen = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(seen.cwd, cfg.emRepoPath, "cwd is the EM checkout");
  assert.equal(seen.argv[0], "file");
  assert.equal(seen.argv[1], "--json");
  assert.equal(seen.argv[3], "--post");
  assert.deepEqual(JSON.parse(seen.argv[2]), {
    repo: "o/r", card: 7, prNumber: 41, originatedAt: "2026-11-01T00:00:00Z", outcome: "expired",
    reason: "prod-verify-failed", established: [], notEstablished: ["the order never reached the label queue"],
    evidence: ["log line 1", "log line 2"], epic: 12, owner: "em",
  });
});

test("fileVerifyFollowUpViaEm: an already-filed hold comes back as existing", async () => {
  const cfg = fakeEm(`console.log("follow-up existing o/r#98 https://github.com/o/r/issues/98");`);
  assert.deepEqual(await fileVerifyFollowUpViaEm(repo, cfg, INPUT, logger), { kind: "existing", issue: 98, url: "https://github.com/o/r/issues/98" });
});

test("fileVerifyFollowUpViaEm: no recorded verdict says so, and no epic is passed as null", async () => {
  const log = join(mkTmp("fu-log-"), "argv.json");
  const cfg = fakeEm(record(log, `console.log("follow-up filed o/r#5 https://x/5");`));
  await fileVerifyFollowUpViaEm(repo, cfg, { ...INPUT, verdict: "", evidence: [], epic: null }, logger);
  const sent = JSON.parse(JSON.parse(readFileSync(log, "utf8")).argv[2]);
  assert.deepEqual(sent.notEstablished, ["no verdict recorded for the hold"]);
  assert.deepEqual(sent.evidence, []);
  assert.equal(sent.epic, null);
});

test("fileVerifyFollowUpViaEm: emRepoPath unset is failed, never a call", async () => {
  assert.deepEqual(await fileVerifyFollowUpViaEm(repo, {}, INPUT, logger), { kind: "failed", detail: "emRepoPath not configured" });
});

test("fileVerifyFollowUpViaEm: a non-zero exit is failed and carries the CLI's tail", async () => {
  const cfg = fakeEm(`console.log("follow-up filed o/r#1 https://x/1"); console.error("gh: rate limited"); process.exit(1);`);
  const r = await fileVerifyFollowUpViaEm(repo, cfg, INPUT, logger);
  assert.equal(r.kind, "failed");
  assert.match(r.detail, /exit 1/);
  assert.match(r.detail, /rate limited/);
});

test("fileVerifyFollowUpViaEm: a zero exit without the result line is failed", async () => {
  for (const out of [`console.log("preview only");`, `console.log("follow-up filed o/r#x https://x");`, ``]) {
    const r = await fileVerifyFollowUpViaEm(repo, fakeEm(out), INPUT, logger);
    assert.equal(r.kind, "failed", out);
  }
});

test("fileVerifyFollowUpViaEm: a missing EM script is failed, never a throw", async () => {
  const r = await fileVerifyFollowUpViaEm(repo, { emRepoPath: mkTmp("empty-em-"), sessionEnv: [] }, INPUT, logger);
  assert.equal(r.kind, "failed");
});

test("the EM plugin exposes the method on its unstick role", () => {
  assert.equal(new EmPlugin().unstick.fileVerifyFollowUp, fileVerifyFollowUpViaEm);
});
