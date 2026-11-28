// The Foreman's stage list (STAGES, src/lifecycle.ts) and the process catalog's Foreman board
// stages are two lists of one machine. This test compares them on each `npm test` and fails,
// naming the stage and the side that lacks it, when they differ.
//
// The catalog side is the served answer of `process.list_stages` (mode "full"): the union of every
// stage's childStageKeys plus lifecycleOnlyKeys, the catalog's own declaration of the keys it
// deliberately leaves off the board. The test holds no ignore list: an intentional difference is
// declared in the catalog, which is the golden source. No catalog source is imported.
//
// Registry URL unset: skipped, with the reason printed. A failed read fails the run. No cache.
import test from "node:test";
import assert from "node:assert/strict";
import { STAGES } from "../dist/lifecycle.js";
import { createRepoIdentity } from "../dist/paperclip/repo-identity.js";

/** The differences, one line each, naming the stage and the side that lacks it. */
function drift(foremanKeys, served) {
  // A catalog that predates lifecycleOnlyKeys declares no intentional difference: every key it lacks is drift.
  const catalog = new Set([...served.stages.flatMap((s) => s.childStageKeys ?? []), ...(served.lifecycleOnlyKeys ?? [])]);
  const foreman = new Set(foremanKeys);
  return [
    ...[...foreman].filter((k) => !catalog.has(k)).map((k) => `stage "${k}" is in the Foreman's STAGES (src/lifecycle.ts) but the catalog side lacks it (neither a board stage key nor in lifecycleOnlyKeys)`),
    ...[...catalog].filter((k) => !foreman.has(k)).map((k) => `stage "${k}" is in the catalog's served Foreman stages but the Foreman's STAGES side lacks it`),
  ];
}

/** A registry that serves `answer` to list_stages, as one MCP streamable-HTTP endpoint would. */
function fakeRegistry(answer) {
  return async (_url, init) => {
    const msg = JSON.parse(init.body);
    const json = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    if (msg.method === "tools/call") return json({ structuredContent: answer });
    return json({});
  };
}

const served = (stages, lifecycleOnlyKeys) => ({ stages: stages.map((childStageKeys) => ({ childStageKeys })), lifecycleOnlyKeys });

test("drift names each differing stage and the side that lacks it", () => {
  assert.deepEqual(drift(["a", "b", "c"], served([["a"], ["b"]], ["c"])), []);
  const removed = drift(["a", "b", "c"], served([["a"]], ["c"]));
  assert.equal(removed.length, 1);
  assert.match(removed[0], /"b".*catalog side lacks it/);
  const added = drift(["a"], served([["a", "z"]], []));
  assert.equal(added.length, 1);
  assert.match(added[0], /"z".*STAGES side lacks it/);
});

test("the drift read goes through the shared registry client and returns the served answer", async () => {
  const answer = served([["a"]], ["b"]);
  const id = createRepoIdentity({ url: "http://registry.invalid/mcp", fetch: fakeRegistry(answer) });
  assert.deepEqual(await id.callTool("list_stages", { mode: "full" }), answer);
});

test("a catalog without lifecycleOnlyKeys reports blocked and needsRuling as absent from the catalog side", () => {
  const board = STAGES.filter((k) => k !== "blocked" && k !== "needsRuling");
  const diffs = drift(STAGES, { stages: [{ childStageKeys: board }] });
  assert.equal(diffs.length, 2);
  assert.match(diffs.join("\n"), /"blocked".*catalog side lacks it/);
  assert.match(diffs.join("\n"), /"needsRuling".*catalog side lacks it/);
});

test("the process route is derived from the registry route", () => {
  assert.equal(processUrl("https://router.example/registry/mcp"), "https://router.example/process/mcp");
  assert.throws(() => processUrl("https://router.example/other"), /\/process\/mcp/);
});

test("a failed read rejects, it never passes", async () => {
  const id = createRepoIdentity({ url: "http://registry.invalid/mcp", fetch: async () => new Response("no", { status: 400 }) });
  await assert.rejects(id.callTool("list_stages", { mode: "full" }), /registry answered 400/);
});

const url = process.env.AI_AGENT_PAPERCLIP_REGISTRY_URL;

/** The router serves each bundle on its own route; the configured registry URL is the /registry/mcp route, process.list_stages is on /process/mcp of the same router. */
export function processUrl(registryUrl) {
  if (!/\/registry\/mcp\/?$/.test(registryUrl)) throw new Error(`AI_AGENT_PAPERCLIP_REGISTRY_URL does not end in /registry/mcp, so the router's /process/mcp route cannot be derived from it`);
  return registryUrl.replace(/\/registry\/mcp\/?$/, "/process/mcp");
}

test("STAGES and the catalog's served Foreman stages are the same set", { skip: url ? false : "AI_AGENT_PAPERCLIP_REGISTRY_URL is unset: the catalog cannot be read, so the comparison is skipped, not passed" }, async () => {
  let answer;
  try {
    const id = createRepoIdentity({ url: processUrl(url), apiKey: process.env.AI_AGENT_PAPERCLIP_REGISTRY_API_KEY });
    answer = await id.callTool("list_stages", { mode: "full" });
  } catch (e) {
    assert.fail(`could not read the catalog's served stages from the registry: ${e instanceof Error ? e.message : String(e)}`);
  }
  assert.ok(Array.isArray(answer?.stages), "the served answer carries no stages");
  const diffs = drift(STAGES, answer);
  assert.deepEqual(diffs, [], `Foreman STAGES and the catalog's Foreman stages differ:\n${diffs.join("\n")}`);
});
