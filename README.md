# Feishu Codex Bridge

这个工具把飞书机器人消息转发给本机 OpenAI Codex CLI 执行：

```text
飞书机器人消息 -> 本机 bridge -> codex exec -> 飞书进度 / 结果
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
codex exec --help
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
| `/cancel task-xxxx` | 取消任务 |
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

会话卡片支持：

- 切换当前项目
- 切换模型
- 切换推理强度
- 新建会话
- 会话列表
- 切换会话
- 默认列出当前聊天 / 当前项目下的 session 和各自进度
- 取消 pending/running 任务
- 重置当前会话

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
| `CODEX_BIN` | `codex` | Codex CLI 命令 |
| `CODEX_MODEL` | 空 | 留空则走 `~/.codex/config.toml` |
| `CODEX_MODEL_CHOICES` | `grok-4.6,grok-4.5,gpt-5.5,gpt-5.4` | 卡片模型候选，逗号分隔；可追加当前 Codex provider/catalog 支持的任意模型 ID |
| `CODEX_REASONING_EFFORT` | 空 | 默认推理强度覆盖；留空则走 `~/.codex/config.toml` |
| `CODEX_REASONING_EFFORT_CHOICES` | `low,medium,high,xhigh,max,ultra` | 卡片推理强度候选 |
| `CODEX_SANDBOX_MODE` | `workspace-write` | 新 session 的 sandbox |
| `CODEX_APPROVAL_POLICY` | `never` | 通过 `-c approval_policy=...` 覆盖 |
| `CODEX_DANGEROUS_BYPASS` | `0` | 显式设 `1` 才完全绕过审批和 sandbox |
| `CODEX_CONFIG_OVERRIDES` | 空 | 分号分隔多个 `-c key=value` |
| `SESSION_STATE_PATH` | `~/.feishu-codex-bridge/state.json` | session/threadId/active session 持久化文件 |

项目候选的来源为：

1. `DEFAULT_PROJECT_PATH` 和 `CODEX_PROJECTS` 中的手工配置；
2. Codex App Server `thread/list` 返回的历史线程 `cwd`；
3. 仅保留本机存在的目录，并按规范化绝对路径去重。

桥接进程会在启动后、打开或查看项目面板时，以及后台刷新时执行发现。App Server 不可用时会记录 warning，但仍保留手工配置的项目，不影响桥接启动和任务执行。

## 注意

- 飞书权限变更后必须发布新版本，否则可能能收消息但不能回复。
- 图片输入需要飞书应用开启机器人能力，并拥有读取消息资源的权限；bridge 会通过消息资源接口下载图片后交给 Codex CLI。
- 群聊 @ 需要 `im.message.receive_v1` 事件订阅和 `im:message.group_at_msg:readonly` 权限；如果 bridge 终端完全没有收到日志，就是开放平台配置/发布问题。
- 飞书互动卡片按钮需要开放平台事件 `card.action.trigger` 可用；如果卡片能发出但按钮无反应，检查事件订阅 / 权限发布状态。
- 任务状态消息会按 `STREAM_PUSH_INTERVAL` 推送 heartbeat：`elapsed` 表示任务运行时长，`last_event` 表示距上次收到 Codex stdout/stderr 事件的时间；长任务中 `last_event` 变大通常表示 Codex 正在长思考、压缩上下文或执行无输出命令，不等于 bridge 已挂。
- 同一 session 内连续发送多个任务会排队执行；不同 session 可以并发执行。需要中止时可在卡片中点击对应 session 的取消按钮，或显式发送 `/cancel task-xxxx`。
- 不同 session 并发使用同一个工作区，适合相互独立的任务；如果同时修改同一批文件，仍可能产生工作区冲突。
- 同一飞书聊天窗口可以维护多个命名 session；普通消息使用当前 active session，`/use <名字>` 可切换，`/new <名字>` 可新开或重置一条线。session 历史会持久化到 `SESSION_STATE_PATH`，重启 bridge 后仍可在 `/panel` 看到。
- `/panel` 默认展示当前飞书聊天窗口 + 当前 active project 下的 session；未切项目时使用 `DEFAULT_PROJECT_PATH`。
- `/project <别名或路径>` 会改变该飞书聊天窗口后续普通消息的执行项目；`/run <路径> ...` 仍可临时指定项目路径。
- 模型和推理强度覆盖按“当前飞书聊天窗口 + 当前项目”保存；切换项目后会看到该项目自己的模型 / 推理强度状态。
- `/panel` 会将实际生效的模型 / 推理强度按钮显示为“当前 ...”：优先当前聊天窗口 + 项目覆盖，其次 `CODEX_MODEL` / `CODEX_REASONING_EFFORT`，最后读取 `CODEX_HOME`（默认 `~/.codex`）下的 `config.toml`。
- `/panel` 默认分为 `Grok models` 与 `Codex/provider models` 两组，直接提供 `grok-4.6`、`grok-4.5` 按钮；面板按钮和 `/model <模型名>` 最终都通过现有 Codex CLI 的 `-m` 参数执行。
- `/model <模型名>` 可切换任意当前本机 Codex provider/catalog 支持的模型；如果模型不在面板候选中，直接发送命令即可。Grok 的实际可用性取决于本机 `~/.codex/config.toml` 的 provider、catalog 和鉴权配置，桥接本身不会新增或保存 Grok 凭据。
- 卡片切换项目不会同步扫描 Codex 历史线程；项目发现只在启动、卡片“刷新列表”、查看项目以及后台定时刷新时执行，避免阻塞卡片动作导致飞书重复投递或使用旧卡片状态。
- 同一张飞书卡片的按钮动作会按消息 ID 串行执行，避免快速连续切换项目和模型时旧的 `message.patch` 结果覆盖较新的卡片状态；飞书返回非零错误码时 bridge 会记录明确的更新失败错误。
- 如果本机 Codex CLI 配置本身不可用，bridge 会把 Codex stderr / error 回传到飞书。
