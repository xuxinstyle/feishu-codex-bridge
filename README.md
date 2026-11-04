# Feishu Codex Bridge

将飞书机器人收到的文字或图片交给本机 Codex 执行，并把进度、结果和生成图片发回飞书。默认使用桌面通道，让飞书和 Codex 客户端继续同一条 Codex 会话。

```text
飞书机器人 → 本机 bridge → Codex 客户端会话 → 飞书任务卡片 / 结果
```

私聊可直接发送任务；群聊需先加入机器人，再 @机器人。bridge 在当前用户的本机运行，需要持续联网。

## 快速开始（Windows）

以下命令均在本仓库根目录执行。需要 PowerShell 5.1 或更高版本、Node.js 18 或更高版本及 npm。默认桌面通道还需要已登录并打开的 Codex 客户端，以及客户端提供的本地 App Tools 连接和会话控制接口；仅安装 CLI 不足以使用桌面通道。

1. 按 [飞书应用配置与权限清单](FEISHU_APP_SETUP.md) 创建企业自建应用，启用机器人、长连接、消息事件和卡片回调，并发布生效。
2. 首次配置时复制模板；已有 `secrets/feishu_codex_bridge.env` 时直接编辑现有文件：

   ```powershell
   Copy-Item .\secrets\feishu_codex_bridge.env.template .\secrets\feishu_codex_bridge.env
   ```

3. 编辑 `secrets/feishu_codex_bridge.env`，填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，并将 `DEFAULT_PROJECT_PATH` 设为实际工作目录。默认工作目录是 bridge 仓库，通常需要改成要处理的项目。
4. 打开 Codex 客户端并完成登录，然后初始化：

   ```powershell
   .\setup.ps1
   ```

   setup 会安装缺失的 Node 依赖，并将配置写到 `~/.feishu-codex-bridge/config.env`。若先运行 setup 才填写凭据，首次可能以退出码 `2` 结束；填好后重新运行即可。setup 的 PATH CLI 检查仅为提示，Windows 运行时会优先寻找客户端内置引擎。

5. 启动：

   ```powershell
   .\start.ps1
   ```

   `ALLOWED_USER_IDS` 为空时，启动日志显示 6 位配对码，在飞书私聊机器人发送该码，绑定的 open_id 会写入运行配置。已配置白名单时不显示配对码。发送 `/panel` 打开面板，再发送一个简单任务验证回复。

以后修改 secrets 文件，要重新运行 `.\setup.ps1` 并重启 bridge；已有运行配置时，`.\start.ps1` 不会自动重新同步 secrets。

旧安装兼容 `secrets/feishu_cursor_bridge.env`：仅在 Codex 实值文件不存在时使用旧文件。看到 `using legacy secrets file` 提示时，应修改提示中的实际文件，或迁移为新的 Codex 文件名。旧模板里的 Cursor 模型与鉴权字段不用于本 bridge。

## 登录后自动启动

```powershell
.\autostart.ps1 Install
.\autostart.ps1 Status
```

脚本注册当前 Windows 用户的计划任务 `FeishuCodexBridge`，登录后延迟约 20 秒隐藏启动，以普通用户权限运行，不限制持续运行时间；异常退出最多重试 10 次，间隔 1 分钟。安装命令默认只注册任务，不立即启动。

需要安装后立即启动时执行：

```powershell
.\autostart.ps1 Install -StartNow
```

`IgnoreNew` 只防止同一计划任务重复运行，不会识别手工启动的 bridge；使用 `-StartNow` 前先结束手工实例。桌面通道仍需 Codex 客户端保持打开，计划任务不会代为启动客户端。

后台日志为 `~/.feishu-codex-bridge/logs/bridge.log`。后台启动脚本每次启动时检查日志，已有日志达到 10 MiB 才轮换为 `bridge.previous.log`，运行期间不会持续按大小轮换。前台 `.\start.ps1` 的输出直接显示在终端。

