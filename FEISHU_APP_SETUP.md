# 飞书应用配置（Codex bridge）

在 [飞书开放平台](https://open.feishu.cn/app) 创建「企业自建应用」，按顺序完成：

1. **添加能力** -> 启用「机器人」
2. **事件与回调** -> 加密策略选「使用长连接接收事件」（不要选 HTTP 回调）
3. **事件订阅** -> 添加：
   - `im.message.receive_v1`
   - `card.action.trigger`（互动卡片按钮）
4. **权限管理** -> 至少开通：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:message:send`
   - `im:chat`
   - `im:message.p2p_msg:readonly`
   - `im:message.group_at_msg:readonly`
5. **版本管理与发布** -> 创建版本并发布；改权限后必须重新发布
6. 复制 **App ID**、**App Secret** 到 `secrets/feishu_codex_bridge.env`

## 首次绑定

1. 运行 `tool/feishu-codex-bridge/start.ps1`
2. 终端会显示 6 位配对码
3. 在飞书给机器人私聊发送该配对码
4. 绑定成功后仅你的 open_id 可使用，写入 `~/.feishu-codex-bridge/config.env`

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
| 直接发文本 | 在默认仓库排队执行 Codex 任务 |
| `/run <描述>` | 在默认仓库执行 |
| `/run <路径> <描述>` | 指定目录执行 |
| `/sessions` | 查看当前默认仓库的 session 列表 |
| `/use <名字>` | 切换当前聊天窗口的 active session |
| `/new <名字>` | 新建/重置命名 session 并切换过去 |
| `/new` | 清除当前 active session 映射 |
| `/status` | 查看当前 session / 最近任务 |
| `/cancel task-xxxx` | 取消任务 |
| `/help` | 帮助 |

## Codex 执行权限

默认配置为 `CODEX_SANDBOX_MODE=workspace-write` 和 `CODEX_APPROVAL_POLICY=never`。

如果你要让飞书指令完全无人值守地执行本机命令，先确认这个机器人只绑定你本人，再在 `secrets/feishu_codex_bridge.env` 中设置：

```env
CODEX_DANGEROUS_BYPASS=1
```

如果本机 `~/.codex/config.toml` 有旧版不兼容配置，可用：

```env
CODEX_CONFIG_OVERRIDES=service_tier="fast"
CODEX_MODEL=<当前 CLI 支持的模型>
```
