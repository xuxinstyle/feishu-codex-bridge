import { createReadStream } from "node:fs";

import { assertFeishuApiSuccess } from "./bridge-core.mjs";

export async function uploadFeishuImage(client, filePath) {
  const response = await client.im.image.create({
    data: {
      image_type: "message",
      image: createReadStream(filePath),
    },
  });
  const imageKey = response?.image_key || response?.data?.image_key || "";
  if (!imageKey) {
    assertFeishuApiSuccess(response, "上传飞书图片");
    throw new Error("上传飞书图片失败: response missing image_key");
  }
  return imageKey;
}

export async function sendFeishuImageMessage(client, chatId, imageKey) {
  const response = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
    },
  });
  assertFeishuApiSuccess(response, "发送飞书图片");
  return response?.data?.message_id || "";
}

export async function uploadAndSendFeishuImage(client, chatId, filePath) {
  const imageKey = await uploadFeishuImage(client, filePath);
  const messageId = await sendFeishuImageMessage(client, chatId, imageKey);
  return { imageKey, messageId };
}
