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
    },
    steerTurn: async (threadId, turnId, args) => { calls.push({ caller: threadId, tool: "native:steer", args: { turnId, ...args } }); return { turnId }; },
  });
  assert.equal(result.turnId, "turn-a");
  assert.deepEqual(calls.map(c => c.tool), ["read_thread", "native:steer"]);
  assert.deepEqual(calls[1].args, { turnId: "turn-a", prompt: "请先测试" });
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
    },
    steerTurn: async () => { throw new Error("pipe closed"); },
  }), error => error.steerOutcomeUnknown === true);
});

function fixture({ baselineStatus = "idle", baselineTurnStatus = "completed", baselineTurnId = "previous-turn", baselineReadError, finalStatus = "completed", prepareError } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    options: {
      pipePath: "fake-pipe", cwd: "D:\\token_hub", prompt: "用户消息", name: "[飞书] 测试",
      prepare: async () => { if (prepareError) throw prepareError; return "thread-a"; },
      startTurn: async (threadId, args) => {
        args.onSubmission?.("submitting");
        calls.push({ tool: "native:start", args: { ...args, threadId } });
        args.onSubmission?.("submitted");
        return { turn: { id: "new-turn" }, admissionOutcome: "started" };
      },
      steerTurn: async (threadId, turnId, args) => { calls.push({ tool: "native:steer", args: { threadId, turnId, ...args } }); return { turnId }; },
      callTool: async (_pipe, caller, tool, args) => {
        assert.equal(caller, "thread-a");
        calls.push({ tool, args });
        if (tool === "list_projects") return { projects: [{ projectKind: "local", hostId: "local", projectId: "desktop-project", path: "D:\\token_hub" }] };
        if (tool === "read_thread") {
          reads++;
          if (reads === 1 && baselineReadError) throw baselineReadError;
          return { thread: { status: { type: reads === 1 ? baselineStatus : "idle" } }, turns: [{
            id: reads === 1 ? baselineTurnId : "new-turn", status: reads === 1 ? baselineTurnStatus : finalStatus,
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
    return original(pipe, caller, tool, args);
  };
  const result = await runDesktopTask({ ...f.options, callTool, steerTurn: async (...args) => { dispatched = true; return f.options.steerTurn(...args); }, onControl: c => { control = c; }, onProgress: text => {
    if (text === "Codex 客户端正在执行任务。") submission = control.steer("补充要求");
  } });
  assert.equal((await submission).turnId, result.turn.id);
  assert.equal(result.output, "包含引导的结果");
  assert.equal(control, null);
  const sent = f.calls.filter(c => c.tool === "send_message_to_thread");
  assert.equal(sent.length, 1);
  assert.equal(f.calls.filter(c => c.tool === "native:steer").length, 1);
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
  const submissions = [];
  const f = fixture();
  const result = await runDesktopTask({ ...f.options, onSubmission: state => submissions.push(state), onControl: value => { if (value) control = value; }, onThread: () => control.interrupt() });
  assert.equal(result.turn.status, "interrupted");
  assert.ok(!f.calls.some(call => call.tool === "send_message_to_thread"));
  assert.deepEqual(submissions, []);
});

test("Desktop continuation checks the stopped turn and reports confirmed submission", async () => {
  const f = fixture({ baselineTurnStatus: "interrupted" });
  const submissions = [];
  await runDesktopTask({ ...f.options, threadId: "thread-a", expectedTurnId: "previous-turn", prompt: "继续",
    onSubmission: state => {
      submissions.push(state);
      assert.equal(f.calls.some(call => call.tool === "native:start"), state === "submitted");
    },
  });
  assert.deepEqual(submissions, ["submitting", "submitted"]);
  assert.equal(f.calls.find(call => call.tool === "native:start").args.prompt, "继续");
  assert.ok(!f.calls.some(call => call.tool === "send_message_to_thread"));
});

test("continuation never accepts native admission into an existing or different active turn", async () => {
  for (const admitted of [
    { turn: { id: "another-active-turn" }, admissionOutcome: "steered" },
    { turn: { id: "previous-turn" }, admissionOutcome: "started" },
    { turn: { id: "new-turn" }, admissionOutcome: "duplicate" },
  ]) {
    const f = fixture({ baselineTurnStatus: "interrupted" });
    await assert.rejects(runDesktopTask({ ...f.options, threadId: "thread-a", expectedTurnId: "previous-turn", startTurn: async () => admitted }), error => error.submissionOutcomeUnknown === true);
    assert.ok(!f.calls.some(call => call.tool === "send_message_to_thread"));
  }
});

test("Desktop continuation replays only unpersisted steering as separate original text inputs", async () => {
  const f = fixture({ baselineTurnStatus: "interrupted" });
  const original = f.options.callTool;
  let read = false;
  await runDesktopTask({ ...f.options, threadId: "thread-a", expectedTurnId: "previous-turn", prompt: "继续", expectedInitialInputKind: "functionCallOutput",
    continuationInputs: [{ id: "already", prompt: "已消费" }, { id: "missing", prompt: "未消费原文\n保留换行" }],
    callTool: async (...args) => {
      const result = await original(...args);
      if (args[2] === "read_thread" && !read) {
        read = true;
        result.turns[0].items = [{ type: "functionCallOutput", name: "send_message_to_thread" }, { type: "userMessage", content: [{ type: "text", text: "已消费" }] }];
      }
      return result;
    },
  });
  const args = f.calls.find(call => call.tool === "native:start").args;
  assert.deepEqual(args.textInputs, ["未消费原文\n保留换行"]);
  assert.equal(args.prompt, "继续");
});

test("Desktop continuation rejects replaced, unfinished, missing, or unreadable history without dispatch", async () => {
  for (const baseline of [
    { baselineTurnStatus: "interrupted", baselineTurnId: "replacement" },
    { baselineTurnStatus: "completed" },
    { baselineTurnStatus: "inProgress" },
    { baselineTurnStatus: "interrupted", baselineStatus: "active" },
    { baselineReadError: new Error("history unavailable") },
  ]) {
    const f = fixture(baseline);
    const submissions = [];
    await assert.rejects(runDesktopTask({ ...f.options, threadId: "thread-a", expectedTurnId: "previous-turn", onSubmission: state => submissions.push(state) }), /会话已有新内容或原轮次未停止/);
    assert.ok(!f.calls.some(call => call.tool === "send_message_to_thread"));
    assert.deepEqual(submissions, []);
  }
  const f = fixture();
  const original = f.options.callTool;
  await assert.rejects(runDesktopTask({ ...f.options, threadId: "thread-a", expectedTurnId: "previous-turn",
    callTool: (...args) => args[2] === "read_thread" ? {} : original(...args),
  }), /会话已有新内容或原轮次未停止/);
  assert.ok(!f.calls.some(call => call.tool === "send_message_to_thread"));
});

test("Desktop continuation without a thread cannot create a replacement conversation", async () => {
  const f = fixture();
  let prepared = false;
  await assert.rejects(runDesktopTask({ ...f.options, expectedTurnId: "previous-turn", prepare: async () => { prepared = true; return "new-thread"; } }), /会话已有新内容或原轮次未停止/);
  assert.equal(prepared, false);
  assert.deepEqual(f.calls, []);
});

test("Desktop continuation rejects preparation returning a replacement thread", async () => {
  const f = fixture();
  await assert.rejects(runDesktopTask({ ...f.options, threadId: "thread-a", expectedTurnId: "previous-turn", prepare: async () => "replacement-thread" }), /会话已有新内容或原轮次未停止/);
  assert.deepEqual(f.calls, []);
});

test("unconfirmed Desktop submission stays submitting and is not marked submitted", async () => {
  const f = fixture();
  const original = f.options.callTool;
  const submissions = [];
  await assert.rejects(runDesktopTask({ ...f.options, onSubmission: state => submissions.push(state), callTool: (...args) => {
    if (args[2] === "send_message_to_thread") throw new Error("connection closed after write");
    return original(...args);
  } }), /connection closed after write/);
  assert.deepEqual(submissions, ["submitting"]);
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
