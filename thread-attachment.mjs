import { historyProjectPath } from "./codex-history.mjs";
import { callDesktopTool, findDesktopPipe } from "./codex-desktop.mjs";

// A standalone history server reports notLoaded for Desktop-owned threads.
// Ask Desktop itself before changing any local Feishu binding.
export async function inspectAttachmentRuntime(thread, { pipePath = findDesktopPipe(), callTool = callDesktopTool } = {}) {
  if (!pipePath) throw new Error("请先打开 Codex 客户端，再附加会话。");
  const result = await callTool(pipePath, thread.id, "read_thread", { threadId: thread.id, hostId: "local", turnLimit: 1 });
  if (result.thread?.id !== thread.id || historyProjectPath(result.thread.cwd).key !== historyProjectPath(thread.cwd).key) {
    throw new Error("会话目录已变化，请刷新列表后重新附加。");
  }
  const status = result.thread.status?.type;
  if (status === "active" || result.turns?.[0]?.status === "inProgress") throw new Error("这条 Codex 会话正在执行任务，请结束后再附加。");
  if (!["idle", "notLoaded"].includes(status)) throw new Error("客户端尚未确认会话可用，请在客户端检查后重试。");
  return thread;
}
