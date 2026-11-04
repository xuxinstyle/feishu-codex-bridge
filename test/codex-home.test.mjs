import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { resolveCodexHome, resolveSessionEnv } from "../codex-home.mjs";
import { prepareDesktopThread } from "../codex-desktop.mjs";
import { runAppServerTask } from "../codex-app-server.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-home-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { configuredHome: path.join(root, "custom"), defaultHome: path.join(root, "default") };
  function rollout(home, id = "target", { archived = false, content = "{}\n" } = {}) {
    const directory = path.join(home, ...(archived ? ["archived_sessions"] : ["sessions", "2026", "11", "04"]));
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `rollout-2026-11-04T10-00-00-${id}.jsonl`);
    writeFileSync(file, content);
    return file;
  }
  return { root, options, rollout };
}

test("startup prefers configured home when both contain readable rollout files", t => {
  const f = fixture(t);
  f.rollout(f.options.defaultHome);
  const file = f.rollout(f.options.configuredHome);
  const result = resolveCodexHome(f.options);
  assert.equal(result.home, f.options.configuredHome);
  assert.equal(result.file, file);
  assert.equal(result.warning, "");
});

test("startup falls back when configured home is missing, empty or contains only a DB", t => {
  const f = fixture(t);
  f.rollout(f.options.defaultHome);
  for (const kind of ["missing", "directory", "db", "empty-rollout"]) {
    if (kind !== "missing") mkdirSync(f.options.configuredHome, { recursive: true });
    if (kind === "db") writeFileSync(path.join(f.options.configuredHome, "state_5.sqlite"), "index");
    if (kind === "empty-rollout") f.rollout(f.options.configuredHome, "target", { content: "" });
    const result = resolveCodexHome(f.options);
    assert.equal(result.home, f.options.defaultHome, kind);
    assert.ok(result.warning.includes(f.options.configuredHome));
    assert.ok(result.warning.includes(f.options.defaultHome));
  }
});

test("unset CODEX_HOME checks the default and does not warn about fallback", t => {
  const f = fixture(t);
  f.rollout(f.options.defaultHome);
  const result = resolveCodexHome({ ...f.options, configuredHome: "" });
  assert.equal(result.home, f.options.defaultHome);
  assert.equal(result.warning, "");
  assert.equal(result.probes.length, 1);
});

test("restoring a specific thread ignores unrelated configured history and accepts archived files", t => {
  const f = fixture(t);
  f.rollout(f.options.configuredHome, "other");
  const file = f.rollout(f.options.defaultHome, "target", { archived: true });
  const result = resolveCodexHome({ ...f.options, threadId: "target" });
  assert.equal(result.home, f.options.defaultHome);
  assert.equal(result.file, file);
  assert.ok(result.warning.includes("target"));
});

test("missing thread reports id, both paths, attempted directories and recovery instructions", t => {
  const f = fixture(t);
  f.rollout(f.options.configuredHome, "not-target");
  f.rollout(f.options.defaultHome, "target-suffix");
  assert.throws(() => resolveCodexHome({ ...f.options, threadId: "target", allowEmpty: true }), error => {
    assert.equal(error.code, "CODEX_SESSION_FILE_MISSING");
    for (const part of ["target", f.options.configuredHome, f.options.defaultHome, "sessions", "archived_sessions", "/new", "启动用户"])
      assert.ok(error.message.includes(part), part);
    return true;
  });
});

test("new installation reports missing history without preventing new threads", t => {
  const f = fixture(t);
  const result = resolveCodexHome({ ...f.options, allowEmpty: true });
  assert.equal(result.home, f.options.defaultHome);
  assert.equal(result.file, null);
  assert.ok(result.error.includes("首次使用"));
  assert.ok(result.error.includes(f.options.configuredHome));
  assert.ok(result.error.includes(f.options.defaultHome));
});

test("invalid history directory reports the OS error and still attempts the default", t => {
  const f = fixture(t);
  mkdirSync(f.options.configuredHome);
  writeFileSync(path.join(f.options.configuredHome, "sessions"), "not a directory");
  const missing = resolveCodexHome({ ...f.options, allowEmpty: true });
  assert.match(missing.error, /读取异常:.*sessions: (ENOTDIR|ENOENT|EACCES|EPERM|UNKNOWN)/);
  f.rollout(f.options.defaultHome);
  assert.equal(resolveCodexHome(f.options).home, f.options.defaultHome);
});

