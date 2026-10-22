import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { buildPanelCard, buildTaskCard } from "../feishu-cards.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const task = { taskId: "task-demo", generation: "demo", source: { chatId: "demo" }, projectPath: "D:\\token_hub", sessionName: "接口检查",
  prompt: "检查接口并运行相关测试", status: "running", startedAt: Date.now() - 83_000, progress: "已找到接口校验逻辑，正在运行相关测试。" };
const state = { chatId: "demo", projectPath: task.projectPath, projectLabel: "token_hub", sessionName: task.sessionName, task,
  model: "gpt-6.1-sol", reasoning: "high", reasoningChoices: ["low", "medium", "high", "xhigh"], models: ["gpt-6.1-sol", "gpt-6-astra", "grok-4.6"],
  projects: ["token_hub", "jx3-wiki", "jx3-cs-services", ...Array.from({ length: 14 }, (_, i) => `示例项目 ${i + 4}`)].map(alias => ({ alias, path: `D:\\${alias}` })),
  sessions: [{ name: "接口检查", status: "running", summary: "检查接口并运行相关测试" }, { name: "default", status: "idle", summary: "日常问题与代码讨论" },
    ...Array.from({ length: 13 }, (_, i) => ({ name: `会话${i + 1}`, status: "success", summary: ["定位登录状态异常", "补充接口文档", "优化消息列表查询", "核对发布配置"][i % 4] }))],
  queued: Array.from({ length: 8 }, (_, i) => ({ ...task, taskId: `queued-${i + 1}`, generation: `queued-g-${i + 1}`,
    prompt: ["补充接口文档", "整理本次修改", "检查项目启动说明", "运行相关回归测试"][i % 4] + `（${i + 1}）`, status: "pending" })),
};
const views = { home: "会话首页", projects: "项目", sessions: "会话", queue: "待办", settings: "设置", models: "模型", reasoning: "推理", help: "帮助",
  running: "运行中", stopping: "停止中", stopped: "已停止" };
const cards = Object.fromEntries(Object.keys(views).map(view => [view, ["running", "stopping", "stopped"].includes(view)
  ? buildTaskCard({ ...task, status: view === "stopped" ? "interrupted" : view }, { projectLabel: state.projectLabel, pendingCount: state.queued.length, paused: view !== "running" })
  : buildPanelCard({ ...state, view })]));

