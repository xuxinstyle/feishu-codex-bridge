import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverCodexModels, createModelCatalog } from "../codex-models.mjs";

test("model discovery follows engine pagination, executable model IDs and visibility", async () => {
  const calls = [];
  let closed = false;
  const result = await discoverCodexModels({ cwd: "project", rpcFactory: () => ({
    initialize: async () => {}, close: () => { closed = true; },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "config/read") return { config: { model: "gpt-6.1-sol", model_reasoning_effort: "high" } };
      return params.cursor ? { data: [{ model: "grok-4.7" }, { model: "gpt-5.6-sol" }], nextCursor: null }
        : { data: [{ id: "picker-id", model: "gpt-5.6-sol" }, { model: "hidden", hidden: true }, { model: "bad model" }], nextCursor: "page-2" };
    },
  }) });
  assert.deepEqual(result, { models: ["gpt-5.6-sol", "grok-4.7"], defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "high" });
  assert.equal(calls[0].params.cwd, "project");
  assert.equal(calls[1].params.includeHidden, false);
  assert.equal(calls[2].params.cursor, "page-2");
  assert.equal(closed, true);
});

test("bad pagination and empty catalogs fail and close the discovery process", async () => {
  for (const response of [{ data: [], nextCursor: null }, { data: [{ model: "valid" }], nextCursor: "same" }, {}]) {
    let closed = false;
    await assert.rejects(discoverCodexModels({ rpcFactory: () => ({ initialize: async () => {},
      request: async method => method === "config/read" ? {} : response, close: () => { closed = true; },
    }) }));
    assert.equal(closed, true);
  }
});

test("catalog refresh deduplicates requests, isolates projects and retains last success on failure", async () => {
  let fail = false, count = 0;
  const catalog = createModelCatalog({ configuredChoices: ["extra", "gpt-5.6-sol", "invalid model"],
    discover: async ({ cwd }) => {
      count++;
      if (fail) throw new Error("unavailable");
      return { models: cwd === "a" ? ["gpt-5.6-sol"] : ["grok-4.7"] };
    },
  });
  const a = catalog.refresh("a");
  assert.equal(catalog.refresh("a"), a);
  await a;
  await catalog.refresh("b");
  assert.deepEqual(catalog.get("a").models, ["gpt-5.6-sol", "extra"]);
  assert.deepEqual(catalog.get("b").models, ["grok-4.7", "extra", "gpt-5.6-sol"]);
  fail = true;
  await catalog.refresh("a");
  assert.equal(count, 3);
  assert.match(catalog.get("a").error, /unavailable/);
  assert.deepEqual(catalog.get("a").models, ["gpt-5.6-sol", "extra"]);
  assert.equal(catalog.get("b").error, "");
  fail = false;
  await catalog.refresh("a");
  assert.equal(catalog.get("a").error, "");
});
