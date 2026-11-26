// The EM plugin books the deferred check with its origin: it passes the epic, the deploy time (originatedAt) and the
// endpoint to `deferred-verify.mjs schedule`, and reads the one `scheduled ...` line back. Offline: the EM is a fake checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { scheduleProdFollowUpViaEm } from "../dist/plugins/em.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const repo = { name: "r", githubRepo: "o/r" };
const AT = "2026-11-29T12:00:00Z";
const ORIGIN = { originatedAt: "2026-11-26T06:00:00Z", endpoint: "2026-12-03T06:00:00Z", epic: 2985 };

function fakeEm(body) {
  const dir = mkTmp("fake-em-sched-");
  mkdirSync(join(dir, "scripts/routines"), { recursive: true });
  writeFileSync(join(dir, "scripts/routines/deferred-verify.mjs"), body);
  return { emRepoPath: dir, sessionEnv: [] };
}
const record = (log, out, code = 0) =>
  `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); ${out} process.exit(${code});`;

test("scheduleProdFollowUpViaEm: passes the origin, the endpoint and the epic to schedule", async () => {
  const log = join(mkTmp("sched-log-"), "argv.json");
  const cfg = fakeEm(record(log, `console.log("scheduled R1 Deferred verify: o/r at then o/r:41=5+6");`));
  const r = await scheduleProdFollowUpViaEm(repo, cfg, 41, [5, 6], AT, ORIGIN, logger);
  assert.equal(r, "scheduled R1 Deferred verify: o/r at then o/r:41=5+6");
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
    "schedule", "--repo", "o/r", "--pr", "41", "--issues", "5,6", "--at", AT,
    "--originated-at", ORIGIN.originatedAt, "--endpoint", ORIGIN.endpoint, "--epic", "2985",
  ]);
});

test("scheduleProdFollowUpViaEm: no epic omits --epic", async () => {
  const log = join(mkTmp("sched-log-"), "argv.json");
  const cfg = fakeEm(record(log, `console.log("scheduled R1 t");`));
  await scheduleProdFollowUpViaEm(repo, cfg, 41, [5], AT, { ...ORIGIN, epic: null }, logger);
  const argv = JSON.parse(readFileSync(log, "utf8"));
  assert.ok(!argv.includes("--epic"));
  assert.equal(argv[argv.indexOf("--originated-at") + 1], ORIGIN.originatedAt);
  assert.equal(argv[argv.indexOf("--endpoint") + 1], ORIGIN.endpoint);
});

test("scheduleProdFollowUpViaEm: a refusal (exit 2) or no result line is null; emRepoPath unset is null", async () => {
  assert.equal(await scheduleProdFollowUpViaEm(repo, fakeEm(`console.error("usage"); process.exit(2);`), 41, [5], AT, ORIGIN, logger), null);
  assert.equal(await scheduleProdFollowUpViaEm(repo, fakeEm(`console.log("hello");`), 41, [5], AT, ORIGIN, logger), null);
  assert.equal(await scheduleProdFollowUpViaEm(repo, { sessionEnv: [] }, 41, [5], AT, ORIGIN, logger), null);
});

test("scheduleProdFollowUpViaEm: --at reaches the scheduler in whole seconds (it refuses milliseconds), rounded up", async () => {
  for (const [given, sent] of [["2026-11-29T12:00:00.000Z", "2026-11-29T12:00:00Z"], ["2026-11-29T12:00:00.250Z", "2026-11-29T12:00:01Z"]]) {
    const log = join(mkTmp("sched-log-"), "argv.json");
    const cfg = fakeEm(record(log, `console.log("scheduled R1 t");`));
    await scheduleProdFollowUpViaEm(repo, cfg, 41, [5], given, ORIGIN, logger);
    const argv = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(argv[argv.indexOf("--at") + 1], sent);
  }
});
