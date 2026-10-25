# dsh-plugin-feishu

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**飞书 / Lark 通道插件**。在飞书里直接和你的 Agent 对话——流式卡片、思考折叠、工具调用进度、审批交互、图片收发。

全链路走**出站 WebSocket 长连接**：不需要公网 IP、不用端口映射、不用暴露 Webhook 地址。

```
飞书客户端  ⇄  WebSocket 长连接  ⇄  dsh-plugin-feishu  ⇄  DSH 宿主
```

---

## 特性

- **CardKit 2.0 流式卡片**：回复是一张持续更新的卡片，按 `sequence` 游标推流并做防抖，长回答不会撞单卡大小上限。
- **思考折叠**：模型的思考过程流进可折叠面板，正文开始后自动收起。
- **工具调用追踪**：每一步 shell / grep / read 都以带耗时的状态行呈现。
- **Waterfall 审批**：DSH 的审批请求变成卡片按钮，不用离开飞书就能批准或拒绝；自由问答直接回文本即可。
- **多模态收发**：把截图发进会话；Agent 产出的本地图片会上传并内联渲染。
- **引用回复**：每条回答挂在用户那条消息下面，不会变成散落的新消息。
- **设置页**：在 **DSH 设置 → 飞书通道** 里配置 App ID / Secret / 管理员 / 存储目录，还提供扫码配对，自动填好管理员 Open ID。
- **按会话隔离**：一个飞书会话对应一个 DSH 会话，重启后仍在；专属工作区让它的文件不混进你的主工作区。

## 运行要求

| | |
|---|---|
| DSH | `>=0.2.0 <0.3.0`，需要 **Web** 形态（`webServer` 服务） |
| Node | `>=20` |
| 飞书 | 在[飞书开放平台](https://open.feishu.cn)创建的企业自建应用，事件订阅方式为长连接 |

本插件是 **GUI 插件**。设置页依赖 Web profile 的 `webServer`；在纯 headless profile 下它会停在 `waiting for service: webServer`。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-feishu
dsh --profile web --dump-config    # 应能看到 "feishu-channel" 这一行
dsh --profile web
```

从本地目录安装：

```sh
dsh plugin --profile web add /path/to/dsh-plugin-feishu
```

两种方式装的都是已构建好的 JavaScript，没有 `prepare` 构建步骤，因此不需要授予 `allowBuilds` 执行权限。

## 飞书应用配置

1. 在[飞书开放平台](https://open.feishu.cn)创建**企业自建应用**。
2. **权限管理**，添加以下权限：
   - `im:message` —— 收发消息
   - `im:message.p2p_msg:readonly` —— 读取用户发给机器人的单聊消息
   - `im:message.group_at_msg:readonly` —— 读取群里 @ 机器人的消息（仅启用群聊时需要）
   - `im:resource` —— 上传下载图片与文件
3. **事件订阅**，方式必须选**「使用长连接接收事件」**，*不要*填 Webhook 地址。添加：
   - `im.message.receive_v1`
   - `card.action.trigger`
4. **版本管理与发布** —— 改完权限或事件后必须创建并发布新版本，否则应用仍用旧授权。

> 事件订阅方式是最常见的踩坑点。如果出站消息正常但收不到回复，先查这一步。

## 配置

打开 **DSH 设置 → 飞书通道**：

| 字段 | 说明 |
|---|---|
| App ID / App Secret | 飞书应用凭证页里的值 |
| 管理员 Open ID | 谁能和这个实例对话；也可以扫码自动填入 |
| 存储目录 | 附件与消息审计日志的落盘位置（默认 `/dsh-workspace/feishu`） |
| 工作区目录 | 飞书会话在 DSH 侧栏归属的工作区分组 |
| 私聊策略 | `owner`（仅管理员）或 `open`（任何人） |
| 群聊 | 是否允许群里 @ 机器人 |

也可以直接写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: feishu-channel
  config:
    appId: cli_xxxxxxxxxxxx
    appSecret: your_app_secret
    ownerId: ou_xxxxxxxxxxxx
    workspaceDir: /dsh-workspace/feishu
    dmPolicy: owner
```

文件都落在存储目录下：

```
<workspaceDir>/
├── attachments/                 # 从飞书收到的图片与文件
├── artifacts/                   # Agent 为飞书会话产出的文件
├── logs/feishu-messages.jsonl   # 进出站消息审计流水
└── session-bindings.json        # 飞书 chat → DSH 会话的绑定表
```

## 实现结构

```
lib/
├── index.js                     # 插件入口：apply()、inject、事件装配
├── config.js                    # Schemastery 配置 schema
├── client.js                    # 设置页 UI（DSH 客户端槽位）
├── transport/
│   ├── ws-gateway.js            # 飞书长连接事件循环
│   └── lark-client.js           # REST：消息、CardKit、资源
├── streaming/
│   ├── card-builder.js          # CardKit 2.0 卡片 JSON（流式 + 完成态）
│   ├── cardkit-controller.js    # 卡片生命周期：start → stream → finalize
│   ├── markdown-style.js        # 飞书 markdown 的坑（标题、表格、图片 key）
│   ├── flush-controller.js      # 增量更新防抖与合并
│   └── tool-use-tracker.js      # 工具调用状态 → 卡片元素
├── host/
│   ├── session-bridge.js        # chat → DSH 会话解析与投递
│   ├── admission.js             # 去重、防重放窗口、管理员准入
│   ├── storage-manager.js       # 专属目录布局 + 审计日志
│   └── config-router.js         # 设置页 HTTP API
├── interaction/
│   ├── approval-handler.js      # waterfall 审批 → 卡片按钮
│   ├── question-handler.js      # waterfall 反问 → 卡片 / 文本回复
│   └── menu-handler.js          # /new、/model、/help 指令
└── media/                       # 图片下载与上传
```

## 测试

```sh
npm test
```

31 项测试覆盖配置 schema、卡片 JSON 结构、流式生命周期、准入规则、会话绑定、传输重试和 waterfall 交互。全部不需要真实飞书租户——传输层在 `fetch` 边界被 mock。

测试无法覆盖的只有飞书那一侧：事件订阅方式、权限范围、应用版本发布。如果插件日志里已经出现 `飞书长连接已建立` 但仍收不到消息，那是飞书后台配置问题，不是插件问题。

## 许可

MIT © wooxi