卸载自动启动任务：

```powershell
.\autostart.ps1 Uninstall
```

卸载会停止正在运行的该计划任务，再删除任务；不会清除配置或 Codex 历史。移动仓库后需重新安装计划任务，更新脚本路径。

## 飞书命令

“当前会话”指当前飞书聊天、当前项目下选中的命名 session，默认名为 `default`。session 是 bridge 保存的 Codex 会话映射，不等同于飞书聊天窗口。

| 指令 / 操作 | 行为 |
| --- | --- |
| `/panel`、`/card`、`面板`、`控制台` | 打开控制面板 |
| 直接发送文字 | 在当前项目和 session 中提交任务；同一 session 正在执行时排队 |
| 直接发送图片 | 下载图片到本机并提交给当前 session；默认要求“请分析这张图片并回答。” |
| `/run <描述>` | 在当前项目执行任务 |
| `/run <路径> <描述>` | 仅本次使用指定路径；不改变当前项目选择 |
| `/sessions`、`/session`、`会话列表` | 查看当前项目的 bridge session 列表 |
| `/use <名字>` | 切换命名 session；没有映射时，下一条任务创建 Codex 会话 |
| `/new <名字>` | 重置该名字的会话映射并切换过去；下一条任务使用新上下文 |
| `/new`、`新会话`、`重置` | 重置当前 session 的映射，保留当前名字；不删除 Codex 历史 |
| `/project`、`/repo`、`/项目` | 查看当前项目及候选项目 |
| `/project <别名或路径>` | 切换当前飞书聊天的项目 |
| `/project default` | 清除项目选择，回到默认项目 |
| `/model`、`/模型` | 查看模型与推理强度设置 |
| `/model <模型名> [推理强度]` | 设置后续任务模型，可同时指定推理强度，如 `/model <实际模型ID> high` |
| `/model default` | 仅清除模型覆盖；推理强度需另行清除 |
| `/reasoning`、`/effort`、`/推理` | 查看模型与推理强度设置 |
| `/reasoning <low\|medium\|high\|xhigh\|max\|ultra>` | 设置后续任务推理强度；实际支持范围取决于模型 |
| `/reasoning default` | 仅清除推理强度覆盖 |
| `/threads`、`/history`、`本地会话`、`聊天记录` | 私聊浏览当前项目下其他 Codex 会话 |
| `/threads all`、`/history all`、`/threads 全部` | 浏览全部项目中符合条件的本地会话，仍需分页 |
| `/steer <补充要求>`、`/引导 <补充要求>` | 把文字补充到当前运行任务，不中断当前轮次 |
| `/steer task-xxxx`、排队卡片“补充给当前任务” | 将指定排队文字消息转为原运行任务的补充要求 |
| `/status`、`/status task-xxxx` | 查看项目、session 和最近任务，或指定任务状态 |
| `/stop`、`停止`、`停一下` | 请求停止当前 session 的运行任务，并暂停旧待办 |
| `/stop task-xxxx`、`/cancel task-xxxx` | 停止指定任务；尚在排队的任务直接取消 |
| `/resume`、`/resume task-xxxx` | 继续当前 session 最近停止的任务，或指定停止任务 |
| `继续` | 优先续作已停止任务；没有可续作目标时，作为普通“继续”消息提交 |
| `/queue` | 打开待办页；暂停后可点击“按顺序执行待办”恢复 |
| `/help`、`帮助` | 显示帮助 |

`/use` 和 `/new` 的命令参数不支持带空格的名字；`/run <路径> <描述>` 的路径需以盘符、`/`、`~`、`./` 或 `../` 等路径形式开头，不支持空格，也不接受项目别名。带空格的项目路径可先用 `/project <完整路径>` 切换，再发送任务。相对路径以 `DEFAULT_PROJECT_PATH` 为基准解析。

