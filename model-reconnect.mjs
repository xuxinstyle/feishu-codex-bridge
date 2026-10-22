// This gateway rejection happens before inference. Never replay a failed turn
// that has produced assistant output or executed a tool, or any generic error.
export function isModelReconnectRejection(turn) {
  if (turn?.status !== "failed" || !Array.isArray(turn.items)) return false;
  try {
    const response = JSON.parse(turn.error?.message);
    return response.error?.code === "model_change_requires_reconnect" && response.status === 400 &&
      turn.items.every(item => item.type === "userMessage" ||
        item.type === "functionCallOutput" && item.namespace === "codex_app" && item.name === "send_message_to_thread");
  } catch { return false; }
}
