# Feishu Codex Bridge

这个工具把飞书机器人消息转发给本机 Codex 客户端执行，让飞书和客户端使用同一条聊天：

```text
飞书机器人消息 -> 本机 bridge -> Codex 客户端聊天 -> 飞书进度 / 结果
```

它是本地开发辅助工具，不进入服务运行时。
私聊机器人可直接发任务；群聊里需要先把机器人拉进群，再 @ 机器人发任务。

## 快速开始

1. 配置飞书应用：见 `tool/feishu-codex-bridge/FEISHU_APP_SETUP.md`
2. 初始化：

```powershell
tool/feishu-codex-bridge/setup.ps1
```

3. 填写：

```text
secrets/feishu_codex_bridge.env
```

4. 确认本机 Codex 可用：

```powershell
codex login
codex app-server --help
```

5. 启动：

```powershell
tool/feishu-codex-bridge/start.ps1
```

首次启动时终端会显示配对码，把配对码发给飞书机器人即可绑定。

## 开机自动启动

桥接依赖当前 Windows 用户的 Codex 配置和登录状态，因此自动启动任务会在该用户登录后运行，而不是使用 `SYSTEM` 账户。

安装自动启动任务：

```powershell
.\autostart.ps1 Install
```

任务会在登录后延迟约 20 秒隐藏启动；异常退出时最多自动重试 10 次。当前 bridge 已手工运行时无需停止，安装命令不会立即启动第二个实例，下次登录时自动生效。

查看状态或卸载：

```powershell
.\autostart.ps1 Status
.\autostart.ps1 Uninstall
```

需要安装后立即启动时使用：

```powershell
.\autostart.ps1 Install -StartNow
```

后台日志写入：

```text
~/.feishu-codex-bridge/logs/bridge.log
```

日志达到 10 MB 后会轮换为 `bridge.previous.log`。如果移动了仓库目录，需要重新执行安装命令以更新任务中的脚本路径。

## 命令

| 指令 | 说明 |
|------|------|
| `/panel` / `面板` | 打开飞书会话卡片 |
| 直接发文本 | 在当前聊天窗口 active project 排队执行 Codex 任务 |
| 直接发图片 | 下载飞书图片并作为 Codex `-i` 图片输入执行 |
| `/run <描述>` | 在当前聊天窗口 active project 执行 |
| `/run <路径> <描述>` | 指定目录执行 |
| 排队消息卡片的「引导」按钮 | 将这条文字消息提交到原来正在运行的任务，不中断模型运行 |
| `/steer <补充要求>` / `/引导 <补充要求>` | 直接向当前项目、当前 session 的运行中任务追加文字要求 |
| `/steer task-xxxx` | 将指定的排队文字消息作为引导提交 |
| `/sessions` | 查看当前项目的 session 列表 |
| `/use <名字>` | 切换当前聊天窗口的 active session |
| `/new <名字>` | 新建/重置命名 session 并切换过去 |
| `/new` | 清除当前 active session 映射 |
| `/model` | 查看当前项目下的模型 / 推理强度覆盖 |
| `/model <模型名>` | 切换当前项目后续任务使用的模型 |
| `/model <模型名> <推理强度>` | 同时切换模型和推理强度，例如 `/model gpt-5.5 high` |
| `/model default` | 清除当前项目模型覆盖 |
| `/reasoning <low\|medium\|high\|xhigh\|max\|ultra>` | 切换当前项目推理强度 |
| `/reasoning default` | 清除当前项目推理强度覆盖 |
| `/project` | 查看当前聊天窗口的 active project 和可选项目 |
| `/project <别名或路径>` | 切换当前聊天窗口后续任务使用的项目 |
| `/status` | 查看最近任务 |
| `/stop` / `停止` | 停止当前运行任务，并暂停该会话旧待办 |
| `/stop task-xxxx` / `/cancel task-xxxx` | 停止指定任务；排队任务直接取消排队 |
| `/resume` / `继续` | 在同一会话继续最近停止的任务 |
| `/queue` | 查看待办，主动恢复按顺序执行 |
| `/help` | 帮助 |

