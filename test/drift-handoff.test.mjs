import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

test("DRIFT_HANDOFF_TITLE is the stable dedupe prefix", async () => {
  const { DRIFT_HANDOFF_TITLE } = await import("../dist/phases/promote.js");
  assert.equal(DRIFT_HANDOFF_TITLE, "Release the work merged to develop with no Foreman issue");
});

test("issue-less drift handoff acceptance scenarios (create, dedupe, blocked, close, keep) all pass", () => {
  const r = spawnSync(process.execPath, [join(DIR, "scripts", "acceptance", "issueless-drift-handoff.mjs")], { encoding: "utf8", timeout: 300_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
