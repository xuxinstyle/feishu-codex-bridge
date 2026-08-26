import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as bridgeCore from "../bridge-core.mjs";

import {
  codexConfigOverrideForReasoning,
  effectiveCodexModel,
  effectiveReasoningEffort,
  extractThreadCwds,
  mergeProjectChoices,
  parseCodexConfigDefaults,
  parseProjectChoices,
  parseCommand,
  validateReasoningEffort,
  validateModelName,
} from "../bridge-core.mjs";

test("parseCommand recognizes model show, set, and default commands", () => {
  assert.deepEqual(parseCommand("/model"), { type: "model", action: "show" });
  assert.deepEqual(parseCommand("/model gpt-5.5"), {
    type: "model",
    action: "set",
    model: "gpt-5.5",
    reasoningEffort: "",
  });
  assert.deepEqual(parseCommand("/model gpt-5.5 high"), {
    type: "model",
    action: "set",
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
  assert.deepEqual(parseCommand("/model default"), { type: "model", action: "clear" });
});

test("parseCommand recognizes reasoning and project commands", () => {
  assert.deepEqual(parseCommand("/reasoning"), { type: "reasoning", action: "show" });
  assert.deepEqual(parseCommand("/reasoning high"), {
    type: "reasoning",
    action: "set",
    reasoningEffort: "high",
  });
  assert.deepEqual(parseCommand("/reasoning default"), { type: "reasoning", action: "clear" });
  assert.deepEqual(parseCommand("/project"), { type: "project", action: "show" });
  assert.deepEqual(parseCommand("/project wiki"), { type: "project", action: "set", project: "wiki" });
});

test("validateModelName accepts common model ids and rejects unsafe values", () => {
  assert.equal(validateModelName("gpt-5.5").ok, true);
  assert.equal(validateModelName("Qzhou/Qwen3-4B-Gen4-Release").ok, true);

  const rejected = validateModelName("gpt-5.5 --dangerously-bypass-approvals-and-sandbox");
  assert.equal(rejected.ok, false);
});

test("effectiveCodexModel prefers scoped override over configured default", () => {
  assert.equal(
    effectiveCodexModel({ configuredModel: "gpt-5.4", scopedModel: "gpt-5.5" }),
    "gpt-5.5"
  );
  assert.equal(effectiveCodexModel({ configuredModel: "gpt-5.4", scopedModel: "" }), "gpt-5.4");
  assert.equal(
    effectiveCodexModel({ configuredModel: "", defaultModel: "gpt-5.5", scopedModel: "" }),
    "gpt-5.5"
  );
  assert.equal(effectiveCodexModel({ configuredModel: "", scopedModel: "" }), "");
});

test("parseCodexConfigDefaults reads top-level model defaults without taking profile values", () => {
  const defaults = parseCodexConfigDefaults(`
model = "gpt-5.5" # default model
model_reasoning_effort = "high"

[profiles.fast]
model = "gpt-5.4"
model_reasoning_effort = "low"
`);

  assert.deepEqual(defaults, { model: "gpt-5.5", reasoningEffort: "high" });
});

test("reasoning effort validation and config override use Codex config keys", () => {
  assert.equal(validateReasoningEffort("low").ok, true);
  assert.equal(validateReasoningEffort("xhigh").ok, true);
  assert.equal(validateReasoningEffort("ultra").ok, true);
  assert.equal(validateReasoningEffort("debug").ok, false);
  assert.equal(
    effectiveReasoningEffort({ configuredEffort: "medium", scopedEffort: "high" }),
    "high"
  );
  assert.equal(
    effectiveReasoningEffort({ configuredEffort: "", defaultEffort: "high", scopedEffort: "" }),
    "high"
  );
  assert.equal(
    codexConfigOverrideForReasoning("high"),
    'model_reasoning_effort="high"'
  );
});

test("parseProjectChoices accepts aliases and path-only entries", () => {
  const choices = parseProjectChoices("cs=F:/AIServer/jx3-cs-services;F:/AIServer/jx3-wiki");
  assert.deepEqual(choices, [
    { alias: "cs", path: "F:/AIServer/jx3-cs-services" },
    { alias: "jx3-wiki", path: "F:/AIServer/jx3-wiki" },
  ]);
});

test("card actions prefer the chat's active project over a stale card project", () => {
  assert.equal(typeof bridgeCore.cardProjectPathForAction, "function");
  assert.equal(
    bridgeCore.cardProjectPathForAction({
      activeProjectPath: "E:\\Stock_Analysis",
      cardProjectPath: "F:\\AIServer\\jx3-cs-services",
      defaultProjectPath: "F:\\AIServer\\jx3-cs-services",
    }),
    "E:\\Stock_Analysis"
  );
});

test("extractThreadCwds reads cwd values from thread/list result pages and ignores malformed threads", () => {
  assert.deepEqual(
    extractThreadCwds({
      result: {
        data: [
          { id: "thread-1", cwd: "E:\\Stock_Analysis" },
          { id: "thread-2", cwd: "" },
          { id: "thread-3" },
          { id: "thread-4", cwd: 42 },
          { id: "thread-5", cwd: "F:/AIServer/jx3-wiki" },
        ],
        nextCursor: "next-page",
      },
    }),
    ["E:\\Stock_Analysis", "F:/AIServer/jx3-wiki"]
  );
});

test("mergeProjectChoices preserves configured projects and appends discovered paths once", () => {
  assert.deepEqual(
    mergeProjectChoices(
      [
        { alias: "cs", path: "F:\\AIServer\\jx3-cs-services" },
        { alias: "stock", path: "E:\\Stock_Analysis" },
      ],
      [
        "E:\\Stock_Analysis",
        "F:\\AIServer\\jx3-wiki",
        "F:\\AIServer\\jx3-wiki",
        "",
      ]
    ),
    [
      { alias: "cs", path: "F:\\AIServer\\jx3-cs-services" },
      { alias: "stock", path: "E:\\Stock_Analysis" },
      { alias: "jx3-wiki", path: "F:\\AIServer\\jx3-wiki" },
    ]
  );
});