test("session fallback changes only the child environment and rechecks removed files", t => {
  const f = fixture(t);
  const file = f.rollout(f.options.defaultHome);
  const env = { CODEX_HOME: f.options.configuredHome, TASK_MARKER: "keep" };
  const diagnostics = [];
  assert.deepEqual(resolveSessionEnv(env, f.options, "target", text => diagnostics.push(text)),
    { CODEX_HOME: f.options.defaultHome, TASK_MARKER: "keep" });
  assert.equal(env.CODEX_HOME, f.options.configuredHome);
  assert.equal(diagnostics.length, 1);
  rmSync(file);
  assert.throws(() => resolveSessionEnv(env, f.options, "target"), /会话文件检查失败/);
  assert.equal(resolveSessionEnv(env, f.options, null), env, "new threads keep the startup selection");
});

// Real stdio transport; the fake engine checks the environment it actually got.
// No real model, credentials or Feishu connection is used.
function engine(expectedHome) {
  return `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line);
      if (r.id === undefined) return;
      if (process.env.CODEX_HOME !== ${JSON.stringify(expectedHome)}) {
        process.stdout.write(JSON.stringify({ id:r.id, error:{ message:'wrong CODEX_HOME' } })+'\\n'); return;
      }
      let result = {};
      if (r.method === 'thread/read' || r.method === 'thread/resume') result = {thread:{id:'target',projectId:'project',status:{type:'idle'}}};
      if (r.method === 'turn/start') result = {turn:{id:'turn'}};
      process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
      if (r.method === 'turn/start') process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'target',turn:{id:'turn',status:'completed'}}})+'\\n');
    });
  `;
}

test("Desktop preparation passes the fallback home to the actual auxiliary subprocess", async t => {
  const f = fixture(t);
  f.rollout(f.options.configuredHome, "other");
  f.rollout(f.options.defaultHome);
  assert.equal(await prepareDesktopThread({ command: process.execPath, argsPrefix: ["-e", engine(f.options.defaultHome), "--"],
    cwd: process.cwd(), env: { ...process.env, CODEX_HOME: f.options.configuredHome },
    threadId: "target", codexHomeOptions: f.options }), "target");
});

test("App Server resumes through the fallback without creating a replacement thread", async t => {
  const f = fixture(t);
  f.rollout(f.options.defaultHome);
  const result = await runAppServerTask({ command: process.execPath, argsPrefix: ["-e", engine(f.options.defaultHome), "--"],
    cwd: process.cwd(), env: { ...process.env, CODEX_HOME: f.options.configuredHome },
    threadId: "target", codexHomeOptions: f.options, prompt: "test", timeoutMs: 3000 });
  assert.equal(result.threadId, "target");
  assert.equal(result.turn.status, "completed");
});

test("missing sessions fail before spawning either engine", async t => {
  const f = fixture(t);
  const opts = { command: "must-not-spawn", threadId: "target", codexHomeOptions: f.options };
  await assert.rejects(prepareDesktopThread(opts), { code: "CODEX_SESSION_FILE_MISSING" });
  await assert.rejects(runAppServerTask(opts), { code: "CODEX_SESSION_FILE_MISSING" });
});

test("production startup reports missing saved sessions before connecting Feishu", t => {
  const f = fixture(t);
  f.rollout(f.options.defaultHome, "other");
  const source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8");
  const startup = source.slice(source.indexOf('if (codexHomeSelection.warning)'), source.indexOf('await wsClient.start'));
  const logs = [];
  vm.runInNewContext(startup, {
    codexHomeSelection: resolveCodexHome(f.options), codexHomeOptions: f.options, codexHome: f.options.defaultHome,
    resolveCodexHome, APP_SERVER_SESSION_BACKEND: "app-server-v1",
    runner: { sessions: new Map([["binding", { backend: "app-server-v1", threadId: "target" }]]) },
    config: { bridge: { sessionStatePath: "test-state.json" }, codex: {} }, codexLauncher: {}, CONFIG_PATH: "test.env",
    log: (level, message, data) => logs.push({ level, message, data }),
  });
  const error = logs.find(entry => entry.level === "error");
  assert.equal(error.message, "Codex saved session unavailable");
  assert.ok(error.data.message.includes("target"));
  assert.ok(error.data.message.includes(f.options.configuredHome));
  assert.ok(error.data.message.includes(f.options.defaultHome));
  assert.equal(error.data.sessionStatePath, "test-state.json");
  assert.equal(logs.at(-1).data.codexHome, f.options.defaultHome);
});
