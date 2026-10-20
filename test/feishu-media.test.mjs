import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  sendFeishuImageMessage,
  uploadAndSendFeishuImage,
  uploadFeishuImage,
} from "../feishu-media.mjs";

test("uploads a message image and sends it to the target chat", async () => {
  const filePath = path.join(tmpdir(), `feishu-media-${process.pid}.png`);
  await writeFile(filePath, Buffer.from("fake-png"));
  const calls = [];
  const client = {
    im: {
      image: {
        create: async (payload) => {
          calls.push(["upload", payload.data.image_type, payload.data.image.path]);
          payload.data.image.destroy();
          return { image_key: "img-test" };
        },
      },
      message: {
        create: async (payload) => {
          calls.push([
            "send",
            payload.params.receive_id_type,
            payload.data.receive_id,
            payload.data.msg_type,
            JSON.parse(payload.data.content),
          ]);
          return { code: 0, data: { message_id: "om-test" } };
        },
      },
    },
  };

  const result = await uploadAndSendFeishuImage(client, "oc-test", filePath);

  assert.deepEqual(result, { imageKey: "img-test", messageId: "om-test" });
  assert.deepEqual(calls, [
    ["upload", "message", filePath],
    ["send", "chat_id", "oc-test", "image", { image_key: "img-test" }],
  ]);
});

test("image upload rejects a response without image_key", async () => {
  const filePath = path.join(tmpdir(), `feishu-media-missing-key-${process.pid}.png`);
  await writeFile(filePath, Buffer.from("fake-png"));
  const client = {
    im: {
      image: {
        create: async ({ data }) => {
          data.image.destroy();
          return {};
        },
      },
    },
  };
  await assert.rejects(
    uploadFeishuImage(client, filePath),
    /response missing image_key/
  );
});

test("image message rejects a non-zero Feishu response", async () => {
  const client = {
    im: {
      message: {
        create: async () => ({ code: 230020, msg: "message send failed" }),
      },
    },
  };
  await assert.rejects(
    sendFeishuImageMessage(client, "oc-test", "img-test"),
    /发送飞书图片失败.*230020/
  );
});
