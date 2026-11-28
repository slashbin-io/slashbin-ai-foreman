// 2026-11-28: sweepOpenPrStates ran `gh pr list` for every repo every pass (~2,087 GraphQL calls an hour) though
// most repos have no open PR. The fleet state already holds each repo's open PRs: a repo it says has none is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { fleetState } from "../dist/github-state.js";
import { configureIssueCache } from "../dist/github/cache.js";
import { sweepOpenPrStates } from "../dist/github/branch.js";
import { createLogger } from "../dist/logger.js";

const dir = mkTmp("fake-gh-sweep-");
const log = join(dir, "calls");
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$1 $2" >> "${log}"
echo '[]'
`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "t-test-token";
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

const logger = createLogger({ format: "text", level: "error" });
const conn = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const pr = (number) => ({ number, url: `u/${number}`, title: "t", body: "", state: "OPEN", headRefName: `f${number}`, baseRefName: "develop", headRefOid: "h", updatedAt: "2026-11-28T11:59:00Z" });
let prs = [];
configureIssueCache({ ttlMs: 60_000 });
const setup = () => fleetState.configure({
  repos: ["a/x"],
  refreshMs: 30_000,
  logger,
  runAsync: async () => JSON.stringify({ data: { r0: { issues: conn([]), pullRequests: conn(prs) } } }),
});

test("a repo the fleet state holds no open PR for is not asked about", async () => {
  prs = [];
  setup();
  writeFileSync(log, "");
  for (let i = 0; i < 5; i++) assert.deepEqual(await sweepOpenPrStates("a/x", "develop", "main", tmpdir(), logger), []);
  assert.equal(calls().length, 0, "five passes, no gh call");
});

test("a repo with an open PR is still read live; an unwatched repo too", async () => {
  prs = [pr(7)];
  setup();
  writeFileSync(log, "");
  await sweepOpenPrStates("a/x", "develop", "main", tmpdir(), logger);
  assert.deepEqual(calls(), ["pr list"]);
  writeFileSync(log, "");
  await sweepOpenPrStates("a/unwatched", "develop", "main", tmpdir(), logger);
  assert.deepEqual(calls(), ["pr list"], "state cannot vouch for a repo it does not watch");
});
