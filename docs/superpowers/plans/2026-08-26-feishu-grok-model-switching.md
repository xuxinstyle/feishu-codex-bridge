# 飞书面板切换 Grok/Codex 模型实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有飞书 Codex 机器人和 `/panel` 卡片中增加 Grok 4.6、Grok 4.5 的直接切换入口，同时保留通过 `/model <模型名>` 使用任意 Codex/provider 可用模型的能力。

**Architecture:** 不新增飞书机器人、不新增独立 Grok API 链路；所有任务继续由现有本机 Codex CLI 执行。桥接层只负责把模型选择按“chat + project”持久化，并在启动时把 Grok 与 Codex 候选渲染到同一张控制卡片，选择后继续通过 Codex CLI 的 `-m <model>` 参数生效。

**Tech Stack:** Node.js ESM、`node:test`、飞书 Interactive Card JSON、现有 `bridge.mjs`/`bridge-core.mjs`、本机 Codex CLI/provider。

**Spec:** 本计划直接实现用户需求：复用原 Codex 飞书机器人，在面板增加 Grok 4.6/Grok 4.5 按钮，并保留任意模型切换。

## Global Constraints

- 只能复用现有飞书应用、事件订阅和 `card.action.trigger` 链路，不创建第二个机器人。
- 所有模型任务必须继续经过现有 Codex CLI；桥接层不得记录或暴露 token、API key、`auth.json` 或 dotenv 实值。
- 模型覆盖范围继续是当前飞书聊天窗口 + 当前项目，并持久化到现有 session state 文件。
- Grok 按钮使用精确模型 ID `grok-4.6` 与 `grok-4.5`；其他 Codex 模型继续由 `CODEX_MODEL_CHOICES` 或 `/model <模型名>` 提供。
- 不修改与本功能无关的 session、项目切换、任务队列和飞书鉴权行为。

---

### Task 1: 抽取并测试模型候选分组规则

**Files:**
- Modify: `bridge-core.mjs`
- Test: `test/bridge-core.test.mjs`

**Interfaces:**
- Produces `buildModelChoiceGroups({ configuredChoices, configuredModel, defaultModel })`，返回 `{ grok: string[], codex: string[] }`。
- `grok` 固定包含 `grok-4.6`、`grok-4.5`，并吸收用户通过 `CODEX_MODEL_CHOICES` 配置的其他 `grok-*` 模型。
- `codex` 保留用户配置的非 Grok 模型、当前配置模型、Codex 配置默认模型，并去重；不得把 Grok 重复渲染到 Codex 分组。

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing export**

Run: `npm test -- --test-name-pattern="buildModelChoiceGroups"`

Expected: FAIL because `buildModelChoiceGroups` is not yet exported.

- [ ] **Step 3: Implement the minimal grouping helper**

```js
const DEFAULT_GROK_MODELS = ["grok-4.6", "grok-4.5"];

export function buildModelChoiceGroups({ configuredChoices = [], configuredModel = "", defaultModel = "" } = {}) {
  const all = uniqueModelList([...DEFAULT_GROK_MODELS, ...configuredChoices, configuredModel, defaultModel]);
  return {
    grok: all.filter((model) => /^grok(?:-|$)/i.test(model)),
    codex: all.filter((model) => !/^grok(?:-|$)/i.test(model)),
  };
}
```

The helper must use the existing model-name safety rule or the same allowed model-id character set, so malformed config values do not become card buttons.

- [ ] **Step 4: Run the focused test and then the full Node test suite**

Run: `npm test -- --test-name-pattern="buildModelChoiceGroups"`

Expected: focused tests pass.

Run: `npm test`

Expected: all existing and new Node tests pass with zero failures.

---

### Task 2: Render grouped Grok/Codex buttons and preserve arbitrary-model UX

**Files:**
- Modify: `bridge.mjs`
- Test: `test/bridge-core.test.mjs` (only if a pure card helper is extracted)
- Modify: `README.md`
- Modify: `secrets/feishu_codex_bridge.env.template` only if a non-secret configuration comment is needed

**Interfaces:**
- `config.codex.modelGroups` is created from `CODEX_MODEL_CHOICES`, `CODEX_MODEL`, and the Codex config default model using `buildModelChoiceGroups`.
- `buildControlCard` renders separate `**Grok models**` and `**Codex/provider models**` action blocks. Each button keeps action `set_model` and value `{ model }`, so existing card-action handling remains the single mutation path.
- The card includes a short hint that `/model <模型名>` accepts any model ID supported by the active Codex provider/catalog.

- [ ] **Step 1: Add a failing source-level regression test for card configuration**

Add a test that reads `bridge.mjs` as text and asserts the intended stable contracts are present:

```js
test("bridge config includes Grok presets and grouped model card sections", () => {
  const source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8");
  assert.match(source, /buildModelChoiceGroups/);
  assert.match(source, /Grok models/);
  assert.match(source, /Codex\/provider models/);
  assert.match(source, /grok-4\.6/);
  assert.match(source, /grok-4\.5/);
});
```

- [ ] **Step 2: Run the new test and verify it fails before implementation**

Run: `npm test -- --test-name-pattern="grouped model card sections"`

Expected: FAIL because the current bridge has only one `models` section and no `modelGroups` wiring.

- [ ] **Step 3: Implement grouped configuration and card rendering**