未匹配已实现命令的非空文字会按普通任务处理，包括拼错的斜杠命令。当前仅接收 `text` 和 `image` 消息，不处理文件、语音、富文本等其他消息类型；图片与另发的说明不会自动合并成一次输入。

群聊示例：

```text
@Codex助手 /project 我的项目
@Codex助手 /new 排查A
@Codex助手 帮我检查当前 git diff
@Codex助手 /steer 请先检查测试
@Codex助手 /stop
@Codex助手 /resume
```

## 面板、会话与队列

首页展示项目、session、模型、推理强度和任务摘要，提供切换项目、切换会话、新建会话、待办、本地会话、设置、帮助。项目、session、模型和待办列表支持分页；项目页提供“刷新列表”。面板“新建会话”会生成新名字，命令 `/new` 则重置当前名字。

任务卡片显示进度和用时，运行中可停止，停止后可继续。排队文字消息在存在原运行任务时提供“补充给当前任务”和“取消排队”。通常复用原任务卡片更新；达到编辑限制时会新发替代卡片，最终更新失败时也会尝试新卡片兜底，不能保证始终只有一张。

普通导航和设置多通过回调直接返回卡片；模型目录刷新、历史浏览、附加、停止、续作、引导和手动项目刷新会先回执再后台处理。模型页刷新失败保留缓存；项目后台刷新只更新候选列表，过期的后台页面结果不会覆盖后续导航。同一卡片上的任务操作串行执行，旧任务卡片不能控制其他任务或已重置的 session。

队列按“飞书聊天 + 项目路径 + session 名”隔离。同一 session 顺序执行，不同 session 可以并发；并发任务若修改相同文件，仍会发生工作区冲突。模型和推理强度在任务入队时确定，修改设置不会改变已排队任务。

### 会话复用与模型设置

普通新会话使用标题 `[飞书] 项目目录名 · session名`。普通 session 仅在已保存映射的 backend 为 `app-server-v1` 且模型值相同时复用 thread；模型变化、旧版 `codex exec` 映射或映射被重置时，下一条任务可能创建新 thread。原 Codex 历史保留，最终飞书回复不固定附带客户端会话名称。

普通 session 的模型、推理强度覆盖按“飞书聊天 + 项目”共享；同项目的其他普通 session 也会使用该覆盖。优先级为：聊天/项目覆盖、`CODEX_MODEL` / `CODEX_REASONING_EFFORT`、bridge 启动时读取的 Codex 默认配置。启动时会通过 `config/read` 刷新默认项目的配置，模型页通过 `model/list` 刷新该项目的候选；不能将面板显示理解为所有项目或已有桌面会话最终配置的实时回显。

模型候选来自当前引擎目录并追加 `CODEX_MODEL_CHOICES`；目录不可用且无缓存时使用代码中的候选回退，出现候选不代表上游一定支持。`/model` 允许手工填写格式合法的模型 ID，能否执行仍取决于本机 provider、catalog 和鉴权。bridge 不会新增或保存 Grok 等上游凭据。

### 停止、续作与引导

- 停止请求发出后，需执行端确认中断才显示已停止；结果未确认会提示重试或到客户端核对。任务在提交前被停止时，可以直接停止本地准备阶段。
- `/resume` 通常在原 thread 新开一轮，只提交“继续”，沿用原任务记录的模型和推理设置，不重新拼接任务全文或附加图片；停止前已收到但尚未保存的补充要求会在核对历史后补回。尚未提交的任务则首次提交原任务及图片。
- 目标 thread 缺失、轮次已被替换、尚未确认停止或补充提交结果不确定时，会拒绝自动续作并提示核对。续作不能恢复已结束工具进程的位置，也不会撤销已完成的文件修改；独立后台服务需单独管理。
- 停止会暂停同一 session 的旧待办；续作或新发送的任务可以优先执行，旧待办仍需在 `/queue` 主动恢复。
- 引导仅支持文字，针对本进程记录的原运行任务。成功转为引导后，排队消息不会再作为独立任务执行；明确拒绝时保留排队。回执不确定时暂停该消息，先到客户端核对，再决定补发或 `/cancel task-xxxx`。
- bridge 重启后保留会话映射、选择、设置及队列暂停标记，但不恢复内存中的任务和待办，也不恢复旧任务卡的停止／续作操作。先在客户端核对仍运行的任务，再发送新要求。

