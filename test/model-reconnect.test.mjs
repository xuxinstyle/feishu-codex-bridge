import assert from "node:assert/strict";
import { test } from "node:test";
import { runDesktopTask } from "../codex-desktop.mjs";
import { isModelReconnectRejection } from "../model-reconnect.mjs";

const rejected = { id: "rejected", status: "failed", items: [{ type: "functionCallOutput", namespace: "codex_app", name: "send_message_to_thread" }],
  error: { message: JSON.stringify({ error: { code: "model_change_requires_reconnect" }, status: 400 }) } };

test("only the exact pre-inference model rejection is safe to replay", () => {
  assert.equal(isModelReconnectRejection(rejected), true);
  for (const patch of [
    { status: "interrupted" }, { error: { message: "network timeout" } }, { error: { message: "model_change_requires_reconnect" } },
    { error: { message: JSON.stringify({ error: { code: "model_change_requires_reconnect" }, status: 500 }) } },
    ...["agentMessage", "functionCall", "commandExecution", "mcpToolCall", "fileChange"].map(type => ({ items: [{ type }] })),
    { items: [{ type: "functionCallOutput", namespace: "shell", name: "exec" }] },
  ]) assert.equal(isModelReconnectRejection({ ...rejected, ...patch }), false);
});

function fixture({ secondFailure = false, beforeRetry, observedRejection = rejected } = {}) {
  let reads = 0, sends = 0;
  const calls = [], started = [], controls = [], interrupts = [];
  const options = { pipePath: "pipe", cwd: "repo", prompt: "original prompt", model: "gpt-5.6-sol", effort: "low", pollIntervalMs: 0,
    prepare: async () => "thread", onTurnStarted: ({ turnId }) => started.push(turnId), onControl: control => controls.push(control),
    interruptTurn: async (threadId, turnId) => { interrupts.push({ threadId, turnId }); return {}; },
    callTool: async (_p, _t, tool, args) => {
      calls.push({ tool, args });
      if (tool === "send_message_to_thread") { sends++; return {}; }
      if (tool === "list_projects") return { projects: [] };
      if (tool === "read_thread") {
        reads++;
        if (reads === 1) return { turns: [] };
        if (sends === 1) {
          if (reads === 3 && beforeRetry) return beforeRetry(controls.at(-1));
          return { turns: [observedRejection] };
        }
        return { turns: [secondFailure ? { ...rejected, id: "retry" } : { id: "retry", status: "completed", items: [{ type: "agentMessage", text: "done" }] }] };
      }
    },
  };
  return { options, calls, started, controls, interrupts };
}

test("Desktop retries one rejected model request with the same thread, model, effort and prompt", async () => {
  const f = fixture();
  const result = await runDesktopTask(f.options);
  assert.equal(result.output, "done");
  const sends = f.calls.filter(call => call.tool === "send_message_to_thread");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1].args, sends[0].args);
  assert.deepEqual(f.started, ["rejected", "retry"]);
  assert.equal(f.controls.at(-1), null);
});

test("a second model rejection fails instead of looping", async () => {
  const f = fixture({ secondFailure: true });
  await assert.rejects(runDesktopTask(f.options), /model_change_requires_reconnect/);
  assert.equal(f.calls.filter(call => call.tool === "send_message_to_thread").length, 2);
});

test("existing conversations are never replayed automatically", async () => {
  const f = fixture();
  await assert.rejects(runDesktopTask({ ...f.options, threadId: "thread" }), /model_change_requires_reconnect/);
  assert.equal(f.calls.filter(call => call.tool === "send_message_to_thread").length, 1);
});

test("stop control after reconnect targets the new turn", async () => {
  const f = fixture();
  const original = f.options.callTool;
  let stopping;
  const result = await runDesktopTask({ ...f.options,
    onTurnStarted: ({ turnId }) => { if (turnId === "retry") stopping = f.controls.at(-1).interrupt(); },
    callTool: async (...args) => {
      const result = await original(...args);
      if (result?.turns?.[0]?.id === "retry") {
        result.turns[0].status = f.interrupts.length ? "interrupted" : "inProgress";
      }
      return result;
    },
  });
  await stopping;
  assert.equal(result.turn.status, "interrupted");
  assert.deepEqual(f.interrupts, [{ threadId: "thread", turnId: "retry" }]);
});

test("retry refuses replacement history and respects a stop request", async () => {
  const changed = fixture({ beforeRetry: () => ({ turns: [{ id: "replacement" }] }) });
  await assert.rejects(runDesktopTask(changed.options), /会话已变化/);
  assert.equal(changed.calls.filter(call => call.tool === "send_message_to_thread").length, 1);
  const stopped = fixture({ beforeRetry: control => { control.interrupt(); return { turns: [rejected] }; } });
  assert.equal((await runDesktopTask(stopped.options)).turn.status, "interrupted");
  assert.equal(stopped.calls.filter(call => call.tool === "send_message_to_thread").length, 1);
});

test("Desktop never replays a rejection after assistant output or tool execution", async () => {
  for (const type of ["agentMessage", "commandExecution"]) {
    const f = fixture({ observedRejection: { ...rejected, items: [{ type, text: "already started" }] } });
    await assert.rejects(runDesktopTask(f.options), /model_change_requires_reconnect/);
    assert.equal(f.calls.filter(call => call.tool === "send_message_to_thread").length, 1);
  }
});
