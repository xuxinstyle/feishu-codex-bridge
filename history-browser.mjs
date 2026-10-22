import { randomUUID } from "node:crypto";
import { CARD_BRIDGE_ID } from "./feishu-cards.mjs";

const plain = content => ({ tag: "plain_text", content: String(content) });
const note = content => ({ tag: "note", elements: [plain(content)] });
const actionRow = actions => ({ tag: "action", layout: "flow", actions });
const escapeText = text => String(text || "").replace(/[\\`*_\[\]<>!]/g, "\\$&");
const projectLabel = value => String(value || "").split(/[\\/]/).filter(Boolean).at(-1) || "未分组";
const updatedLabel = value => Number.isFinite(value) && value > 0 ? new Date(value * 1000).toLocaleString("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
}) : "";

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

  async open(scope, { allProjects = false } = {}) {
    if (typeof allProjects !== "boolean") throw new Error("查看范围无效。");
    const data = await this.reader.list({ projectPath: scope.projectPath, allProjects });
    return this.remember({ ...scope, kind: "list", allProjects, data, cursors: [null], batch: 0 });
  }

  async act(value, scope) {
    this.prune();
    const state = this.snapshots.get(value.historyToken);
    if (!state || state.expires <= this.now() || ["chatId", "ownerId", "panelId", "projectPath"].some(key => state[key] !== scope[key])) {
      throw new Error("本地会话页面已过期，请重新打开本地会话。");
    }
    if (value.action === "show_history_scope") {
      if (typeof value.allProjects !== "boolean") throw new Error("查看范围无效。");
      return this.open(scope, { allProjects: value.allProjects });
    }
    if (value.action === "show_history_list") {
      const list = this.snapshots.get(state.listToken);
      if (list?.kind === "list" && ["chatId", "ownerId", "panelId", "projectPath"].every(key => list[key] === scope[key])) return this.remember(list);
      return this.open(scope, { allProjects: state.allProjects });
    }
    if (value.action === "show_history_thread") {
      const selected = state.kind === "list" && state.data.threads.find(thread => thread.id === value.threadId);
      if (!selected) throw new Error("请从会话列表选择。");
      if (state.allProjects && (typeof selected.cwd !== "string" || !selected.cwd.trim())) throw new Error("会话项目未确认，请刷新列表。");
      const threadProjectPath = state.allProjects ? selected.cwd : scope.projectPath;
      const data = await this.reader.read({ projectPath: threadProjectPath, threadId: selected.id });
      return this.remember({ ...scope, kind: "thread", threadId: value.threadId, data,
        threadProjectPath, allProjects: state.allProjects, listToken: value.historyToken,
        pages: historyMessagePages(data.messages), page: 0, cursors: [null], batch: 0 });
    }
    if (value.action === "show_history_text" && state.kind === "thread") {
      const page = value.historyPage;
      if (!Number.isInteger(page) || page < 0 || page >= state.pages.length) throw new Error("页码无效，请重新打开会话。");
      return this.remember({ ...state, page });
    }
    if (value.action === "show_history_refresh") {
      if (state.kind === "list") return this.open(scope, { allProjects: state.allProjects });
      const data = await this.reader.read({ projectPath: state.threadProjectPath, threadId: state.threadId });
      return this.remember({ ...state, data, pages: historyMessagePages(data.messages), page: 0, cursors: [null], batch: 0 });
    }
    if (value.action !== "show_history_batch" || !["older", "newer"].includes(value.direction)) throw new Error("本地会话操作无效。");
    const batch = state.batch + (value.direction === "older" ? 1 : -1);
    if (batch < 0 || batch > state.cursors.length || batch > state.batch && !state.data.nextCursor) throw new Error("没有更多历史。");
    const cursors = state.cursors.slice(0, state.batch + 1);
    if (batch > state.batch) cursors.push(state.data.nextCursor);
    const cursor = cursors[batch];
    const data = state.kind === "list"
      ? await this.reader.list({ projectPath: scope.projectPath, allProjects: state.allProjects, cursor })
      : await this.reader.read({ projectPath: state.threadProjectPath, threadId: state.threadId, cursor });
    return this.remember({ ...state, data, cursors, batch, page: 0,
      ...(state.kind === "thread" ? { pages: historyMessagePages(data.messages) } : {}) });
  }

  async attachment(value, scope) {
    this.prune();
    const state = this.snapshots.get(value.historyToken);
    if (!state || state.kind !== "thread" || ["chatId", "ownerId", "panelId", "projectPath"].some(key => state[key] !== scope[key])) {
      throw new Error("会话页面已过期，请重新选择要附加的会话。");
    }
    return this.reader.inspect({ projectPath: state.threadProjectPath, threadId: state.threadId });
  }

  render(token) {
    const state = this.snapshots.get(token);
    const btn = (label, action, extra = {}) => ({ tag: "button", text: plain(label), type: "default", value: {
      bridge: CARD_BRIDGE_ID, scopeChatId: state.chatId, projectPath: state.projectPath,
      action, historyToken: token, ...extra,
    } });
    const elements = [note("浏览不会切换当前任务会话；点击附加后，消息才会进入选中的 Codex 会话。")];
    if (state.kind === "list") {
      elements.push(note(`${state.allProjects ? "全部项目" : `当前项目：${projectLabel(state.projectPath)}`} · 按最近更新排序`));
      elements.push(actionRow([btn(state.allProjects ? "仅当前项目" : "全部项目", "show_history_scope", { allProjects: !state.allProjects })]));
      for (const thread of state.data.threads) {
        elements.push(actionRow([btn(String(thread.title || "未命名会话").slice(0, 70), "show_history_thread", { threadId: thread.id })]));
        const details = [state.allProjects && projectLabel(thread.cwd), updatedLabel(thread.updatedAt)].filter(Boolean);
        if (details.length) elements.push(note(details.join(" · ")));
      }
      if (!state.data.threads.length) elements.push(note(state.data.nextCursor ? "此页暂无符合条件的会话，可点击更早记录继续查找。" : "没有找到其他 Codex 会话，可切换查看范围或刷新。"));
    } else {
      elements.push(note(state.data.thread.title || "未命名会话"));
      elements.push(note(`来源项目：${projectLabel(state.threadProjectPath)}`));
      elements.push({ tag: "markdown", content: state.pages[state.page] });
      elements.push(note(`当前批次按时间顺序显示 · 内容 ${state.page + 1}/${state.pages.length}`));
      const pages = [];
      if (state.page > 0) pages.push(btn("上一段", "show_history_text", { historyPage: state.page - 1 }));
      if (state.page + 1 < state.pages.length) pages.push(btn("下一段", "show_history_text", { historyPage: state.page + 1 }));
      if (pages.length) elements.push(actionRow(pages));
      const attach = btn("附加到飞书", "attach_history");
      attach.type = "primary";
      attach.confirm = { title: plain("附加此会话？"), text: plain("后续飞书消息将在此原会话中继续；当前任务项目会切换到该会话目录，原飞书会话仍保留。") };
      elements.push(actionRow([attach]));
    }
    const batches = [];
    if (state.batch > 0) batches.push(btn("较新记录", "show_history_batch", { direction: "newer" }));
    if (state.data.nextCursor) batches.push(btn("更早记录", "show_history_batch", { direction: "older" }));
    if (batches.length) elements.push(actionRow(batches));
    elements.push(actionRow([btn("刷新", "show_history_refresh"), btn("会话列表", "show_history_list")]));
    elements.push(actionRow([btn("返回首页", "show_home")]));
    return { config: { wide_screen_mode: true, update_multi: true },
      header: { template: "blue", title: plain(state.kind === "list" ? "本地会话（只读）" : "聊天记录（只读）") }, elements };
  }
}