群聊示例：

```text
@Codex助手 /run 看一下当前 git diff，给我总结风险
@Codex助手 帮我修复最近失败的测试
```

Session 示例：

```text
/panel
/new 排查A
帮我看 bridge 的日志问题
/new 文档B
帮我整理 README
/use 排查A
继续刚才 bridge 那条线
/sessions
```

会话卡片按使用频率拆分：

- 首页只显示项目、会话、当前任务和必要操作，不展示路径、任务编号或全部模型按钮。
- 项目和会话通过单独页面切换；模型与推理强度收进“设置”，项目和模型列表支持分页。
- 每条任务只维护一张进度卡片：运行中可停止，停止后可继续，旧待办保持暂停。
- 排队文字消息在同一张卡片中选择“补充给当前任务”或“取消排队”。
- 本地预览：`npm run preview:cards`；也可直接打开生成的 `outputs/feishu-cards-preview.html`，布局由实际卡片渲染器生成。
- 真实续作验证：保持 Codex 客户端打开后运行 `npm run test:live`。它通过正式消息处理器发送 `/stop`，再触发停止卡片的“继续当前任务”，校验同一会话完成原任务、模型保持不变和旧待办不执行；结果保存到 `outputs/task-resume-verification.json`。飞书信使仅记录卡片，不向真实聊天发测试消息。

## 配置文件

- 实值：`secrets/feishu_codex_bridge.env`，不入 git
- 本机运行配置：`~/.feishu-codex-bridge/config.env`
- session 状态：默认写入 `~/.feishu-codex-bridge/state.json`
- 模板：`secrets/feishu_codex_bridge.env.template`

