import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { buildPanelCard, buildTaskCard } from "../feishu-cards.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const task = { taskId: "task-demo", generation: "demo", source: { chatId: "demo" }, projectPath: "D:\\token_hub", sessionName: "接口检查",
  prompt: "检查接口并运行相关测试", status: "running", startedAt: Date.now() - 83_000 };
const state = { chatId: "demo", projectPath: task.projectPath, projectLabel: "token_hub", sessionName: task.sessionName, task,
  model: "gpt-6.1-sol", reasoning: "high", reasoningChoices: ["low", "medium", "high", "xhigh"], models: ["gpt-6.1-sol", "gpt-6-astra", "grok-4.6"],
  projects: ["token_hub", "jx3-wiki", "jx3-cs-services"].map(alias => ({ alias, path: `D:\\${alias}` })),
  sessions: [{ name: "接口检查", status: "running" }, { name: "default", status: "idle" }],
  queued: [{ ...task, prompt: "补充接口文档", status: "pending" }, { ...task, prompt: "整理本次修改", status: "pending" }],
};
const cards = {
  home: buildPanelCard(state),
  running: buildTaskCard(task, { projectLabel: "token_hub", pendingCount: 2, text: "已找到接口校验逻辑，正在运行相关测试。" }),
  stopping: buildTaskCard({ ...task, status: "stopping" }, { projectLabel: "token_hub", pendingCount: 2, paused: true, text: "正在请求停止当前任务…" }),
  stopped: buildTaskCard({ ...task, status: "interrupted", finishedAt: Date.now() }, { projectLabel: "token_hub", pendingCount: 2, paused: true, text: "当前任务已停止。" }),
  settings: buildPanelCard({ ...state, view: "settings" }), queue: buildPanelCard({ ...state, view: "queue", paused: true }),
};
const html = String.raw`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>飞书卡片布局预览</title><style>
*{box-sizing:border-box}body{margin:0;background:#f2f4f7;color:#1f2329;font:14px/1.65 "Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:1040px;margin:36px auto;padding:0 24px}h1{font-size:22px;margin:0 0 6px;font-weight:600}.caption{color:#646a73;margin:0 0 24px}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}nav button{border:1px solid #d0d3d8;background:white;padding:7px 14px;border-radius:6px;color:inherit;cursor:pointer}
nav button[aria-pressed=true]{background:#1456f0;color:white;border-color:#1456f0}button:focus-visible{outline:3px solid #97bbff;outline-offset:2px}
.layout{display:flex;align-items:flex-start;gap:36px}.phone{width:380px;max-width:100%;padding:20px 12px;background:#e8eaed;border-radius:12px;flex-shrink:0}
.card{overflow:hidden;border:1px solid #dee0e3;border-radius:8px;background:white}.header{padding:12px 16px;font-weight:600;font-size:16px;background:#e5edff;color:#1456f0}
.header.orange{background:#fff0d6;color:#995d00}.header.green{background:#e1f4e7;color:#16753e}.header.red{background:#ffebe9;color:#b42318}.header.grey{background:#eceef1;color:#646a73}
.body{padding:6px 16px 14px}.md{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}.note{font-size:12px;line-height:1.6;color:#646a73;margin:8px 0}
.actions{display:flex;gap:8px;margin:10px 0}.actions button{flex:1;min-width:0;font:inherit;font-size:13px;line-height:1.4;border:1px solid #d0d3d8;border-radius:5px;background:white;padding:8px 9px;color:#1f2329;cursor:pointer}
.actions .primary{background:#1456f0;color:#fff;border-color:#1456f0}.actions .danger{color:#d92d20;border-color:#f3b3ad;background:#fff}
hr{border:0;border-top:1px solid #eff0f1;margin:16px 0}aside{max-width:420px;padding-top:8px}aside h2{font-size:16px;margin:0 0 10px}aside p{color:#646a73;margin:0 0 16px}code{font:12px Consolas,monospace}
@media(max-width:720px){main{margin:20px auto;padding:0 16px}.layout{display:block}.phone{width:100%}aside{margin-top:24px}nav{gap:6px}}
</style><main><h1>飞书卡片布局预览</h1><p class="caption">预览由实际卡片渲染器生成，用于检查信息层级；最终样式以飞书客户端为准。</p>
<nav>${Object.entries({home:"会话首页",running:"运行中",stopping:"停止中",stopped:"已停止",settings:"设置",queue:"待办"}).map(([id,label])=>`<button data-card="${id}">${label}</button>`).join("")}</nav>
<div class="layout"><section class="phone"><div id="card" class="card"></div></section><aside><h2>只留下当前需要的信息</h2><p>首页显示项目、会话和正在做的事。完整路径、任务编号、模型列表和重复说明不占据首屏。</p><h2>操作跟随任务状态</h2><p>运行中可以停止；停止后保留上下文，待办暂停。继续当前任务和执行旧待办是两项明确的操作。</p><h2>设置单独查看</h2><p>模型、推理强度和会话重置放在设置页。排队消息的引导与取消放在同一张任务卡片内。</p></aside></div></main>
<script>const cards=${JSON.stringify(cards).replaceAll("<", "\\u003c")};const escape=s=>String(s||"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function render(id){const c=cards[id];document.querySelectorAll("nav button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.card===id));document.getElementById("card").innerHTML='<div class="header '+escape(c.header.template)+'">'+escape(c.header.title.content)+'</div><div class="body">'+c.elements.map(e=>e.tag==='markdown'?'<div class="md">'+escape(e.content).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')+'</div>':e.tag==='note'?'<div class="note">'+escape(e.elements.map(t=>t.content).join(' '))+'</div>':e.tag==='hr'?'<hr>':e.tag==='action'?'<div class="actions">'+e.actions.map(b=>'<button class="'+escape(b.type)+'" data-action="'+escape(b.value.action)+'">'+escape(b.text.content)+'</button>').join('')+'</div>':'').join('')+'</div>'}
document.addEventListener('click',e=>{const id=e.target.dataset.card;if(id)render(id);const a=e.target.dataset.action;const map={stop_task:'stopping',resume_task:'running',show_settings:'settings',show_home:'home',show_queue:'queue'};if(map[a])render(map[a]);});render('running');</script></html>`;
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
