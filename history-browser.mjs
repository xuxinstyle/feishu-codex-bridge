import { randomUUID } from "node:crypto";
import { CARD_BRIDGE_ID } from "./feishu-cards.mjs";

const plain = content => ({ tag: "plain_text", content: String(content) });
const note = content => ({ tag: "note", elements: [plain(content)] });
const actionRow = actions => ({ tag: "action", layout: "flow", actions });
const escapeText = text => String(text || "").replace(/[\\`*_\[\]<>!]/g, "\\$&");

// Only explicit user/assistant text is rendered, as escaped text. Tool output,
// instructions, reasoning, attachments and executable controls stay in Codex.
export function historyMessagePages(messages, limit = 2400) {
  const pages = [];
  let current = "";
  for (const message of messages) {
    const label = message.role === "user" ? "用户" : "Codex";
    const text = String(message.text || "");
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 900, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const block = `**${label}${offset ? "（续）" : ""}**\n${escapeText(text.slice(offset, end))}`;
      if (current && current.length + block.length + 2 > limit) { pages.push(current); current = ""; }
      current += (current ? "\n\n" : "") + block;
      offset = end;
    }
  }
  if (current) pages.push(current);
  return pages.length ? pages : ["这部分历史暂无可显示的用户消息或 Codex 回复。"];
}

export class HistoryBrowser {
  constructor({ reader, maxSnapshots = 128, maxBytes = 8 * 1024 * 1024, ttlMs = 15 * 60_000, now = Date.now }) {
    this.reader = reader;
    this.snapshots = new Map();
    this.maxSnapshots = maxSnapshots;
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.cacheBytes = 0;
    this.now = now;
    this.cleanupTimer = setInterval(() => this.prune(), Math.min(ttlMs, 60_000));
    this.cleanupTimer.unref?.();
  }

  discard(key) {
    const entry = this.snapshots.get(key);
    if (entry) this.cacheBytes -= entry.bytes;
    this.snapshots.delete(key);
  }

  prune() {
    for (const [key, entry] of this.snapshots) if (entry.expires <= this.now()) this.discard(key);
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.snapshots.clear();
    this.cacheBytes = 0;
  }

  remember(state) {
    this.prune();
    // The rendered pages already contain the text; don't keep a second copy
    // of full messages in every refresh/text-navigation snapshot.
    const { messages: _messages, ...metadata } = state.data;
    const entry = { ...state, data: metadata, expires: this.now() + this.ttlMs };
    entry.bytes = JSON.stringify(entry).length * 2;
    if (entry.bytes > this.maxBytes) throw new Error("这部分历史过长，请在 Codex 客户端查看。");
    while (this.snapshots.size >= this.maxSnapshots || this.cacheBytes + entry.bytes > this.maxBytes) this.discard(this.snapshots.keys().next().value);
    const token = randomUUID();
    this.snapshots.set(token, entry);
    this.cacheBytes += entry.bytes;
    return this.render(token);
  }

  async open(scope) {
    const data = await this.reader.list({ projectPath: scope.projectPath });
    return this.remember({ ...scope, kind: "list", data, cursors: [null], batch: 0 });
  }

  async act(value, scope) {
    this.prune();
    const state = this.snapshots.get(value.historyToken);
    if (!state || state.expires <= this.now() || ["chatId", "ownerId", "panelId", "projectPath"].some(key => state[key] !== scope[key])) {
      throw new Error("本地会话页面已过期，请重新打开本地会话。");
    }
    if (value.action === "show_history_thread") {
      if (state.kind !== "list" || !state.data.threads.some(thread => thread.id === value.threadId)) throw new Error("请从会话列表选择。");
      const data = await this.reader.read({ projectPath: scope.projectPath, threadId: value.threadId });
      return this.remember({ ...scope, kind: "thread", threadId: value.threadId, data,
        pages: historyMessagePages(data.messages), page: 0, cursors: [null], batch: 0 });
    }
    if (value.action === "show_history_text" && state.kind === "thread") {
      const page = value.historyPage;
      if (!Number.isInteger(page) || page < 0 || page >= state.pages.length) throw new Error("页码无效，请重新打开会话。");
      return this.remember({ ...state, page });
    }
    if (value.action === "show_history_refresh") {
      if (state.kind === "list") return this.open(scope);
      const data = await this.reader.read({ projectPath: scope.projectPath, threadId: state.threadId });
      return this.remember({ ...state, data, pages: historyMessagePages(data.messages), page: 0, cursors: [null], batch: 0 });
    }
    if (value.action !== "show_history_batch" || !["older", "newer"].includes(value.direction)) throw new Error("本地会话操作无效。");
    const batch = state.batch + (value.direction === "older" ? 1 : -1);
    if (batch < 0 || batch > state.cursors.length || batch > state.batch && !state.data.nextCursor) throw new Error("没有更多历史。");
    const cursors = state.cursors.slice(0, state.batch + 1);
    if (batch > state.batch) cursors.push(state.data.nextCursor);
    const cursor = cursors[batch];
    const data = state.kind === "list"
      ? await this.reader.list({ projectPath: scope.projectPath, cursor })
      : await this.reader.read({ projectPath: scope.projectPath, threadId: state.threadId, cursor });
    return this.remember({ ...state, data, cursors, batch, page: 0,
      ...(state.kind === "thread" ? { pages: historyMessagePages(data.messages) } : {}) });
  }

  render(token) {
    const state = this.snapshots.get(token);
    const btn = (label, action, extra = {}) => ({ tag: "button", text: plain(label), type: "default", value: {
      bridge: CARD_BRIDGE_ID, scopeChatId: state.chatId, projectPath: state.projectPath,
      action, historyToken: token, ...extra,
    } });
    const elements = [note("只读 · 查看不会切换当前任务会话；直接发消息仍使用飞书当前会话。")];
    if (state.kind === "list") {
      elements.push(note(`当前项目：${state.projectPath.split(/[\\/]/).filter(Boolean).at(-1)} · 按最近更新排序`));
      for (const thread of state.data.threads) elements.push(actionRow([btn(String(thread.title || "未命名会话").slice(0, 70), "show_history_thread", { threadId: thread.id })]));
      if (!state.data.threads.length) elements.push(note("此页没有其他本地会话，可翻页或切换项目。"));
    } else {
      elements.push(note(state.data.thread.title || "未命名会话"));
      elements.push({ tag: "markdown", content: state.pages[state.page] });
      elements.push(note(`当前批次按时间顺序显示 · 内容 ${state.page + 1}/${state.pages.length}`));
      const pages = [];
      if (state.page > 0) pages.push(btn("上一段", "show_history_text", { historyPage: state.page - 1 }));
      if (state.page + 1 < state.pages.length) pages.push(btn("下一段", "show_history_text", { historyPage: state.page + 1 }));
      if (pages.length) elements.push(actionRow(pages));
    }
    const batches = [];
    if (state.batch > 0) batches.push(btn("较新记录", "show_history_batch", { direction: "newer" }));
    if (state.data.nextCursor) batches.push(btn("更早记录", "show_history_batch", { direction: "older" }));
    if (batches.length) elements.push(actionRow(batches));
    elements.push(actionRow([btn("刷新", "show_history_refresh"), btn("会话列表", "show_history")]));
    elements.push(actionRow([btn("返回首页", "show_home")]));
    return { config: { wide_screen_mode: true, update_multi: true },
      header: { template: "blue", title: plain(state.kind === "list" ? "本地会话（只读）" : "聊天记录（只读）") }, elements };
  }
}