关键项：

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEFAULT_PROJECT_PATH` | 当前仓根 | 默认让 Codex 执行的目录 |
| `CODEX_PROJECTS` | 空 | 卡片项目候选，分号分隔，支持 `alias=path` |
| `CODEX_PROJECT_DISCOVERY` | `thread-list` | 从 Codex App Server 的 `thread/list` 历史任务中发现项目；设为 `off` 可关闭 |
| `CODEX_PROJECT_DISCOVERY_TIMEOUT` | `15000` | 单次项目发现超时，单位毫秒 |
| `CODEX_PROJECT_DISCOVERY_INTERVAL` | `60000` | 后台刷新间隔，单位毫秒；设为 `0` 可关闭后台刷新 |
| `CODEX_BIN` | `codex` | Windows 上优先使用 Codex 客户端内置引擎，未安装时使用 PATH 中的 CLI；指定完整路径可覆盖 |
| `CODEX_TASK_TRANSPORT` | `desktop` | 通过客户端自身提交消息并同步侧栏；需保持 Codex 客户端打开。`app-server` 可独立运行，但不保证客户端侧栏即时同步，并可能遇到会话写入占用 |
| `CODEX_HOME` | `~/.codex` | 与 Codex 客户端使用相同的数据目录，才能共享聊天历史 |
| `CODEX_MODEL` | 空 | 留空则走 `~/.codex/config.toml` |
| `CODEX_MODEL_CHOICES` | `grok-4.6,grok-4.5,gpt-5.5,gpt-5.4` | 卡片模型候选，逗号分隔；可追加当前 Codex provider/catalog 支持的任意模型 ID |
| `CODEX_REASONING_EFFORT` | 空 | 默认推理强度覆盖；留空则走 `~/.codex/config.toml` |
| `CODEX_REASONING_EFFORT_CHOICES` | `low,medium,high,xhigh,max,ultra` | 卡片推理强度候选 |
| `CODEX_SANDBOX_MODE` | `workspace-write` | 新 session 的 sandbox |
| `CODEX_APPROVAL_POLICY` | `never` | 通过 `-c approval_policy=...` 覆盖 |
| `CODEX_DANGEROUS_BYPASS` | `0` | 显式设 `1` 才完全绕过审批和 sandbox |
| `CODEX_CONFIG_OVERRIDES` | 空 | 分号分隔多个 `-c key=value` |
| `SESSION_STATE_PATH` | `~/.feishu-codex-bridge/state.json` | session/threadId/active session 持久化文件 |
| `GENERATED_IMAGE_MAX_COUNT` | `4` | 单个任务最多发送到飞书的本轮生成图片数量；设为 `0` 可关闭图片输出 |
| `STREAM_PUSH_INTERVAL` | `30000` | 任务状态 heartbeat 更新间隔，单位毫秒 |

项目候选的来源为：

1. `DEFAULT_PROJECT_PATH` 和 `CODEX_PROJECTS` 中的手工配置；
2. Codex App Server `thread/list` 返回的历史线程 `cwd`；
3. 仅保留本机存在的目录，并按规范化绝对路径去重。

桥接进程会在启动后、打开或查看项目面板时，以及后台刷新时执行发现。查询使用 `thread/list` 的 `useStateDbOnly: true`，只读取 Codex 已保存的会话索引，避免每页扫描与修复历史文件导致超时。App Server 不可用时会记录 warning，并保留上次成功的项目列表（启动时为手工配置），不影响桥接启动和任务执行。

## 注意

- 新的飞书任务会创建标题为 `[飞书] 项目目录名 · session名` 的 Codex 会话，后续同一 session 继续使用同一条历史；最终飞书回复也会提示对应的客户端会话名称。
- 默认桌面通道会自动发现本机 Codex 客户端的连接，客户端重启后无需重新配置。未打开客户端时会明确提示，不会悄悄转到独立执行进程。
- 创建会话时会查找客户端已保存的项目，并显式保存项目归属；项目根目录按最长匹配，未配置项目的目录会显示在最近聊天中。旧版桥接创建的未分组会话会在续聊时补充归属。
- 升级前的 `codex exec` 会话不再续接：每个旧 session 收到下一条任务时会自动建立新的客户端可见会话，无需恢复或删除旧历史。
- 在 Codex 客户端对应项目或最近聊天中查找 `[飞书]` 会话，可查看用户消息和回复并接着聊。默认桌面通道由客户端执行消息，聊天页打开时也可以从飞书继续发送。普通消息按 session 排队；给桥接正在执行的任务补充要求，可点击排队消息的「引导」或发送 `/steer <要求>`。
- 运行中可点“停止当前任务”，或发送 `/stop`、完整消息“停止”“停一下”。桌面通道通过本地会话拥有者控制接口按目标轮次中断，不另开写入进程、不结束整个客户端。只有确认该轮状态为 `interrupted` 才显示已停止；客户端接口不兼容或暂未确认时会提示检查或重试，不谎报成功。
- 停止会暂停同一会话的旧待办，其他会话不受影响。`/resume` 或“继续”沿用原会话与原模型发起新一轮，图片任务会重新读取原图片，旧待办仍暂停；新发送的明确任务也会优先执行。需要运行旧待办时，打开 `/queue` 选择“按顺序执行待办”。已完成的修改不会自动撤销；与客户端停止按钮一致，已启动的独立后台命令或服务可能继续运行，需要单独管理。桥接重启后保留暂停标记，待办内容仍为内存状态，不承诺恢复未执行消息。
- 飞书权限变更后必须发布新版本，否则可能能收消息但不能回复。
- 图片输入需要飞书应用开启机器人能力，并拥有读取消息资源的权限；bridge 会通过消息资源接口下载图片后交给 Codex CLI。
- 图片生成任务完成后，bridge 会从当前 Codex thread 的 `generated_images` 目录中识别本轮新图片，上传并发送到当前飞书聊天；需要应用身份权限 `im:resource`（获取与上传图片或文件资源），且单张图片必须符合飞书 10 MB 限制。
- 群聊 @ 需要 `im.message.receive_v1` 事件订阅和 `im:message.group_at_msg:readonly` 权限；如果 bridge 终端完全没有收到日志，就是开放平台配置/发布问题。
- 飞书互动卡片按钮需要开放平台事件 `card.action.trigger` 可用；如果卡片能发出但按钮无反应，检查事件订阅 / 权限发布状态。
- 进度卡片按 `STREAM_PUSH_INTERVAL` 更新运行进展和用时；模型长时间思考无输出不代表桥接中断。遇到飞书编辑次数上限会自动换一张卡片，最终结果更新失败也会新发卡片兜底；旧任务卡片不能操作后续任务。
- 同一 session 内连续发送多个任务会排队执行；不同 session 可以并发执行。运行中发送的排队文字消息带有「引导」卡片，点击后会追加给原任务，成功提交后从队列移除，不会再执行一次。也可直接发送 `/steer 请先补充测试，再继续实现`，用法与 Codex 客户端「引导」按钮相似。[官方引导接口说明](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)
- 引导只针对当前桥接进程记录的运行中任务，目前支持文字；继承原任务的模型和推理设置。切换项目、session 或 `/new` 后不会把旧消息引导到新任务；原任务结束后，旧按钮会拒绝提交。独立 `app-server` 通道使用 `turn/steer`，桌面通道通过客户端自己的追加消息通道提交，不启动第二个会话写入进程。
- 引导被明确拒绝时，排队消息继续正常执行；连接中断或超时导致无法确认是否收到时，排队消息标记为 `steer_unknown` 并暂停自动执行，请先到客户端核对，再决定是否补发，或用 `/cancel task-xxxx` 清理。桥接尚未识别到运行轮次时会提示稍后重试。引导的最终结果仍由原任务的状态消息返回。
- 独立 `app-server` 通道可用卡片取消按钮或 `/cancel task-xxxx` 中止执行。
- 不同 session 并发使用同一个工作区，适合相互独立的任务；如果同时修改同一批文件，仍可能产生工作区冲突。
- 同一飞书聊天窗口可以维护多个命名 session；普通消息使用当前 active session，`/use <名字>` 可切换，`/new <名字>` 可新开或重置一条线。session 历史会持久化到 `SESSION_STATE_PATH`，重启 bridge 后仍可在 `/panel` 看到。
- `/panel` 默认展示当前飞书聊天窗口 + 当前 active project 下的 session；未切项目时使用 `DEFAULT_PROJECT_PATH`。
- `/project <别名或路径>` 会改变该飞书聊天窗口后续普通消息的执行项目；`/run <路径> ...` 仍可临时指定项目路径。
- 模型和推理强度覆盖按“当前飞书聊天窗口 + 当前项目”保存；切换项目后会看到该项目自己的模型 / 推理强度状态。
- `/panel` → 设置显示实际生效的模型与推理强度：优先当前聊天窗口 + 项目覆盖，其次 `CODEX_MODEL` / `CODEX_REASONING_EFFORT`，最后读取 `CODEX_HOME`（默认 `~/.codex`）下的 `config.toml`。
- 模型设置页保留 Codex/provider 与 Grok 候选，面板选择和 `/model <模型名>` 都传给同一执行通道。
- `/model <模型名>` 可切换任意当前本机 Codex provider/catalog 支持的模型；如果模型不在面板候选中，直接发送命令即可。Grok 的实际可用性取决于本机 `~/.codex/config.toml` 的 provider、catalog 和鉴权配置，桥接本身不会新增或保存 Grok 凭据。
- 卡片切换项目不会同步扫描 Codex 历史线程；项目发现只在启动、卡片“刷新列表”、查看项目以及后台定时刷新时执行，避免阻塞卡片动作导致飞书重复投递或使用旧卡片状态。
- 同一张飞书卡片的按钮动作会按消息 ID 串行执行，避免快速连续切换项目和模型时旧的 `message.patch` 结果覆盖较新的卡片状态；飞书返回非零错误码时 bridge 会记录明确的更新失败错误。
- 如果本机 Codex CLI 配置本身不可用，bridge 会把 Codex stderr / error 回传到飞书。
