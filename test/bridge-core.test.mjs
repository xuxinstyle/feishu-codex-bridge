import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as bridgeCore from "../bridge-core.mjs";

import {
  buildModelArgs,
  buildModelChoiceGroups,
  buildImageArgs,
  canResumeCodexSession,
  codexConfigOverrideForReasoning,
  effectiveCodexModel,
  effectiveReasoningEffort,
  extractThreadCwds,
  mergeProjectChoices,
  parseFeishuImageContent,
  parseCodexConfigDefaults,
  parseProjectChoices,
  parseCommand,
  validateReasoningEffort,
  validateModelName,
  shouldRefreshProjectChoicesForCardAction,
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

test("buildModelChoiceGroups exposes Grok presets and preserves configured Codex models", () => {
  assert.deepEqual(buildModelChoiceGroups({
    configuredChoices: ["gpt-5.6-sol", "grok-4.6", "gpt-5.6-sol"],
    configuredModel: "gpt-5.5",
    defaultModel: "gpt-5.6-sol",
  }), {
    grok: ["grok-4.6", "grok-4.5"],
    codex: ["gpt-5.6-sol", "gpt-5.5"],
  });
});

test("buildModelChoiceGroups keeps arbitrary configured provider models selectable", () => {
  const groups = buildModelChoiceGroups({
    configuredChoices: ["custom/provider-model"],
    configuredModel: "",
    defaultModel: "",
  });
  assert.deepEqual(groups.grok, ["grok-4.6", "grok-4.5"]);
  assert.deepEqual(groups.codex, ["custom/provider-model"]);
});

test("selected Grok model becomes the Codex CLI model argument", () => {
  assert.deepEqual(buildModelArgs({
    configuredModel: "gpt-5.6-sol",
    defaultModel: "gpt-5.5",
    scopedModel: "grok-4.6",
  }), ["-m", "grok-4.6"]);
});

test("Feishu image content extracts image_key safely", () => {
  assert.deepEqual(parseFeishuImageContent('{"image_key":"img_v3_abc"}'), {
    imageKey: "img_v3_abc",
  });
  assert.deepEqual(parseFeishuImageContent('{"image_key":""}'), { imageKey: "" });
  assert.deepEqual(parseFeishuImageContent("not-json"), { imageKey: "" });
});

test("Codex image arguments are only added for a downloaded image", () => {
  assert.deepEqual(buildImageArgs("C:\\Temp\\feishu-image.jpg"), ["-i", "C:\\Temp\\feishu-image.jpg"]);
  assert.deepEqual(buildImageArgs(""), []);
});

test("Codex sessions only resume when their stored model matches the requested model", () => {
  assert.equal(typeof canResumeCodexSession, "function");
  assert.equal(
    canResumeCodexSession({
      session: { threadId: "thread-grok", model: "grok-4.6" },
      model: "gpt-5.6-sol",
    }),
    false
  );
  assert.equal(
    canResumeCodexSession({
      session: { threadId: "thread-legacy" },
      model: "gpt-5.6-sol",
    }),
    false
  );
  assert.equal(
    canResumeCodexSession({
      session: { threadId: "thread-sol", model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
    }),
    true
  );
});

test("bridge config includes Grok presets and grouped model card sections", () => {
  const source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8");
  assert.match(source, /buildModelChoiceGroups/);
  assert.match(source, /Grok models/);
  assert.match(source, /Codex\/provider models/);
  assert.match(source, /modelGroups\.grok/);
  assert.match(source, /modelGroups\.codex/);
  assert.match(source, /buildModelArgs/);
  assert.match(source, /messageResource\.get/);
  assert.match(source, /buildImageArgs/);
  assert.match(source, /imageKey/);
  assert.match(source, /canResumeCodexSession/);
  assert.match(source, /model: task\.model/);
  assert.match(source, /model: this\.effectiveModel\(source\.chatId, projectPath\)/);
  assert.doesNotMatch(source, /taskModel/);
  assert.match(source, /controlCardMessageId/);
  assert.match(source, /ignored action from stale control card/);
});

test("panel command always replies with a new card", () => {
  const source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8");
  const match = source.match(
    /async function showControlCard\([\s\S]*?\n}\n\nif \(pairingCode\)/
  );
  assert.ok(match, "showControlCard implementation should be present");
  assert.match(match[0], /messenger\.replyCard\(replyToMessageId, card\)/);
  assert.doesNotMatch(match[0], /messenger\.updateCard\(/);
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

test("card project discovery only runs for explicit refresh actions", () => {
  assert.equal(typeof shouldRefreshProjectChoicesForCardAction, "function");
  assert.equal(shouldRefreshProjectChoicesForCardAction("refresh"), true);
  assert.equal(shouldRefreshProjectChoicesForCardAction("show_sessions"), true);
  assert.equal(shouldRefreshProjectChoicesForCardAction("set_project"), false);
  assert.equal(shouldRefreshProjectChoicesForCardAction("set_model"), false);
});

test("same-card actions run serially so later model redraw cannot be overwritten", async () => {
  assert.equal(typeof bridgeCore.createKeyedSerialExecutor, "function");
  const execute = bridgeCore.createKeyedSerialExecutor();
  const events = [];

  const first = execute("om-card", async () => {
    events.push("project:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push("project:end");
  });
  const second = execute("om-card", async () => {
    events.push("model:start");
    events.push("model:end");
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "project:start",
    "project:end",
    "model:start",
    "model:end",
  ]);
});

test("Feishu card patch responses with non-zero codes are rejected", () => {
  assert.equal(typeof bridgeCore.assertFeishuApiSuccess, "function");
  assert.doesNotThrow(() =>
    bridgeCore.assertFeishuApiSuccess({ code: 0, msg: "success" }, "更新卡片")
  );
  assert.throws(
    () => bridgeCore.assertFeishuApiSuccess({ code: 230020, msg: "message update failed" }, "更新卡片"),
    /更新卡片失败.*230020.*message update failed/
  );
});

test("actions from an older control card are treated as stale", () => {
  assert.equal(typeof bridgeCore.isStaleControlCardAction, "function");
  assert.equal(
    bridgeCore.isStaleControlCardAction({
      currentMessageId: "om-current",
      actionMessageId: "om-old",
    }),
    true
  );
  assert.equal(
    bridgeCore.isStaleControlCardAction({
      currentMessageId: "om-current",
      actionMessageId: "om-current",
    }),
    false
  );
  assert.equal(
    bridgeCore.isStaleControlCardAction({
      currentMessageId: "",
      actionMessageId: "om-old",
    }),
    false
  );
});