## 浏览和附加本地 Codex 会话

在已授权的机器人私聊中发送 `/threads`，或使用面板“本地会话”及会话页“查看 Codex 会话”。列表按最近更新排序，默认按当前项目 cwd 精确匹配；`/threads all` 可跨项目浏览，点击条目后按其实际目录重新校验。支持更早记录、较新记录、长文本分段、刷新、返回列表及切换范围。

历史只读取同一 Codex 数据目录中可列出的未归档会话，隐藏 `[飞书]` 标题、子会话及 subagent 记录；不会完整展示全部类型的会话。过滤分页达到单次上限时可能出现空页，仍可点击“更早记录”。只展示用户文字和 Codex 回复，不显示工具输出、推理及附件；文字和标题本身仍可能包含敏感内容。

浏览不改变当前任务会话，也不提交模型请求。底层使用 `thread/list`、`thread/read` 和 `thread/turns/list`，需引擎支持分页接口，不回退到全量历史。页面快照有效期为 15 分钟，也可能因缓存容量被提前清理；进程重启或页面过期后重新发送 `/threads`。

在历史内容页点击“附加到飞书”并确认后，才会绑定选中的 thread，并切换到其目录。仅支持桌面通道，保持客户端打开；附加本身不调用模型，不复制历史，不修改原标题或项目归属。后续任务沿用原 thread；找不到原会话或状态不明确时拒绝执行，不创建替代会话。原飞书 session 可从项目和会话页切回。

附加会话默认沿用原模型和推理设置，忽略普通 session 的项目覆盖；附加后的 `/model`、`/reasoning` 或面板设置仅作用于此附加会话。分别恢复默认可清除对应覆盖；面板“恢复默认”会清除两项。附加绑定可跨 bridge 重启保留，模型覆盖变化也不会因此替换原 thread。

当前飞书 session 仍有运行或排队任务、目标会话正在执行、已绑定另一飞书聊天、目录不存在或页面失效时会拒绝附加。历史浏览与附加仅允许 `ALLOWED_USER_IDS` 内用户私聊使用。

## 图片输入与输出

用户图片通过飞书消息资源接口下载到本机临时目录。默认桌面通道将本地图片路径和查看要求发送给 Codex；独立 `app-server` 通道传入 `localImage`。这里不再使用旧 `codex exec -i` 流程。停止或提交结果不确定时会保留临时图片，确认结束后按任务引用清理。

成功任务的图片输出取自 `CODEX_HOME/generated_images/<threadId>/` 的直属文件，根据任务起止时间及约 2 秒容差筛选，再按时间排序发送；不会递归搜索项目或保证找到任意工具产出的图片。单文件仅选取非空且不超过 10 MiB 的受支持图片，数量受 `GENERATED_IMAGE_MAX_COUNT` 限制；上传是否成功仍以飞书返回为准。