Import `buildModelChoiceGroups`, replace the single `config.codex.modelChoices` initialization with `config.codex.modelGroups`, and render buttons using the existing `scopedButton` helper:

```js
const makeModelButtons = (models) => models.slice(0, 8).map((model) =>
  scopedButton(
    model === modelText ? `当前 ${model}` : `模型 ${model}`,
    "set_model",
    { model },
    model === modelText ? "primary" : "default"
  )
);
const grokButtons = makeModelButtons(config.codex.modelGroups.grok);
const codexButtons = makeModelButtons(config.codex.modelGroups.codex);
```

Render Grok first, then Codex/provider models, and retain `clear_model`. Do not change `handleCardAction`’s `set_model` behavior; it already validates and persists the selected model.

- [ ] **Step 4: Update user-facing configuration and command documentation**

Document that the default panel includes `grok-4.6`, `grok-4.5`, `gpt-5.5`, and `gpt-5.4`; `CODEX_MODEL_CHOICES` can add arbitrary model IDs; and `/model <模型名>` remains the escape hatch for any provider-supported model. State that actual availability depends on the active local Codex provider/catalog.

- [ ] **Step 5: Run syntax and full tests**

Run: `npm run check`

Expected: `node --check bridge.mjs` exits 0.

Run: `npm test`

Expected: all tests pass.

---

### Task 3: Verify argument propagation, local process behavior, and real provider smoke path

**Files:**
- Modify: `bridge-core.mjs` only if a pure argument builder is needed for testability
- Modify: `bridge.mjs` only if the focused test identifies an argument propagation defect
- Test: `test/bridge-core.test.mjs`

**Interfaces:**
- A selected model must remain in the task snapshot (`task.modelOverride`) and reach `codex exec ... -m <selected-model>` for both new and resumed sessions.
- The existing queue/session persistence behavior must remain unchanged.

- [ ] **Step 1: Add a failing unit test for selected-model argument construction**

If the current inline `appendCodexOptions` cannot be tested without starting Feishu WebSocket, extract a pure helper with this contract:

```js
buildModelArgs({ configuredModel, defaultModel, scopedModel })
// returns [] when no model is effective, otherwise ["-m", effectiveModel]
```

Test:

```js
test("selected Grok model becomes the Codex CLI model argument", () => {
  assert.deepEqual(buildModelArgs({
    configuredModel: "gpt-5.6-sol",
    defaultModel: "gpt-5.5",
    scopedModel: "grok-4.6",
  }), ["-m", "grok-4.6"]);
});
```

- [ ] **Step 2: Run the focused test and verify the expected RED failure**

Run: `npm test -- --test-name-pattern="selected Grok model"`

Expected: FAIL because the pure argument helper is missing.

- [ ] **Step 3: Implement the minimal helper and use it in `appendCodexOptions`**

Keep effective-model precedence exactly as current behavior: chat/project override, then `CODEX_MODEL`, then `~/.codex/config.toml`; append only the `-m` pair and do not alter approval, sandbox, search, profile, or reasoning flags.

- [ ] **Step 4: Run focused tests, full tests, and syntax checks**

Run: `npm test -- --test-name-pattern="selected Grok model"`

Expected: PASS.

Run: `npm test`

Expected: all tests pass.

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 5: Run a no-secret local fake-Codex smoke test**

Use a temporary fake executable that records argv and emits one valid JSON event plus a final output file, then verify the spawned arguments contain `-m grok-4.6` and no secret/config file contents. Do not modify the user’s real Codex config or send a Feishu message.

- [ ] **Step 6: If local credentials and network are already configured, run one harmless direct Codex provider smoke test**

Invoke the existing Codex CLI with a read-only prompt such as `Reply with exactly GROK_SMOKE_OK and do not inspect or modify files`, using `-m grok-4.6` and a temporary output file. Treat this as provider availability evidence only; if the provider rejects the model, report the exact non-secret error and leave the code feature usable via configured model choices. Never print command environment, bearer tokens, or auth files.

---

### Task 4: Final verification and change review

**Files:**
- No new production files.

- [ ] **Step 1: Inspect the final diff and confirm scope**

Run: `git diff -- bridge-core.mjs bridge.mjs test/bridge-core.test.mjs README.md secrets/feishu_codex_bridge.env.template`

Expected: only model-choice grouping, panel rendering, documentation, and tests are changed; no secrets are staged or printed.

- [ ] **Step 2: Run the complete verification set**

Run: `npm test`

Run: `npm run check`

Expected: both exit 0 with zero test failures and no syntax errors.

- [ ] **Step 3: Report exact validation boundaries**

Report separately: automated local tests, fake-Codex argument propagation, and whether the optional real Grok provider smoke test was available or blocked by provider credentials/model availability. Do not claim Feishu external delivery unless the live bot was actually exercised.

## Execution Notes (2026-08-26)

- Automated local verification completed: `npm test` passed 17/17 and `npm run check` exited 0.
- Fake-Codex argument propagation completed: captured argv was `-m grok-4.6`.
- Local model catalog contains both `grok-4.6` and `grok-4.5` with `supported_in_api=true`.
- Real `grok-4.6` provider smoke was attempted with a read-only ephemeral prompt and was blocked by the active provider returning HTTP 503 `model has no compatible available channel`; no project files were modified and no credentials were exposed.
- Live Feishu message/card delivery was not exercised, so external bot delivery remains an operational follow-up rather than a claimed test result.
