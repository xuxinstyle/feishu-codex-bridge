import net from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopSessionControl, interruptDesktopTurn, startDesktopTurn, steerDesktopTurn } from "../codex-desktop-ipc.mjs";

async function serve(handler) {
  const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\feishu-ipc-test-${randomUUID()}` : `/tmp/feishu-${randomUUID()}.sock`;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    const send = message => {
      const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
      header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
    };
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const n = buffer.readUInt32LE(0), req = JSON.parse(buffer.subarray(4, n + 4)); buffer = buffer.subarray(n + 4);
        handler(req, send);
      }
    });
  });
  await new Promise(resolve => server.listen(pipePath, resolve));
  return { pipePath, close: async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

test("Desktop interruption discovers the owner and targets only the expected local turn", async () => {
  const requests = [];
  const server = await serve((req, send) => {
    requests.push(req);
    const result = req.method === "initialize" ? { clientId: "bridge-client" }
      : req.method === "thread-owner-discovery" ? {} : { ok: true, interruptedTurnId: req.params.expectedTurnId };
    send({ type: "response", requestId: req.requestId, resultType: "success", method: req.method, handledByClientId: "desktop-owner", result });
  });
  try {
    assert.equal((await interruptDesktopTurn("thread-a", "turn-a", { pipePath: server.pipePath })).ok, true);
    const stop = requests.find(r => r.method === "thread-follower-interrupt-turn");
    assert.equal(stop.version, 4);
    assert.equal(stop.targetClientId, "desktop-owner");
    assert.equal(stop.sourceClientId, "bridge-client");
    assert.deepEqual(stop.params, { conversationId: "thread-a", mode: "user-stop", expectedTurnId: "turn-a" });
    assert.equal(stop.hostId, undefined);
  } finally { await server.close(); }
});

test("missing owners fail explicitly instead of broadcasting an unsafe stop", async () => {
  const methods = [];
  const server = await serve((req, send) => {
    methods.push(req.method);
    send(req.method === "initialize" ? { type: "response", requestId: req.requestId, resultType: "success", result: { clientId: "bridge" } }
      : { type: "response", requestId: req.requestId, resultType: "error", error: "no-client-found" });
  });
  try {
    await assert.rejects(interruptDesktopTurn("thread-a", "turn-a", { pipePath: server.pipePath }), /no-client-found/);
    assert.ok(!methods.includes("thread-follower-interrupt-turn"));
  } finally { await server.close(); }
});

test("a response for a different turn is not treated as a successful interruption", async () => {
  const server = await serve((req, send) => send({ type: "response", requestId: req.requestId, resultType: "success", handledByClientId: "owner",
    result: req.method === "initialize" ? { clientId: "bridge" } : req.method === "thread-owner-discovery" ? {} : { ok: true, interruptedTurnId: "other" },
  }));
  try { await assert.rejects(interruptDesktopTurn("thread", "expected", { pipePath: server.pipePath }), /目标轮次/); }
  finally { await server.close(); }
});

test("Desktop control request timeout closes cleanly", async () => {
  const server = await serve(() => {});
  const control = new DesktopSessionControl({ pipePath: server.pipePath, timeoutMs: 20 });
  try { await assert.rejects(control.initialize(), /超时/); }
  finally { control.close(); await server.close(); }
});

test("native continuation sends local user input with model, effort and local image", async () => {
  const requests = [], submissions = [];
  const server = await serve((req, send) => {
    requests.push(req);
    const result = req.method === "initialize" ? { clientId: "bridge-client" }
      : req.method === "thread-owner-discovery" ? {} : { result: { turn: { id: "continued-turn" } } };
    send({ type: "response", requestId: req.requestId, resultType: "success", handledByClientId: "desktop-owner", result });
  });
  try {
    const result = await startDesktopTurn("thread-a", { prompt: "继续", textInputs: ["补充原文一", "补充原文二\n下一行"], imagePath: "C:\\图片.png", model: "gpt-6.1-sol", effort: "high", onSubmission: state => submissions.push(state) }, { pipePath: server.pipePath });
    assert.equal(result.turn.id, "continued-turn");
    assert.deepEqual(submissions, ["submitting", "submitted"]);
    const start = requests.find(r => r.method === "thread-follower-start-turn");
    assert.equal(start.version, 2);
    assert.equal(start.targetClientId, "desktop-owner");
    assert.equal(start.sourceClientId, "bridge-client");
    assert.equal(start.params.conversationId, "thread-a");
    const { request, context } = start.params.turnStart;
    assert.deepEqual(request.input, ["补充原文一", "补充原文二\n下一行", "继续"].map(text => ({ type: "text", text, text_elements: [] })).concat({ type: "localImage", path: "C:\\图片.png" }));
    assert.equal(request.threadId, "thread-a");
    assert.equal(request.model, "gpt-6.1-sol");
    assert.equal(request.effort, "high");
    assert.match(request.clientUserMessageId, /^[0-9a-f-]{36}$/);
    assert.equal(request.toolOutput, undefined);
    assert.deepEqual(context, { inheritThreadSettings: true });
    assert.equal(context.useUserMessageAdmission, undefined, "cloud-only admission must not be requested on a local host");
    assert.ok(!requests.some(r => r.method === "tools/call"));
  } finally { await server.close(); }
});

test("native local steering uses real input and preserves current turn settings", async () => {
  const requests = [];
  const server = await serve((req, send) => {
    requests.push(req);
    send({ type: "response", requestId: req.requestId, resultType: "success", handledByClientId: "owner",
      result: req.method === "initialize" ? { clientId: "bridge" } : req.method === "thread-owner-discovery" ? {} : { result: { turnId: "active-turn" } },
    });
  });
  try {
    const result = await steerDesktopTurn("thread", "active-turn", { prompt: "改用最新要求", cwd: "D:\\repo" }, { pipePath: server.pipePath });
    assert.equal(result.turnId, "active-turn");
    const frame = requests.find(r => r.method === "thread-follower-steer-turn");
    assert.equal(frame.version, 1);
    assert.equal(frame.targetClientId, "owner");
    const request = frame.params;
    assert.equal(request.input[0].text, "改用最新要求");
    assert.equal(request.model, undefined);
    assert.equal(request.effort, undefined);
    assert.equal(request.toolOutput, undefined);
    assert.equal(request.restoreMessage.id, request.clientUserMessageId);
    assert.equal(request.restoreMessage.text, "改用最新要求");
    assert.equal(request.restoreMessage.cwd, "D:\\repo");
    assert.deepEqual(request.restoreMessage.context.workspaceRoots, ["D:\\repo"]);
    assert.deepEqual(request.attachments, []);
    assert.ok(!requests.some(r => r.method === "thread-follower-start-turn"));
  } finally { await server.close(); }
});

test("native steering cannot confirm missing or replacement turn receipts", async () => {
  for (const admitted of [
    {},
    { turnId: "replacement-turn" },
    { turn: { id: "expected-turn" } },
  ]) {
    const server = await serve((req, send) => send({ type: "response", requestId: req.requestId, resultType: "success", handledByClientId: "owner",
      result: req.method === "initialize" ? { clientId: "bridge" } : req.method === "thread-owner-discovery" ? {} : { result: admitted },
    }));
    try { await assert.rejects(steerDesktopTurn("thread", "expected-turn", { prompt: "补充" }, { pipePath: server.pipePath }), error => error.steerOutcomeUnknown === true); }
    finally { await server.close(); }
  }
});

test("native user input with no owner fails before submitting and never falls back to delegation", async () => {
  const requests = [], submissions = [];
  const server = await serve((req, send) => {
    requests.push(req);
    send(req.method === "initialize" ? { type: "response", requestId: req.requestId, resultType: "success", result: { clientId: "bridge" } }
      : { type: "response", requestId: req.requestId, resultType: "error", error: "no-client-found" });
  });
  try {
    await assert.rejects(startDesktopTurn("thread", { prompt: "继续", onSubmission: state => submissions.push(state) }, { pipePath: server.pipePath }), /尚未加载/);
    assert.deepEqual(submissions, []);
    assert.deepEqual(requests.map(r => r.method), ["initialize", "thread-owner-discovery"]);
  } finally { await server.close(); }
});

test("native start requires a turn receipt instead of assuming an unconfirmed message succeeded", async () => {
  const submissions = [];
  const server = await serve((req, send) => send({ type: "response", requestId: req.requestId, resultType: "success", handledByClientId: "owner",
    result: req.method === "initialize" ? { clientId: "bridge" } : req.method === "thread-owner-discovery" ? {} : { result: {} },
  }));
  try {
    await assert.rejects(startDesktopTurn("thread", { prompt: "继续", onSubmission: state => submissions.push(state) }, { pipePath: server.pipePath }), error => error.submissionOutcomeUnknown === true);
    assert.deepEqual(submissions, ["submitting"]);
  } finally { await server.close(); }
});
