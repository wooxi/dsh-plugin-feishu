# dsh-plugin-feishu DSH 飞书通道插件

**在飞书里直接和你的 DeepSeek Harness Agent 对话。**

[English](README.md) · **中文**

流式卡片、思考折叠、工具调用进度、审批、图片收发 —— 全部在你团队已经在用的飞书里。不需要公网 IP，不需要 Webhook 地址，不需要端口映射。

<p align="center">
  <img src="docs/images/card-streaming.png" alt="飞书流式卡片" width="620">
</p>

---

## 能做什么

### 一张卡片，跟着 Agent 的思路长出来

回复不是等半天之后砸出来的一大段文字。你发消息的瞬间就开出一张飞书卡片，然后内容边想边长：工具调用跑一个显示一个，思考过程流进折叠面板，最终答案逐字打出来。

- **工具调用指示** —— 每次搜索、命令、读文件都会显示参数和耗时
- **思考过程折叠** —— 过程看得见，但答案一开始就自动收起，卡片不会长得离谱
- **底部实时统计** —— 状态、耗时、模型、token、缓存命中率挤在一行：
  `✅ 已完成 · 24s · gemini-3.8-flash · 33.0k tokens · 缓存 90%`
- **Markdown 正常渲染** —— 标题、列表、链接、代码块、表格都按该有的样子显示

### 是设置页，不是配置文件

所有配置都在 **DSH 设置 → 飞书通道** 里完成。凭据、管理员、目录、功能开关，全在界面上。

<p align="center">
  <img src="docs/images/settings-credentials.png" alt="飞书通道设置：凭据、管理员、目录" width="520">
</p>

- **保存并验证** —— 点一下：保存配置、验证鉴权、给你发一条真实测试消息、顺便把专用工作区建好
- **扫码配对** —— 用飞书 App 扫一下，管理员 Open ID 自动填进去
- **密钥不出服务端** —— App Secret 不会回传浏览器，界面上永远只有掩码

### 功能开关

<p align="center">
  <img src="docs/images/settings-features.png" alt="高级特性开关与扫码配对" width="500">
</p>

| 开关 | 作用 |
|---|---|
| CardKit 2.0 原生卡片流式输出 | 用会自己更新的卡片代替纯文本回复 |
| 思考过程折叠 | 把推理过程收进可展开的面板 |
| 工具调用状态指示 | 把工具调用显示成状态行 |
| 多模态图文输入与输出回显 | 收图片，也能把本地图片发回飞书 |
| 群聊 @ 机器人协作支持 | 允许在群里 @ 机器人 |

### 给共享机器准备的

- **只认一个主人** —— 这个机器人能跑命令、能碰文件，所以只回答一个飞书账号。不填管理员时，第一个发消息的人会被绑定并收到通知，之后其他人一律拒绝。
- **独立工作区** —— 飞书会话归在专属工作区分组下，不会和你浏览器里的会话混在一起，重启也还在。
- **独立目录** —— 附件、Agent 产物、消息流水账都在你指定的同一个文件夹里。
- **引用回复** —— 每条回答都是对你好条消息的回复，而不是飘在外面的新消息。
- **不开放入站端口** —— 连接是纯出站的。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-feishu
dsh --profile web
```

然后打开 **DSH 设置 → 飞书通道**，填入 App ID 和 App Secret，点 **保存并验证**。

## 飞书应用配置

在[飞书开放平台](https://open.feishu.cn)的自建应用里：

1. **权限** —— 开通 `im:message`、`im:message.p2p_msg:readonly`、`im:resource`；要玩群聊再加 `im:message.group_at_msg:readonly`。
2. **事件** —— 订阅方式选**「使用长连接接收事件」**，添加 `im.message.receive_v1` 和 `card.action.trigger`。
3. **发布** —— 改过权限或事件后，要创建并发布新版本。

> 第 2 步是最容易漏的。如果发得出去但收不到回复，先查这里。

## 环境要求

- DSH `0.2.x`，Web profile
- Node `>=20`
- 一个开通了长连接事件订阅的飞书自建应用

## 常见问题

**`ERR_PNPM_IGNORED_BUILDS: protobufjs`** —— pnpm 拦了飞书 SDK 一个传递依赖的 postinstall。放行一次再装：

```yaml
# ~/.dsh/profiles/<profile>/pnpm-workspace.yaml
allowBuilds:
  protobufjs: true
```

**消息进来了但不回复** —— 事件订阅方式还是 Webhook。改成「长连接」并发布版本。

**会话跑到「未分组」里** —— 点一次 **保存并验证**，它会建好工作区。在这之前创建的会话留在原地。

## 许可证

MIT