// Keep the standalone preview on the same renderer as the production cards.
const rendererSource = readFileSync(path.join(root, "feishu-cards.mjs"), "utf8").replace(/^export /gm, "").replaceAll("</script", "<\\/script");
function browserDemo(initialState) {
  const initial = structuredClone(initialState);
  let demo = structuredClone(initialState), view = "home", page = 0, renderedButtons = [], transition = 0;
  const projectStates = new Map(), sessionStates = new Map();
  const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const feedback = text => { document.getElementById("feedback").textContent = text; };
  const saveSession = () => sessionStates.set(demo.projectPath + "::" + demo.sessionName,
    structuredClone({ task: demo.task, queued: demo.queued, paused: demo.paused }));
  const saveProject = () => projectStates.set(demo.projectPath, structuredClone({ sessionName: demo.sessionName, task: demo.task, sessions: demo.sessions, queued: demo.queued, paused: demo.paused }));
  function render() {
    renderedButtons = [];
    const taskView = ["running", "stopping", "stopped"].includes(view);
    const card = taskView ? buildTaskCard(demo.task || { ...initial.task, projectPath: demo.projectPath, sessionName: demo.sessionName }, {
      projectLabel: demo.projectLabel, pendingCount: demo.queued.length, paused: demo.paused,
    }) : buildPanelCard({ ...demo, view, page });
    document.querySelectorAll("nav button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
    document.getElementById("card").innerHTML = '<div class="header ' + escapeHtml(card.header.template) + '">' + escapeHtml(card.header.title.content) + '</div><div class="body">' +
      card.elements.map(element => element.tag === "markdown" ? '<div class="md">' + escapeHtml(element.content).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\\([\\*_\[\]])/g, "$1") + '</div>' :
        element.tag === "note" ? '<div class="note">' + escapeHtml(element.elements.map(text => text.content).join(" ")) + '</div>' :
          element.tag === "hr" ? '<hr>' : element.tag === "action" ? '<div class="actions">' + element.actions.map(button => {
            const index = renderedButtons.push(button) - 1;
            return '<button class="' + escapeHtml(button.type) + '" data-button="' + index + '">' + escapeHtml(button.text.content) + '</button>';
          }).join("") + '</div>' : "").join("") + '</div>';
    requestAnimationFrame(checkMobile);
  }
  function checkMobile() {
    const card = document.getElementById("card");
    const buttons = [...card.querySelectorAll("button")];
    const overflow = card.scrollWidth > card.clientWidth + 1 || buttons.some(button => button.scrollWidth > button.clientWidth + 1);
    const touchable = buttons.every(button => button.getBoundingClientRect().height >= 40);
    const output = document.getElementById("mobile-check");
    output.textContent = "卡片宽度 " + Math.round(card.getBoundingClientRect().width) + " px · " + (overflow ? "发现横向溢出" : "内容无横向溢出") + " · " + (touchable ? "按钮触控高度充足" : "按钮高度需检查");
    output.dataset.ok = String(!overflow && touchable);
  }
  function selectView(next) {
    transition++;
    view = next; page = 0;
    if (["running", "stopping", "stopped"].includes(next)) {
      demo.task = { ...(demo.task || initial.task), taskId: "task-demo", projectPath: demo.projectPath, sessionName: demo.sessionName,
        status: next === "stopped" ? "interrupted" : next, resumedAs: undefined, stopError: undefined };
      demo.paused = next !== "running";
    }
    render();
    feedback("本地演示：已打开" + document.querySelector('nav button[data-view="' + next + '"]').textContent + "。");
  }
  function act(button) {
    const value = button.value, action = value.action;
    transition++;
    if (button.confirm && !window.confirm(button.confirm.text.content + "（仅影响本地演示）")) {
      feedback("已取消，本地演示未变更。"); return;
    }
    if (action.startsWith("show_")) {
      view = action.slice(5); page = value.view === view ? value.page || 0 : 0;
      feedback("本地演示：已打开" + ({ home: "首页", projects: "项目列表", sessions: "会话列表", queue: "待办", settings: "设置", models: "模型列表", reasoning: "推理强度", help: "使用帮助" })[view] + "。");
    } else if (action === "set_project") {
      saveSession(); saveProject();
      const project = demo.projects.find(item => item.path === value.targetProjectPath);
      demo.projectPath = project.path; demo.projectLabel = project.alias;
      Object.assign(demo, projectStates.get(project.path) || { sessionName: "default", task: null, sessions: [{ name: "default", status: "new" }], queued: [], paused: false });
      view = "home"; page = 0; feedback("本地演示：已切换到 " + project.alias + "，可切回 token_hub 查看原待办。");
    } else if (action === "use_session") {
      saveSession();
      demo.sessionName = value.sessionName;
      Object.assign(demo, sessionStates.get(demo.projectPath + "::" + demo.sessionName) || { task: null, queued: [], paused: false });
      view = "home"; page = 0; feedback("本地演示：已切换到 " + value.sessionName + "。");
    } else if (action === "new_session") {
      saveSession();
      let number = 1;
      while (demo.sessions.some(session => session.name === "新会话" + number)) number++;
      demo.sessionName = "新会话" + number;
      demo.sessions.unshift({ name: demo.sessionName, status: "new", summary: "直接发送消息开始" }); demo.task = null; demo.queued = []; demo.paused = false;
      view = "home"; page = 0; feedback("本地演示：已新建 " + demo.sessionName + "，原会话仍保留。");
    } else if (action === "set_model" || action === "set_reasoning") {
      if (action === "set_model") demo.model = value.model;
      else demo.reasoning = value.reasoningEffort;
      view = "settings"; page = 0; feedback("本地演示：配置已更新。");
    } else if (action === "reset_settings") {
      demo.model = initial.model; demo.reasoning = initial.reasoning;
      feedback("本地演示：已恢复默认配置。");
    } else if (action === "reset_active_session") {
      demo.task = null; feedback("本地演示：当前会话已重置，下一条消息开启新上下文。");
    } else if (action === "refresh") {
      feedback("本地演示：项目列表已刷新，当前页已保留。");
    } else if (action === "resume_queue") {
      demo.paused = false; feedback("本地演示：待办已恢复，真实环境会按顺序执行。");
    } else if (action === "stop_task" && demo.queued.some(item => item.taskId === value.taskId)) {
      demo.queued = demo.queued.filter(item => item.taskId !== value.taskId);
      feedback("本地演示：已取消该待办。");
    } else if (action === "stop_task") {
      if (!demo.task) { feedback("本地演示：当前没有运行任务。"); return; }
      demo.task.status = "stopping"; demo.paused = true;
      const version = transition;
      feedback("本地演示：正在停止…");
      setTimeout(() => {
        if (version !== transition) return;
        demo.task.status = "interrupted"; view = ["running", "stopping", "stopped"].includes(view) ? "stopped" : view;
        feedback("本地演示：已停止，上下文和待办已保留。"); render();
      }, 450);
    } else if (action === "resume_task") {
      demo.task.status = "running";
      view = ["running", "stopping", "stopped"].includes(view) ? "running" : view;
      feedback("本地演示：已在原上下文中继续，旧待办仍暂停。");
    } else {
      feedback("本地演示：已点击「" + button.text.content + "」，不会发送真实飞书请求。");
    }
    render();
  }
  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.view) selectView(button.dataset.view);
    else if (button.dataset.button !== undefined) act(renderedButtons[Number(button.dataset.button)]);
    else if (button.id === "reset-demo") {
      transition++; projectStates.clear(); sessionStates.clear(); demo = structuredClone(initial); view = "home"; page = 0;
      feedback("本地演示已重置。"); render();
    }
  });
  document.getElementById("mobile-width").addEventListener("input", event => {
    document.querySelector(".phone").style.width = event.target.value + "px";
    document.getElementById("width-value").textContent = event.target.value + " px";
    checkMobile();
  });
  window.addEventListener("resize", checkMobile);
  render();
}
const html = String.raw`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>飞书卡片交互预览</title><style>
*{box-sizing:border-box}body{margin:0;background:#f2f4f7;color:#1f2329;font:14px/1.65 "Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:28px auto;padding:0 20px}h1{font-size:22px;margin:0 0 6px;font-weight:600}.caption{color:#646a73;margin:0 0 20px}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}nav button,.reset{border:1px solid #d0d3d8;background:white;min-height:40px;padding:7px 13px;border-radius:6px;color:inherit;cursor:pointer}
nav button[aria-pressed=true]{background:#1456f0;color:white;border-color:#1456f0}button:focus-visible,input:focus-visible{outline:3px solid #97bbff;outline-offset:2px}
.layout{display:flex;align-items:flex-start;gap:32px}.phone{width:380px;max-width:100%;padding:12px;background:#e8eaed;border-radius:12px;flex-shrink:0}
.card{overflow:hidden;border:1px solid #dee0e3;border-radius:8px;background:white}.header{padding:12px 16px;font-weight:600;font-size:16px;background:#e5edff;color:#1456f0}
.header.orange{background:#fff0d6;color:#995d00}.header.green{background:#e1f4e7;color:#16753e}.header.red{background:#ffebe9;color:#b42318}.header.grey{background:#eceef1;color:#646a73}
.body{padding:6px 16px 14px}.md{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}.note{font-size:12px;line-height:1.6;color:#646a73;margin:8px 0;overflow-wrap:anywhere}
.actions{display:flex;gap:8px;margin:10px 0}.actions button{flex:1;min-width:0;min-height:40px;font:inherit;font-size:13px;line-height:1.5;white-space:normal;overflow-wrap:anywhere;border:1px solid #d0d3d8;border-radius:5px;background:white;padding:8px 9px;color:#1f2329;cursor:pointer}
.actions .primary{background:#1456f0;color:#fff;border-color:#1456f0}.actions .danger{color:#d92d20;border-color:#f3b3ad;background:#fff}
hr{border:0;border-top:1px solid #eff0f1;margin:16px 0}aside{max-width:430px;padding-top:4px;min-width:0}aside h2{font-size:16px;margin:0 0 8px}aside p{color:#646a73;margin:0 0 20px}
#feedback{padding:10px 12px;border-left:3px solid #1456f0;background:#eaf0ff;color:#1f3f7a;min-height:46px}label{display:block;margin:20px 0 5px}input[type=range]{max-width:100%;width:260px;accent-color:#1456f0}output{display:block;font-size:12px;color:#646a73;margin-top:8px}output[data-ok=false]{color:#b42318}.reset{margin-top:20px}
@media(max-width:720px){main{margin:20px auto;padding:0 12px}.layout{display:block}.phone{margin:auto}aside{margin:22px auto 0;max-width:440px}nav{gap:6px}}
</style><main><h1>飞书卡片交互预览</h1><p class="caption">本地演示，所有按钮只修改示例数据，不会发送飞书消息。卡片内容来自正式渲染器，实际外观以飞书客户端为准。</p>
<nav aria-label="演示页面">${Object.entries(views).map(([id, label]) => `<button data-view="${id}">${label}</button>`).join("")}</nav>
<div class="layout"><section class="phone" aria-label="移动端卡片预览"><div id="card" class="card"></div></section><aside>
<h2>完整功能，分层展示</h2><p>首页保留项目、会话、配置和任务状态。项目、会话、待办及设置各有独立页面，返回位置明确。</p>
<h2>直接试用按钮</h2><p>示例包含 17 个项目、15 条会话和 8 条待办。可以翻页、切换项目和会话、新建会话、调整设置、取消待办及停止后继续。</p>
<div id="feedback" role="status" aria-live="polite">本地演示已就绪，可直接点击卡片。</div>
<label for="mobile-width">模拟手机宽度 <span id="width-value">380 px</span></label><input id="mobile-width" type="range" min="280" max="440" value="380" step="1">
<output id="mobile-check" aria-live="polite"></output><button class="reset" id="reset-demo">重置演示数据</button>
</aside></div></main><script type="module">${rendererSource}
(${browserDemo.toString()})(${JSON.stringify(state).replaceAll("<", "\\u003c")});</script></html>`;
const out = path.join(root, "outputs"); mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "feishu-cards-preview.html"), html, "utf8");
writeFileSync(path.join(out, "feishu-cards-preview.json"), JSON.stringify(cards, null, 2), "utf8");
console.log(path.join(out, "feishu-cards-preview.html"));
if (process.argv.includes("--serve")) {
  const server = http.createServer((request, response) => {
    if (request.url !== "/") { response.writeHead(404); response.end(); return; }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(readFileSync(path.join(out, "feishu-cards-preview.html")));
  });
  const port = Number(process.argv.find(arg => arg.startsWith("--port="))?.split("=")[1] || 0);
  server.listen(port, "127.0.0.1", () => console.log(`Preview: http://127.0.0.1:${server.address().port}/`));
}
