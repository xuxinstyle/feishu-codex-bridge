import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { callDesktopTool, findDesktopPipe, runDesktopTask, steerDesktopTask } from "../codex-desktop.mjs";

test("Desktop steering uses the existing writer and inherits the active turn settings", async () => {
  const calls = [];
  const result = await steerDesktopTask({ pipePath: "pipe", threadId: "thread-a", turnId: "turn-a", prompt: "请先测试",
    callTool: async (_pipe, caller, tool, args) => {
      calls.push({ caller, tool, args });
      if (tool === "read_thread") return { turns: [{ id: "turn-a", status: "inProgress" }] };
      return {};
    },
  });
  assert.equal(result.turnId, "turn-a");
  assert.deepEqual(calls.map(c => c.tool), ["read_thread", "send_message_to_thread"]);
  assert.deepEqual(calls[1].args, { threadId: "thread-a", hostId: "local", prompt: "请先测试" });
});

test("Desktop steering refuses a completed or replacement turn before dispatch", async () => {
  for (const turn of [{ id: "turn-a", status: "completed" }, { id: "turn-b", status: "inProgress" }]) {
    await assert.rejects(steerDesktopTask({ pipePath: "pipe", threadId: "thread-a", turnId: "turn-a", prompt: "补充",
      callTool: async (_p, _t, tool) => { assert.equal(tool, "read_thread"); return { turns: [turn] }; },
    }), /已结束或已切换/);
  }
});

test("Desktop delivery errors are ambiguous and must not trigger automatic retries", async () => {
  await assert.rejects(steerDesktopTask({ pipePath: "pipe", threadId: "thread-a", turnId: "turn-a", prompt: "补充",
    callTool: async (_p, _t, tool) => {
      if (tool === "read_thread") return { turns: [{ id: "turn-a", status: "inProgress" }] };
      throw new Error("pipe closed");
    },
  }), error => error.steerOutcomeUnknown === true);
});

function fixture({ baselineStatus = "idle", finalStatus = "completed", prepareError } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    options: {
      pipePath: "fake-pipe", cwd: "D:\\token_hub", prompt: "用户消息", name: "[飞书] 测试",
      prepare: async () => { if (prepareError) throw prepareError; return "thread-a"; },
      callTool: async (_pipe, caller, tool, args) => {
        assert.equal(caller, "thread-a");
        calls.push({ tool, args });
        if (tool === "list_projects") return { projects: [{ projectKind: "local", hostId: "local", projectId: "desktop-project", path: "D:\\token_hub" }] };
        if (tool === "read_thread") {
          reads++;
          return { thread: { status: { type: reads === 1 ? baselineStatus : "idle" } }, turns: [{
            id: reads === 1 ? "previous-turn" : "new-turn", status: reads === 1 ? "completed" : finalStatus,
            error: finalStatus === "failed" ? { message: "provider failed" } : null,
            items: [{ type: "agentMessage", phase: "commentary", text: "处理中" }, { type: "agentMessage", phase: "final_answer", text: reads === 1 ? "上轮回复" : "本轮回复" }],
          }] };
        }
        return {};
      },
    },
  };
}

test("desktop task dispatches the message through Desktop and updates sidebar membership", async () => {
  const f = fixture();
  const controls = [];
  const outputs = [];
  const result = await runDesktopTask({ ...f.options, model: "gpt-6.1-sol", effort: "high", imagePath: "C:\\图片.png", onControl: c => controls.push(c), onOutput: x => outputs.push(x) });
  assert.equal(result.threadId, "thread-a");
  assert.equal(result.output, "本轮回复");
  assert.deepEqual(outputs, ["本轮回复"]);
  const send = f.calls.findIndex(c => c.tool === "send_message_to_thread");
  const move = f.calls.findIndex(c => c.tool === "move_thread_to_project");
  assert.ok(send >= 0 && move > send, "empty new threads only acquire a Desktop source project after the initial message");
  assert.equal(f.calls[send].args.model, "gpt-6.1-sol");
  assert.equal(f.calls[send].args.thinking, "high");
  assert.ok(f.calls[send].args.prompt.includes("图片.png"));
  assert.equal(f.calls[move].args.projectId, "desktop-project");
  assert.equal(controls[0].canCancel, true);
  assert.equal(controls.at(-1), null);
});

test("an active Desktop turn is never interrupted by a new Feishu message", async () => {
  const f = fixture({ baselineStatus: "active" });
  await assert.rejects(runDesktopTask(f.options), /正在 Codex 客户端执行/);
  assert.ok(!f.calls.some(c => c.tool === "send_message_to_thread"));
});

