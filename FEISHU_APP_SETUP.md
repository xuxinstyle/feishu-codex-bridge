# 飞书应用配置（Codex bridge）

在 [飞书开放平台](https://open.feishu.cn/app) 创建「企业自建应用」，按顺序完成：

1. **添加能力** -> 启用「机器人」
2. **事件与回调** -> 加密策略选「使用长连接接收事件」（不要选 HTTP 回调）
3. **事件订阅** -> 添加：
   - `im.message.receive_v1`
   - `card.action.trigger`（互动卡片按钮）
4. **权限管理** -> 选择「应用身份」权限，按下方清单核对名称及用途。
5. **版本管理与发布** -> 创建版本并发布；改权限后必须重新发布
6. 复制 **App ID**、**App Secret** 到 `secrets/feishu_codex_bridge.env`

## 飞书权限清单

以下 12 项对应已开通权限的后台截图，权限类型均为「应用身份」。这是现有配置的完整对照，不代表当前 bridge 的每项功能都需要全部 12 项权限。

| 权限名称（按截图） | 权限标识 | 当前 bridge 中的用途 |
| --- | --- | --- |
| 获取卡片信息 | `cardkit:card:read` | 当前未调用 CardKit 卡片查询接口 |
| 创建与更新卡片 | `cardkit:card:write` | 当前未调用 CardKit 卡片实体接口；任务卡片通过消息接口发送和更新 |
| 获取卡片模板信息 | `cardkit:template:read` | 当前未调用卡片模板查询接口 |
| 创建、更新、删除应用消息流卡片 | `im:app_feed_card:write` | 当前未调用应用消息流卡片接口 |
| 获取与更新群组信息 | `im:chat` | 当前未调用群信息查询或更新接口；群聊 @ 消息接收见下方对应权限 |
| 调用即时提醒能力 | `im:datasync.feed_card.time_sensitive:write` | 当前未调用即时提醒接口 |
| 获取与发送单聊、群组消息 | `im:message` | 消息接口的综合权限，涉及机器人消息收发等能力 |
| 获取群组中用户 @机器人消息 | `im:message.group_at_msg:readonly` | 接收群聊中 @机器人的消息，需同时订阅 `im.message.receive_v1` |
| 读取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | 接收用户发给机器人的私聊消息，需同时订阅 `im.message.receive_v1` |
| 以应用的身份发消息 | `im:message:send_as_bot` | 以机器人身份发送或回复文本、互动卡片和图片消息 |
| 更新消息 | `im:message:update` | 对应消息更新能力，用于文本编辑、任务进度和控制面板卡片更新；具体授权要求以对应接口为准 |
| 获取与上传图片或文件资源 | `im:resource` | 当前用于上传 Codex 生成的图片；用户图片通过消息资源接口下载，需另按该接口核对消息读取权限；当前 bridge 未实现通用文件收发 |

原清单中的 `im:message:send` 不再作为开通要求列出；机器人发送消息使用上表中的 `im:message:send_as_bot` 或 `im:message`。部分接口支持多个权限任选其一，不应把综合权限和细分权限都理解为必须同时具备。新建应用请结合实际使用的功能及对应 API 的权限要求配置；上表中「当前未调用」的权限不作为当前 bridge 的必需项。

当前代码通过 `im.message.create` / `reply` 发送卡片，通过 `im.message.patch` 更新卡片；普通互动卡片及进度刷新不等于调用 CardKit 或应用消息流卡片接口。按钮点击仍需单独配置 `card.action.trigger` 回调，开通卡片权限不能替代回调配置。

官方接口说明：[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[编辑消息](https://open.feishu.cn/document/server-docs/im-v1/message/update)、[更新已发送的消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)、[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)。权限或事件配置变更后，创建并发布新版本，按后台提示完成审批后再验证。

## 首次绑定

1. 在仓库根目录完成 [README 快速开始](README.md#快速开始windows) 的配置和初始化后，运行 `.\start.ps1`。
2. 终端会显示 6 位配对码
3. 在飞书给机器人私聊发送该配对码
4. 绑定的 open_id 写入 `~/.feishu-codex-bridge/config.env`，后续按白名单限制使用。也可提前配置逗号分隔的 `ALLOWED_USER_IDS`；非空时不会生成配对码。当前代码在白名单为空时不会阻断全部普通任务，等待配对不能视为访问保护。

## 群聊 @ 排查

群里 @ 无响应时，优先检查：

1. 机器人已经被加入目标群。
2. 事件订阅存在 `im.message.receive_v1`。
3. 权限包含 `im:message.group_at_msg:readonly`，并且权限变更后已经发布新版本。
4. bridge 终端能看到 `raw Feishu message event received` / `message received` 日志；如果完全没有日志，说明飞书没有把群 @ 事件推到本机。

卡片按钮无响应时，优先检查事件订阅是否包含 `card.action.trigger`，并且权限 / 事件变更后已经发布新版本。

## 常用指令

| 指令 | 说明 |
|------|------|
| `/panel` / `面板` | 打开飞书按钮控制卡片 |
| 直接发文本 | 在当前聊天选中的项目和 session 中排队执行 Codex 任务 |
| `/run <描述>` | 在当前项目执行 |
| `/run <路径> <描述>` | 指定目录执行 |
| `/sessions` | 查看当前项目的 bridge session 列表 |
| `/use <名字>` | 切换当前聊天窗口的 active session |
| `/new <名字>` | 新建/重置命名 session 并切换过去 |
| `/new` | 重置当前 session 的映射，保留当前名字；不删除 Codex 历史 |
| `/status` | 查看当前 session / 最近任务 |
| `/cancel task-xxxx` | 取消任务 |
| `/help` | 帮助 |

## Codex 执行权限

默认配置为 `CODEX_SANDBOX_MODE=workspace-write` 和 `CODEX_APPROVAL_POLICY=never`，用于独立 App Server 启动/恢复 thread，以及桌面通道创建新 thread 时的传参。

如需将上述传参改为 `danger-full-access` 和 `never`，在 `secrets/feishu_codex_bridge.env` 中设置以下选项，然后重新运行 `.\setup.ps1` 并重启 bridge：

```env
CODEX_DANGEROUS_BYPASS=1
```

桌面通道继续已有或附加会话时，由客户端执行实际轮次，不能保证这些变量重新配置其 sandbox 和审批策略；需要确认或输入时仍应到客户端处理。详见 [README 执行权限说明](README.md#执行权限与辅助引擎配置)。

需要额外覆盖辅助引擎配置时，可在 env 文件中按以下格式填写，再重新 setup 并重启；字段及取值需当前引擎支持，不能保证修复任意旧配置问题：

```env
CODEX_CONFIG_OVERRIDES=service_tier="fast"
CODEX_MODEL=<当前 CLI 支持的模型>
```
