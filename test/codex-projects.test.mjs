import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

import { discoverCodexProjectPaths } from "../codex-projects.mjs";

class FakeChild extends EventEmitter {
  constructor(onRequest) {
    super();
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
          onRequest(JSON.parse(line), this);
        }
        callback();
      },
    });
  }

  kill() {
    this.killed = true;
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

test("discoverCodexProjectPaths initializes and paginates both archived thread lists", async () => {
  const requests = [];
  let child;
  const spawnImpl = (_command, _args, _options) => {
    child = new FakeChild((request, process) => {
      requests.push(request);
      if (request.method === "initialize") {
        process.stdout.write("not-json\n");
        process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "test" } }) + "\n");
        return;
      }
      if (request.method !== "thread/list") return;
      const archived = request.params.archived;
      if (!archived && !request.params.cursor) {
        process.stdout.write(
          JSON.stringify({
            id: request.id,
            result: {
              data: [{ cwd: "E:\\Stock_Analysis" }, { cwd: "F:\\AIServer\\jx3-wiki" }],
              nextCursor: "active-page-2",
            },
          }) + "\n"
        );
        return;
      }
      if (!archived && request.params.cursor === "active-page-2") {
        process.stdout.write(
          JSON.stringify({
            id: request.id,
            result: { data: [{ cwd: "E:\\Stock_Analysis" }], nextCursor: null },
          }) + "\n"
        );
        return;
      }
      process.stdout.write(
        JSON.stringify({
          id: request.id,
          result: { data: [{ cwd: "F:\\AIServer\\jx3-cs-services" }], nextCursor: null },
        }) + "\n"
      );
    });
    return child;
  };

  const paths = await discoverCodexProjectPaths({
    codexBin: "codex",
    timeoutMs: 1000,
    spawnImpl,
  });

  assert.deepEqual(paths, [
    "E:\\Stock_Analysis",
    "F:\\AIServer\\jx3-wiki",
    "F:\\AIServer\\jx3-cs-services",
  ]);
  assert.equal(requests[0].method, "initialize");
  assert.deepEqual(
    requests
      .filter((request) => request.method === "thread/list")
      .map((request) => ({
      method: request.method,
      archived: request.params.archived,
      cursor: request.params.cursor,
      useStateDbOnly: request.params.useStateDbOnly,
      })),
    [
      { method: "thread/list", archived: false, cursor: null, useStateDbOnly: true },
      { method: "thread/list", archived: false, cursor: "active-page-2", useStateDbOnly: true },
      { method: "thread/list", archived: true, cursor: null, useStateDbOnly: true },
    ]
  );
  assert.equal(child.killed, true);
});

test("discoverCodexProjectPaths rejects App Server protocol errors and still cleans up", async () => {
  let child;
  const spawnImpl = (_command, _args, _options) => {
    child = new FakeChild((request, process) => {
      if (request.method === "initialize") {
        process.stdout.write(
          JSON.stringify({ id: request.id, result: { userAgent: "test" } }) + "\n"
        );
      } else {
        process.stdout.write(
          JSON.stringify({ id: request.id, error: { message: "thread database unavailable" } }) + "\n"
        );
      }
    });
    return child;
  };

  await assert.rejects(
    discoverCodexProjectPaths({ timeoutMs: 1000, spawnImpl }),
    /thread database unavailable/
  );
  assert.equal(child.killed, true);
});

test("discoverCodexProjectPaths rejects when App Server does not respond before timeout", async () => {
  let child;
  const spawnImpl = (_command, _args, _options) => {
    child = new FakeChild(() => {});
    return child;
  };

  await assert.rejects(
    discoverCodexProjectPaths({ timeoutMs: 20, spawnImpl }),
    /timed out.*waiting for initialize; 0 pages read/
  );
  assert.equal(child.killed, true);
});

test("project discovery preserves Chinese paths split across stdout byte chunks", async () => {
  const paths = await discoverCodexProjectPaths({ timeoutMs: 1000, spawnImpl: () => new FakeChild((request, child) => {
    if (request.method === "initialize") child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
    if (request.method !== "thread/list") return;
    const frame = Buffer.from(JSON.stringify({ id: request.id, result: { data: [{ cwd: "D:\\中文项目" }], nextCursor: null } }) + "\n");
    const split = frame.indexOf(Buffer.from("中文")) + 1;
    child.stdout.write(frame.subarray(0, split));
    child.stdout.write(frame.subarray(split));
  }) });
  assert.deepEqual(paths, ["D:\\中文项目"]);
});

test("stdin failures reject discovery promptly and shut down the child", async () => {
  let child;
  const promise = discoverCodexProjectPaths({ timeoutMs: 1000, spawnImpl: () => {
    child = new FakeChild(() => {});
    return child;
  } });
  child.stdin.emit("error", new Error("stdin closed"));
  await assert.rejects(promise, /stdin closed/);
  assert.ok(child.killed);
  // No unhandled stream error after the process was already shut down.
  child.stdin.emit("error", new Error("late EPIPE"));
});

test("stalled pagination reports the current method and completed page count", async () => {
  let calls = 0;
  const promise = discoverCodexProjectPaths({ timeoutMs: 20, spawnImpl: () => new FakeChild((request, child) => {
    if (request.method === "initialize") child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
    if (request.method === "thread/list" && calls++ === 0) child.stdout.write(JSON.stringify({ id: request.id, result: { data: [], nextCursor: "next" } }) + "\n");
  }) });
  await assert.rejects(promise, /waiting for thread\/list; 1 pages read/);
});

test("repeated pagination cursors stop discovery instead of looping until timeout", async () => {
  await assert.rejects(discoverCodexProjectPaths({ timeoutMs: 1000, spawnImpl: () => new FakeChild((request, child) => {
    if (request.method === "initialize") child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
    if (request.method === "thread/list") child.stdout.write(JSON.stringify({ id: request.id, result: { data: [], nextCursor: "repeated" } }) + "\n");
  }) }), /repeated thread\/list cursor/);
});