test("a running Desktop task exposes steering and continues observing the same turn", async () => {
  const f = fixture();
  const original = f.options.callTool;
  let reads = 0, control, submission, dispatched = false;
  const callTool = async (pipe, caller, tool, args) => {
    if (tool === "read_thread") {
      reads++;
      if (reads > 1) return { turns: [{ id: "new-turn", status: dispatched ? "completed" : "inProgress",
        items: [{ type: "agentMessage", phase: "final_answer", text: dispatched ? "包含引导的结果" : "处理中" }],
      }] };
    }
    if (tool === "send_message_to_thread" && args.prompt === "补充要求") dispatched = true;
    return original(pipe, caller, tool, args);
  };
  const result = await runDesktopTask({ ...f.options, callTool, onControl: c => { control = c; }, onProgress: text => {
    if (text === "Codex 客户端正在执行任务。") submission = control.steer("补充要求");
  } });
  assert.equal((await submission).turnId, result.turn.id);
  assert.equal(result.output, "包含引导的结果");
  assert.equal(control, null);
  const sent = f.calls.filter(c => c.tool === "send_message_to_thread");
  assert.equal(sent.length, 2);
  assert.ok(!f.calls.some(c => /interrupt|stop/.test(c.tool)));
});

test("Desktop failures reach Feishu instead of returning the previous completed reply", async () => {
  const f = fixture({ finalStatus: "failed" });
  await assert.rejects(runDesktopTask(f.options), /provider failed/);
});

test("preparation failures release the task control", async () => {
  const f = fixture({ prepareError: new Error("engine unavailable") });
  const controls = [];
  await assert.rejects(runDesktopTask({ ...f.options, onControl: c => controls.push(c) }), /engine unavailable/);
  assert.equal(controls.at(-1), null);
});

test("no Desktop connection fails clearly without silently executing an invisible task", async () => {
  await assert.rejects(runDesktopTask({ pipePath: null }), /请先打开客户端/);
});

test("a running Desktop turn is stopped through the owner channel and confirmed by its final status", async () => {
  let control, reads = 0, stopped = false, request;
  const f = fixture();
  const original = f.options.callTool;
  const result = await runDesktopTask({ ...f.options, pollIntervalMs: 1,
    onControl: value => { if (value) control = value; },
    onTurnStarted: () => { control.interrupt().catch(() => {}); },
    interruptTurn: async (threadId, turnId) => { request = { threadId, turnId }; stopped = true; return { ok: true }; },
    callTool: async (...args) => {
      if (args[2] !== "read_thread") return original(...args);
      reads++;
      return { thread: { status: { type: "idle" } }, turns: [{ id: reads === 1 ? "before" : "active", status: reads === 1 ? "completed" : stopped ? "interrupted" : "inProgress", items: [] }] };
    },
  });
  assert.deepEqual(request, { threadId: "thread-a", turnId: "active" });
  assert.equal(result.turn.status, "interrupted");
});

test("stop intent during preparation prevents Desktop from receiving the model prompt", async () => {
  let control;
  const f = fixture();
  const result = await runDesktopTask({ ...f.options, onControl: value => { if (value) control = value; }, onThread: () => control.interrupt() });
  assert.equal(result.turn.status, "interrupted");
  assert.ok(!f.calls.some(call => call.tool === "send_message_to_thread"));
});

test("Desktop's manual stop is returned as an interruption, not a provider failure", async () => {
  const f = fixture({ finalStatus: "interrupted" });
  assert.equal((await runDesktopTask(f.options)).turn.status, "interrupted");
});

test("pipe discovery follows Desktop restarts and rejects ambiguous clients", () => {
  const opts = { platform: "win32", env: { CODEX_APP_TOOLS_PIPE_PATH: "old-pipe" }, list: () => ["unrelated", "codex-app-tools-a1-b2"] };
  assert.equal(findDesktopPipe(opts), "\\\\.\\pipe\\codex-app-tools-a1-b2");
  assert.equal(findDesktopPipe({ ...opts, list: () => [] }), null);
  assert.throws(() => findDesktopPipe({ ...opts, list: () => ["codex-app-tools-a1", "codex-app-tools-b2"] }), /多个 Codex/);
});

test("Desktop pipe handles fragmented UTF-8 frames and uses the app-tools protocol", async () => {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\feishu-test-${randomUUID()}` : `/tmp/feishu-${randomUUID()}.sock`;
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE(0)) return;
      const req = JSON.parse(buffer.subarray(4));
      assert.equal(req.method, "tools/call");
      assert.equal(req.params.namespace, "codex_app");
      assert.equal(req.params.threadId, "thread-a");
      const body = Buffer.from(JSON.stringify({ id: 1, jsonrpc: "2.0", result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ value: "中文" }) }] } }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      const frame = Buffer.concat([header, body]);
      socket.write(frame.subarray(0, 3));
      setImmediate(() => socket.end(frame.subarray(3)));
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  try { assert.deepEqual(await callDesktopTool(pipe, "thread-a", "read_thread", {}), { value: "中文" }); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