图片上传使用应用身份权限 `im:resource`；下载用户图片需按消息资源接口核对消息读取权限。全部权限与用途见 [飞书权限清单](FEISHU_APP_SETUP.md#飞书权限清单)：现有 12 项配置并非全部必需，普通任务卡片通过消息接口发送和更新，当前不调用 CardKit、应用消息流或即时提醒接口。卡片按钮需另外配置 `card.action.trigger`。

## 配置文件与优先级

| 文件 | 用途 |
| --- | --- |
| `secrets/feishu_codex_bridge.env.template` | 可复制的 Codex 配置模板，不含凭据 |
| `secrets/feishu_codex_bridge.env` | setup 的输入文件，不入 Git；旧文件名只作为回退 |
| `~/.feishu-codex-bridge/config.env` | 默认运行配置，setup 生成；配对时写入 open_id |
| `~/.feishu-codex-bridge/state.json` | 默认会话映射、项目/session 选择、模型覆盖、暂停标记、控制面板 ID 及有界消息去重记录 |

`~` 表示当前 Windows 用户目录。运行时已存在的进程环境变量优先于 env 文件，即使变量值为空也不被文件覆盖。直接运行 `node bridge.mjs` / `npm start` 时可用 `DOTENV_CONFIG_PATH` 指定其他文件；`.\start.ps1` 会将它设置为默认运行配置路径。

setup 只写入脚本列出的字段，会重写运行配置；`CODEX_HOME`、`SESSION_STATE_PATH`、`CODEX_APP_TOOLS_PIPE_PATH`、`CODEX_DESKTOP_IPC_PATH` 等不会从 secrets 复制。需要这些高级项时，设置到启动进程环境，或在每次 setup 后补入运行配置。重新 setup 会优先使用 secrets 中非空的白名单，否则沿用运行配置已有白名单。

### 飞书与基础配置

| 变量 | 运行时默认值 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 无，必填 | 企业自建应用凭据 |
| `ALLOWED_USER_IDS` | 空 | 允许使用的 open_id，逗号分隔；为空时生成配对码 |
| `DEFAULT_PROJECT_PATH` | 用户主目录；setup 默认写仓库根目录 | 未选项目时的工作目录，必须存在 |
| `SESSION_STATE_PATH` | `~/.feishu-codex-bridge/state.json` | 状态文件路径；不是任务队列备份 |
| `TASK_TIMEOUT` | `1200000` | 单任务等待超时，毫秒；桌面超时不保证停止客户端任务 |
| `STREAM_PUSH_INTERVAL` | `30000` | 任务卡片周期更新间隔，毫秒，应设为正数 |
| `GENERATED_IMAGE_MAX_COUNT` | `4` | 每任务最多发送生成图片数；`0` 关闭 |
| `LOG_LEVEL` | `info` | `debug`、`info`、`warn`、`error` |

当前代码在白名单为空时生成配对码，但不会阻断所有普通任务或面板操作；不能把“等待配对”视为访问保护。需要限制使用人时，应在接入其他用户前配置 `ALLOWED_USER_IDS`，或在受控私聊中先完成绑定；历史浏览和附加另有显式授权检查。

### 项目与模型配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_PROJECTS` | 空 | 分号分隔的候选，支持 `alias=path`，相对路径基于默认项目 |
| `CODEX_PROJECT_DISCOVERY` | `thread-list` | 从历史索引发现项目；`off` 关闭 |
| `CODEX_PROJECT_DISCOVERY_TIMEOUT` | `15000` | 单次发现超时，毫秒，应大于 `0` |
| `CODEX_PROJECT_DISCOVERY_INTERVAL` | `60000` | 后台发现间隔，毫秒；`0` 关闭定时刷新 |
| `CODEX_BIN` | `codex` | Windows 默认优先尝试客户端内置引擎，再解析本机 CLI；完整路径可覆盖 |
| `CODEX_TASK_TRANSPORT` | `desktop` | 仅支持 `desktop`、`app-server`；后者不要求客户端执行任务，但不保证侧栏实时同步 |
| `CODEX_HOME` | `~/.codex` | 优先检查此目录中的会话文件，缺失时尝试默认目录；启动日志显示实际目录，桌面客户端也需使用相同目录 |
| `CODEX_APP_TOOLS_PIPE_PATH` | 自动发现 | Windows 只有一个客户端连接时自动选择；多个连接需显式指定，旧连接失效后需更新 |
| `CODEX_DESKTOP_IPC_PATH` | Windows：`\\.\pipe\codex-ipc` | 桌面停止、引导、续作所用会话控制连接 |
| `CODEX_MODEL` | 空 | 普通 session 的默认模型覆盖；为空时读取 Codex 默认配置 |
| `CODEX_MODEL_CHOICES` | 空 | 逗号分隔的额外模型 ID，追加到引擎目录 |
| `CODEX_REASONING_EFFORT` | 空 | 普通 session 的默认推理强度覆盖 |
| `CODEX_REASONING_EFFORT_CHOICES` | `low,medium,high,xhigh,max,ultra` | 面板候选；填写候选不代表模型支持 |
| `CODEX_PROFILE` | 空 | 传给辅助 App Server 的 profile；不等于切换已运行客户端的配置 |

项目候选合并手工配置与历史 `cwd`。自动发现读取未归档和已归档索引，过滤发现结果中不存在的目录，合并时按路径去重；手工候选不会提前逐个过滤，执行或选择时仍需检查路径。

项目发现在启动、收到 `/panel`、执行 `/project`、点击项目页“刷新列表”以及定时刷新时触发。仅打开项目子页、翻页或切换项目按钮不会再次扫描历史。发现使用 `thread/list` 的 `useStateDbOnly: true`；失败保留上次列表并记录 warning，单独的发现失败不会终止 bridge，但不能证明任务执行所需的引擎连接正常。

### 执行权限与辅助引擎配置

| 变量 | 默认值 | 当前作用 |
| --- | --- | --- |
| `CODEX_SANDBOX_MODE` | `workspace-write` | 独立 App Server 启动/恢复 thread，以及桌面通道创建新 thread 时传入 |
| `CODEX_APPROVAL_POLICY` | `never` | 与上述 thread 操作一起传入，不是每轮都追加 CLI 参数 |
| `CODEX_DANGEROUS_BYPASS` | `0` | 为 `1` 时，上述传参使用 `danger-full-access` 和 `never` |
| `CODEX_FULL_AUTO` | `0` | 为 `1` 且未 bypass 时将上述 sandbox 设为 `workspace-write`；不传 `--full-auto` |
| `CODEX_CONFIG_OVERRIDES` | 空 | 分号分隔的 `key=value`，作为辅助引擎 `-c` 配置传入 |
| `CODEX_ENABLE_WEB_SEARCH` | `0` | 为 `1` 时给任务准备/执行用辅助引擎追加 `web_search="live"` |

桌面通道继续已有 thread 时，准备阶段只读取 thread，实际轮次由客户端执行；以上变量不能保证重新配置已有桌面会话的 sandbox、审批、profile 或搜索策略。附加会话也沿用其客户端执行环境。需要确认或输入时到客户端处理；独立 App Server 不提供飞书审批交互界面。

## 排查问题

启动时先检查 `CODEX_HOME`，再检查当前用户的默认目录（Windows 通常为 `C:\Users\用户名\.codex`），以 `sessions` 或 `archived_sessions` 内非空、可读的 `rollout-*.jsonl` 为依据，不会仅凭目录或数据库存在判定成功。回退时输出原目录、实际目录和找到的文件；辅助引擎、项目发现和历史列表使用实际目录。恢复已有会话时会按会话 ID 重新检查这两个位置，使用包含该会话文件的目录，不复制历史、配置或登录凭据，也不自动创建替代会话。桌面客户端的数据目录仍需与该会话所在目录一致，bridge 不会修改已运行客户端的环境。

两处都找不到时，启动日志以 `error` 级别列出配置目录、默认目录、检查位置、读取异常和处理建议；已有会话还会列出会话 ID 与状态文件位置。为兼容首次使用、允许显式执行 `/new`，这类检查错误不会阻止机器人启动，但缺失的已有会话会在提交任务前失败。新安装可先在桌面客户端完成一次聊天，再重启 bridge 核对检查结果。若两处都有其他历史，而某个已保存会话在两处均缺失，也会在启动时单独报出。

| 现象 | 核对方式 |
| --- | --- |
| 改了 secrets 但运行行为没变 | 重新 setup 并重启；核对启动日志中的 `configPath`，以及进程环境是否覆盖文件 |
| 启动缺少凭据或找不到路径 | 检查运行配置、setup 退出结果及 `DEFAULT_PROJECT_PATH` |
| 未检测到客户端 / 发现多个客户端 | 打开已登录客户端；多连接时配置 `CODEX_APP_TOOLS_PIPE_PATH`；自动发现不能证明本地控制协议版本兼容 |
| 群 @ 无响应 | 先看是否有 `raw Feishu message event received`；再检查长连接、网络、应用发布、机器人是否入群、事件和权限；收到原始事件后还需检查消息类型及白名单 |
| 能收消息但回复或图片发送失败 | 检查消息/资源权限、应用可用范围、群内发言条件及飞书 API 错误；权限变更后重新发布 |
| 卡片有内容但按钮无反应 | 检查 `card.action.trigger`、发布状态、卡片是否过期及 `card action` 日志 |
| 本地历史为空或打不开 | 核对授权私聊、当前/全部项目范围、`CODEX_HOME`、分页接口支持及页面有效期；空页可能仍有更早记录 |
| 超时、停止结果未确认或提交结果不确定 | 先到客户端查看原 thread 和实际轮次状态，再决定停止或续聊，避免直接重复提交 |
| 项目/模型列表刷新失败 | 使用上次缓存；修复引擎、配置或鉴权后重新刷新。错误摘要会回传，辅助引擎 stderr 主要在 `debug` 日志中记录，不保证完整回传到飞书 |

默认桌面通道不会自动回退到独立 App Server。仅普通新 thread 在服务端明确返回 `model_change_requires_reconnect` 且确认没有模型输出、工具执行或新轮次时重试一次；已有 thread、普通失败和续作不走该重试。

## 本地检查与验证

不启动 bridge、不调用真实模型的检查：

```powershell
npm run check
npm test
```

离线生成卡片演示（按钮只操作示例数据，实际外观以飞书为准）：

```powershell
node .\scripts\preview-cards.mjs
```

生成 `outputs/feishu-cards-preview.html` 和 `.json`；可直接打开 HTML。`npm run preview:cards` 还会启动本地 HTTP 预览服务，终端显示地址，按 Ctrl+C 结束。

以下是可选真实验证入口；表格描述脚本用途，不表示已在当前环境通过。所有脚本使用本地记录信使，不向飞书聊天发送测试消息；有模型调用的验证会创建本机测试会话和临时文件，结束时尝试归档测试会话并清理。

| 命令 | 前提 / 验证内容 | 主要输出（相对仓库根目录） |
| --- | --- | --- |
| `npm run test:history:live -- "<已有历史的项目绝对路径>"` | 本机引擎及分页接口；只读历史、翻页、范围与私聊限制，不启动模型轮次 | `outputs/history-verification/result.json` |
| `npm run test:live` | 客户端已打开、可调用模型；真实任务的引导、停止、同 thread 续作、原配置和旧待办暂停 | `outputs/task-resume-verification.json`、`outputs/task-resume-history.json` |
| `npm run test:attach:live` | 客户端已打开，脚本固定模型 `gpt-5.6-sol` 可用；附加已有 thread、上下文、设置继承与持久化 | `outputs/thread-attachment-verification.json` |
| `node .\scripts\verify-model-switch.mjs` | 客户端已打开，脚本固定模型 `gpt-5.6-sol` 可用；目录、分页、按钮、命令及实际模型切换 | `outputs/model-switch-verification.json` |

历史验证结果不保存聊天正文；续作验证会保存测试聊天历史。是否通过以本次命令退出状态及输出文件为准，历史产物不能证明当前环境仍可用。
