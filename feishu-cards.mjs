export const CARD_BRIDGE_ID = "feishu-codex-bridge";
const STATUS = {
  pending: ["等待执行", "grey"], running: ["正在执行", "blue"], stopping: ["正在停止…", "orange"],
  interrupted: ["已停止", "orange"], success: ["已完成", "green"], failed: ["执行失败", "red"],
  cancelled: ["已取消排队", "grey"], steered: ["已补充给当前任务", "turquoise"], steer_unknown: ["等待核对", "orange"],
};
const md = content => ({ tag: "markdown", content });
const note = content => ({ tag: "note", elements: [{ tag: "plain_text", content }] });
const clean = text => String(text || "").replace(/[\\*_\[\]<>]/g, "\\$&");
const short = (text, limit = 90) => String(text || "").trim().split(/\r?\n/)[0].slice(0, limit);
const button = (label, action, scope, extra = {}, type = "default", confirm) => ({
  tag: "button", text: { tag: "plain_text", content: label }, type,
  value: { bridge: CARD_BRIDGE_ID, ...scope, action, ...extra }, ...(confirm ? { confirm } : {}),
});
const row = actions => actions.length ? { tag: "action", layout: "flow", actions } : null;
const rows = actions => Array.from({ length: Math.ceil(actions.length / 2) }, (_, i) => row(actions.slice(i * 2, i * 2 + 2)));
const shell = (title, color, elements) => ({
  config: { wide_screen_mode: true, update_multi: true },
  header: { template: color, title: { tag: "plain_text", content: title } }, elements: elements.filter(Boolean),
});
const sessionLabel = name => name === "default" ? "默认会话" : /^session-\d{6}$/.test(name || "") ? `会话 ${name.slice(8)}` : name;
const stateLabel = status => STATUS[status]?.[0] || "等待任务";
const reasoningLabel = value => ({ none: "不额外推理", minimal: "极低", low: "低", medium: "标准", high: "高", xhigh: "更高", max: "最高", ultra: "超强" })[value] || value || "默认";
const duration = (task, now) => {
  const secs = Math.max(0, Math.floor(((task.finishedAt || now) - (task.startedAt || now)) / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`;
};

export function buildTaskCard(task, { projectLabel, pendingCount = 0, paused = false, text = "", now = Date.now() } = {}) {
  const [status, color] = task.status === "interrupted" && task.resumedAs ? ["已继续", "blue"]
    : task.status === "running" && task.resumeFromTaskId ? ["正在继续", "blue"] : STATUS[task.status] || STATUS.pending;
  const scope = { scopeChatId: task.source.chatId, projectPath: task.projectPath, sessionName: task.sessionName, taskId: task.taskId, generation: task.generation };
  const actions = [];
  if (task.status === "pending") {
    if (task.steerTargetTaskId && !task.imageKey) actions.push(button("补充给当前任务", "steer_task", scope, {}, "primary"));
    actions.push(button("取消排队", "stop_task", scope));
  } else if (task.status === "running") actions.push(button(task.stopError ? "重试停止" : "停止当前任务", "stop_task", scope, {}, "danger"));
  else if (task.status === "stopping" && task.stopError) actions.push(button("重试停止", "stop_task", scope, {}, "danger"));
  else if (task.status === "interrupted" && !task.resumedAs) actions.push(button("继续当前任务", "resume_task", scope, {}, "primary"));
  if (pendingCount) actions.push(button(`查看待办 ${pendingCount}`, "show_queue", scope));
  const metadata = [`${projectLabel || task.projectPath.split(/[\\/]/).at(-1)} / ${sessionLabel(task.sessionName)}`];
  if (task.startedAt) metadata.push(`用时 ${duration(task, now)}`);
  if (paused && pendingCount > 0) metadata.push("待办已暂停");
  const fallback = task.status === "pending" ? "轮到这条消息时会自动开始。" : task.status === "running" ? "正在准备任务。" : "";
  const body = task.status === "interrupted" && task.resumedAs ? "" : text || task.output || task.progress || fallback;
  const redundant = (task.status === "interrupted" && ["当前任务已停止。", "当前任务已停止", "任务已停止"].includes(body)) ||
    (task.status === "stopping" && /^正在(请求)?停止/.test(body));
  return shell(status, color, [
    md(`**${clean(short(task.prompt))}**`), note(metadata.join(" · ")),
    !body || redundant ? null : md(body.slice(0, 3500)),
    task.stopError ? md("**暂未确认停止**\n可重试，或在 Codex 客户端检查当前任务。") : null,
    task.status === "interrupted" && !task.resumedAs ? note("上下文已保留；独立后台命令需单独停止。") : null,
    ...rows(actions),
  ]);
}

export function buildPanelCard(state) {
  const { chatId, projectPath, projectLabel, sessionName, task, notice, view = "home", page = 0 } = state;
  const entries = view === "projects" ? state.projects || [] : view === "models" ? state.models || [] :
    view === "sessions" ? state.sessions || [] : view === "queue" ? state.queued || [] : [];
  const pageSize = view === "queue" ? 6 : 8;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const selectedPage = Math.max(0, Math.min(Math.floor(Number(page) || 0), pageCount - 1));
  const pageEntries = entries.slice(selectedPage * pageSize, (selectedPage + 1) * pageSize);
  const scope = { scopeChatId: chatId, projectPath, sessionName, view, page: selectedPage };
  const btn = (label, action, extra = {}, type = "default", confirm) => button(label, action, scope, extra, type, confirm);
  const back = row([btn("返回首页", "show_home", { page: 0 })]);
  const backSettings = row([btn("返回设置", "show_settings", { page: 0 })]);
  const pagination = action => pageCount > 1 ? [note(`第 ${selectedPage + 1} / ${pageCount} 页`), row([
    ...(selectedPage > 0 ? [btn("上一页", action, { page: selectedPage - 1 })] : []),
    ...(selectedPage < pageCount - 1 ? [btn("下一页", action, { page: selectedPage + 1 })] : []),
  ])] : [];
  const message = notice ? md(clean(notice)) : null;
  const context = note(`${projectLabel} / ${sessionLabel(sessionName)}`);
  if (view === "projects" || view === "models") {
    const projects = view === "projects";
    const choices = projects ? pageEntries.map(p => ({ label: p.alias, value: p.path })) : pageEntries.map(m => ({ label: m, value: m }));
    const selected = projects ? projectPath : state.model;
    const choicesButtons = choices.map(item => btn(
      `${item.value === selected ? "✓ " : ""}${item.label}`, projects ? "set_project" : "set_model",
      projects ? { targetProjectPath: item.value } : { model: item.value }, item.value === selected ? "primary" : "default"));
    return shell(projects ? "切换项目" : "选择模型", "blue", [message, context, ...rows(choicesButtons),
      !entries.length ? md(projects ? "暂无项目，点击刷新列表重试。" : "暂无可选模型，可发送 /model 模型名。") : null,
      ...pagination(projects ? "show_projects" : "show_models"),
      projects ? row([btn("刷新列表", "refresh")]) : null, projects ? back : backSettings]);
  }
  if (view === "settings") return shell("会话设置", "blue", [message, context,
    md(`**模型**\n${clean(state.model || "使用默认配置")}\n\n**推理强度**\n${clean(reasoningLabel(state.reasoning))}`),
    row([btn("选择模型", "show_models"), btn("推理强度", "show_reasoning")]),
    row([btn("恢复默认", "reset_settings"), btn("重置会话", "reset_active_session", {}, "danger", {
      title: { tag: "plain_text", content: "重置会话？" }, text: { tag: "plain_text", content: "下一条消息会开启新上下文，历史聊天仍保留。" },
    })]), note("设置用于后续新任务，继续任务沿用原配置。"), back]);
  if (view === "reasoning") return shell("推理强度", "blue", [message, context,
    ...rows(state.reasoningChoices.map(e => btn(`${e === state.reasoning ? "✓ " : ""}${reasoningLabel(e)}`, "set_reasoning", { reasoningEffort: e }, e === state.reasoning ? "primary" : "default"))), backSettings]);
  if (view === "sessions") return shell("切换会话", "blue", [message, note(projectLabel),
    ...pageEntries.map(s => row([btn(`${s.name === sessionName ? "✓ " : ""}${sessionLabel(s.name)} · ${s.summary ? short(s.summary, 38) : stateLabel(s.status)}`,
      "use_session", { sessionName: s.name }, s.name === sessionName ? "primary" : "default")])),
    ...pagination("show_sessions"),
    row([btn("新建会话", "new_session", {}, "primary")]), back]);
  if (view === "queue") {
    const queued = state.queued || [];
    const items = pageEntries.flatMap(item => [md(clean(short(item.prompt, 110))),
      row([btn("取消这条", "stop_task", { taskId: item.taskId, generation: item.generation })])]);
    return shell(`待办 ${queued.length}`, "blue", [message, context, queued.length ? note(state.paused ? "待办已暂停，只有主动选择后才会执行。" : "待办会按顺序执行。") : null,
      ...(items.length ? items : [md("当前没有待办。")]), ...pagination("show_queue"),
      state.paused && queued.length ? row([btn("按顺序执行待办", "resume_queue", {}, "primary")]) : null, back]);
  }
  if (view === "help") return shell("使用帮助", "blue", [message, context,
    md("**开始任务**\n直接发送文字或图片，使用当前项目和会话。"),
    md("**停止与继续**\n点击任务卡的停止按钮，或发送 /stop。停止后点击继续，或发送 /resume；会在保留上下文的新一轮中续作，已完成的修改不会撤销。"),
    md("**补充要求**\n任务执行时发送 /steer 补充要求，或发送消息后点击「补充给当前任务」。普通消息会排队。"),
    md("**新建会话与待办**\n点击新建会话，开启独立上下文。停止后旧待办保持暂停，在待办页选择恢复执行。"), back]);
  const actions = [];
  if (task && (["running", "pending"].includes(task.status) || task.status === "stopping" && task.stopError)) actions.push(btn(task.status === "pending" ? "取消排队" : task.stopError ? "重试停止" : "停止当前任务", "stop_task",
    { taskId: task.taskId, generation: task.generation }, "danger"));
  if (task?.status === "interrupted" && !task.resumedAs) actions.push(btn("继续当前任务", "resume_task", { taskId: task.taskId, generation: task.generation }, "primary"));
  const color = ["interrupted", "stopping"].includes(task?.status) ? "orange" : task ? "blue" : "grey";
  return shell("Codex", color, [message, md(`**${clean(projectLabel)}** / ${clean(sessionLabel(sessionName))}`),
    note(`${state.model || "默认模型"} · 推理${reasoningLabel(state.reasoning)}`),
    task ? md(`**${stateLabel(task.status)}**\n${clean(short(task.prompt, 130))}`) : md("直接发送消息，开始一个任务。"),
    task?.stopError ? note("停止结果尚未确认，可重试或在客户端检查。") : null,
    state.paused && state.queued?.length ? note("旧待办仍暂停，可在待办中恢复。") : null,
    ...rows(actions), { tag: "hr" }, row([btn("切换项目", "show_projects"), btn("切换会话", "show_sessions")]),
    row([btn("新建会话", "new_session"), btn(`待办 ${state.queued?.length || 0}`, "show_queue")]),
    row([btn("设置", "show_settings"), btn("使用帮助", "show_help")]),
  ]);
}
