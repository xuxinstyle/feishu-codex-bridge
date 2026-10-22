import net from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopSessionControl, interruptDesktopTurn } from "../codex-desktop-ipc.mjs";

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
