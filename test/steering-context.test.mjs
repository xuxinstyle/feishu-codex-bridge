import assert from "node:assert/strict";
import { test } from "node:test";
import { missingSteeringInputs } from "../steering-context.mjs";

const user = (text, clientId) => ({ type: "userMessage", ...(clientId ? { clientId } : {}), content: [{ type: "text", text }] });
const delegated = { type: "functionCallOutput", name: "send_message_to_thread", output: { text: "原任务" } };
const entry = (id, prompt) => ({ id, prompt });

test("only missing acknowledged steering is restored, in original order and without synthetic instructions", () => {
  const entries = [entry("a", "已记录"), entry("b", "保留原文\n第二行"), entry("c", "另一条补充")];
  const turn = { items: [delegated, user("已记录"), { type: "agentMessage", text: "保留原文\n第二行" }] };
  assert.deepEqual(missingSteeringInputs(turn, entries, "functionCallOutput"), entries.slice(1));
});

test("opening user input cannot consume an identical subsequent steering requirement", () => {
  const entries = [entry("new-steer", "相同要求")];
  assert.deepEqual(missingSteeringInputs({ items: [user("相同要求")] }, entries, "userMessage"), entries);
  assert.deepEqual(missingSteeringInputs({ items: [user("相同要求"), user("相同要求")] }, entries, "userMessage"), []);
});

test("identical requirements use occurrence counts instead of a text set", () => {
  const entries = [entry("a", "相同"), entry("b", "相同"), entry("c", "相同")];
  assert.deepEqual(missingSteeringInputs({ items: [delegated, user("相同"), user("相同")] }, entries), [entries[2]]);
});

test("client IDs prefer exact input and unknown client IDs still allow precise text reconciliation", () => {
  const entries = [entry("client-a", "原样"), entry("client-b", "相同")];
  const turn = { items: [delegated, user("原样", "client-a"), { ...user("相同", "unrelated-client"), id: "server-id" }] };
  assert.deepEqual(missingSteeringInputs(turn, entries), []);
  assert.deepEqual(missingSteeringInputs({ items: [delegated, { ...user("其他内容"), id: "client-a" }] }, entries), entries);
});

test("each original text part consumes at most one acknowledged input even inside one identified message", () => {
  const entries = [entry("a", "同文"), entry("b", "第二条"), entry("c", "同文")];
  const combined = { type: "userMessage", clientId: "a", content: [{ type: "text", text: "同文" }, { type: "text", text: "第二条" }] };
  assert.deepEqual(missingSteeringInputs({ items: [delegated, combined] }, entries), [entries[2]]);
});

test("a prior continuation opening with several text parts is entirely excluded", () => {
  const opening = { type: "userMessage", content: [{ type: "text", text: "旧补充" }, { type: "text", text: "继续" }] };
  const entryNow = entry("new", "旧补充");
  assert.deepEqual(missingSteeringInputs({ items: [opening] }, [entryNow], "userMessage"), [entryNow]);
});

test("partial or unreadable target history cannot authorize blind steering replay", () => {
  for (const turn of [undefined, {}, { items: [] }, { items: [delegated], itemsPagination: { hasLoadedOldest: false } },
    { items: [delegated], truncated: true }, { items: [delegated, { type: "userMessage", content: [], truncated: true }] },
    { items: [delegated, { type: "userMessage" }] }]) {
    assert.throws(() => missingSteeringInputs(turn, [entry("a", "原文")]), /无法完整核对/);
  }
  assert.throws(() => missingSteeringInputs({ items: [user("开场")] }, [entry("a", "原文")], "functionCallOutput"), /无法完整核对/);
});
