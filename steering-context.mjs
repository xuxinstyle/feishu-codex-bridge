const inputKind = item => ["userMessage", "functionCallOutput"].includes(item?.type);
const unreadable = () => new Error("无法完整核对已停止轮次的补充要求，请在 Codex 客户端检查后继续。");

// A steer ACK can precede history persistence. Reconcile only this stopped
// turn, never a whole-thread search that could confuse older identical input.
export function missingSteeringInputs(turn, entries = [], initialInputKind) {
  if (!entries.length) return [];
  if (!Array.isArray(turn?.items) || turn.itemsPagination?.hasLoadedOldest === false || turn.itemsTruncated || turn.truncated) throw unreadable();
  const records = entries.map(entry => {
    if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.prompt !== "string" || !entry.prompt.trim()) throw unreadable();
    return entry;
  });
  const openingIndex = turn.items.findIndex(inputKind);
  if (openingIndex < 0) throw unreadable();
  const opening = turn.items[openingIndex];
  if (initialInputKind && opening.type !== initialInputKind) throw unreadable();
  const slots = [];
  for (const [index, item] of turn.items.entries()) {
    if (item.type !== "userMessage" || index === openingIndex) continue;
    if (item.truncated || !Array.isArray(item.content)) throw unreadable();
    for (const part of item.content) {
      if (part.type !== "text") continue;
      if (part.truncated || typeof part.text !== "string") throw unreadable();
      slots.push({ clientId: item.clientId, text: part.text, used: false });
    }
  }
  return records.filter(entry => {
    const slot = slots.find(slot => !slot.used && slot.clientId === entry.id && slot.text === entry.prompt)
      || slots.find(slot => !slot.used && slot.text === entry.prompt);
    if (!slot) return true;
    slot.used = true;
    return false;
  });
}
