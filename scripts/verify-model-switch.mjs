// Real Codex Desktop inference through the production Feishu handlers. Only
// the messenger is recorded locally; no test messages go to an external chat.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callDesktopTool, findDesktopPipe } from "../codex-desktop.mjs";
import { discoverCodexModels } from "../codex-models.mjs";
import { CodexAppServer, desktopCodexBinary } from "../codex-app-server.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.resolve(process.env.MODEL_VERIFICATION_PROJECT || root);
const output = path.join(root, "outputs");
mkdirSync(output, { recursive: true });
const work = mkdtempSync(path.join(output, "live-model-"));
const harness = path.join(root, `.live-model-${randomUUID()}.mjs`);
const emptyEnv = path.join(work, "empty.env");
writeFileSync(emptyEnv, "");
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: emptyEnv, FEISHU_APP_ID: "local-verification", FEISHU_APP_SECRET: "local-verification",
  SESSION_STATE_PATH: path.join(work, "state.json"), DEFAULT_PROJECT_PATH: project,
  CODEX_TASK_TRANSPORT: "desktop", CODEX_PROJECT_DISCOVERY: "off", CODEX_MODEL: "", CODEX_MODEL_CHOICES: "",
  CODEX_REASONING_EFFORT: "low", CODEX_SANDBOX_MODE: "workspace-write", CODEX_APPROVAL_POLICY: "never",
});
const evidence = { startedAt: new Date().toISOString(), model: "gpt-5.6-sol", externalFeishuMessages: 0, passed: false };
let threadId;
const pipe = findDesktopPipe();
assert.ok(pipe, "Open Codex Desktop before running this verification");
const token = `MODEL_SWITCH_OK_${randomUUID().slice(0, 8)}`;
try {
  const source = readFileSync(path.join(root, "bridge.mjs"), "utf8").replace(/\r\n/g, "\n");
  const boundary = source.indexOf("\nconst client = new Client(");
  assert.ok(boundary > 0);
  const showPanel = source.slice(source.indexOf("async function showControlCard("), source.indexOf("\nif (pairingCode)"));
  const handlers = source.slice(source.indexOf("async function handleMessage("), source.indexOf("\nconst dispatcher ="));
  writeFileSync(harness, source.slice(0, boundary) + `
export function createLiveHarness(messenger, senderId) {
  const runner = new TaskRunner(messenger), allowedUserIds = new Set([senderId]); let pairingCode = null;
  ${showPanel}\n${handlers}
  return { runner, handleMessage, handleNormalizedCardAction, catalog: config.codex.modelCatalog };
}\n`);
  const { createLiveHarness } = await import(pathToFileURL(harness));
  const cards = [], receipts = [];
  let serial = 0;
  const record = card => { cards.push(card); return `local-card-${++serial}`; };
  const messenger = { replyCard: async (_, card) => record(card), sendCard: async (_, card) => record(card),
    updateCard: async (_, card) => { record(card); }, replyText: async (_, text) => { receipts.push(text); return `text-${++serial}`; } };
  const actor = { chatId: `local-model-${token}`, senderId: "local-verification", messageId: "local-input", chatType: "p2p" };
  const live = createLiveHarness(messenger, actor.senderId);
  live.runner.setActiveSession(actor.chatId, project, "模型切换本地验证");
  await live.handleMessage({ ...actor, text: "/panel" });
  const act = async value => live.handleNormalizedCardAction({ chatId: actor.chatId,
    messageId: live.runner.controlCardMessageId(actor.chatId), operator: { openId: actor.senderId },
    action: { value: { bridge: "feishu-codex-bridge", scopeChatId: actor.chatId, projectPath: project, ...value } } });
  await act({ action: "show_models", page: 0 });
  const catalog = live.catalog.get(project);
  assert.equal(catalog.error, "");
  const engine = await discoverCodexModels({ command: desktopCodexBinary(), cwd: project });
  assert.deepEqual(catalog.models, engine.models, "Feishu must expose the same complete catalog as Codex");
  evidence.catalog = catalog.models;
  let selected;
  const renderedModels = [];
  for (let page = 0; page < Math.ceil(catalog.models.length / 8); page++) {
    if (page) {
      const next = cards.at(-1).elements.flatMap(element => element.actions || [])
        .find(button => button.value.action === "show_models" && button.value.page === page);
      assert.ok(next, "The actual model card must provide a next-page button");
      await act(next.value);
    }
    const buttons = cards.at(-1).elements.flatMap(element => element.actions || []);
    renderedModels.push(...buttons.filter(button => button.value.action === "set_model").map(button => button.value.model));
    selected ||= buttons.find(button => button.value.action === "set_model" && button.value.model === evidence.model);
  }
  assert.deepEqual(renderedModels, catalog.models, "Model pagination must expose every model in catalog order");
  evidence.pagination = true;
  assert.ok(selected, "gpt-5.6-sol must have a selectable button");
  await act(selected.value);
  assert.equal(live.runner.effectiveModel(actor.chatId, project), evidence.model);
  evidence.cardSelection = true;
  // A new runner must load the persisted chat/project model selection.
  const reloaded = createLiveHarness(messenger, actor.senderId);
  assert.equal(reloaded.runner.effectiveModel(actor.chatId, project), evidence.model);
  evidence.persistedSelection = true;
  const prompt = `这是本地模型切换验证。不要调用任何工具，不要读写文件。只回复下面的原样文本：${token}`;
  await live.handleMessage({ ...actor, messageId: "local-model-task", text: prompt });
  const task = [...live.runner.tasks.values()][0];
  await Promise.all([...live.runner.sessionQueues.values()]);
  threadId = task.threadId;
  evidence.task = { status: task.status, model: task.model, threadId, turnId: task.turnId, output: task.output, error: task.error };
  assert.equal(task.status, "success", task.error || task.output);
  assert.equal(task.model, evidence.model);
  assert.ok(task.output.includes(token), "The real inference must return its unique token");
  const history = await callDesktopTool(pipe, threadId, "read_thread", { threadId, hostId: "local", turnLimit: 3 });
  // App Tools omits the model from its thread summary. Read engine metadata
  // without resuming the thread or acquiring a second history writer.
  const rpc = new CodexAppServer({ command: desktopCodexBinary(), cwd: project });
  let metadata;
  try { await rpc.initialize(); metadata = await rpc.request("thread/read", { threadId }); }
  finally { rpc.close(); }
  evidence.desktop = { model: metadata.thread?.model, status: history.turns?.[0]?.status };
  evidence.reconnectRejections = (history.turns || []).filter(turn => turn.status === "failed" &&
    turn.error?.message?.includes("model_change_requires_reconnect")).length;
  assert.equal(evidence.desktop.model, evidence.model, "The saved thread must confirm the selected execution model");
  assert.equal(history.turns?.[0]?.status, "completed");
  await live.handleMessage({ ...actor, messageId: "local-model-reset", text: "/model default" });
  assert.equal(live.runner.modelOverrides.size, 0);
  await live.handleMessage({ ...actor, messageId: "local-model-command", text: "/model gpt-5.6-sol low" });
  assert.equal(live.runner.effectiveModel(actor.chatId, project), evidence.model);
  evidence.commandSelection = true;
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack;
  process.exitCode = 1;
} finally {
  if (threadId) {
    try { await callDesktopTool(pipe, threadId, "set_thread_archived", { threadId, archived: true, hostId: "local" }); }
    catch (error) { evidence.cleanupError = error.message; }
  }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(path.join(output, "model-switch-verification.json"), JSON.stringify(evidence, null, 2));
  rmSync(harness, { force: true });
  console.log(JSON.stringify(evidence, null, 2));
}
