# 交接文档 / Handoff

DSH 飞书通道插件（`dsh-plugin-feishu`）的接手说明。面向下一个要改这个项目的人。

- 仓库：https://github.com/wooxi/dsh-plugin-feishu
- 本地：`/dsh-workspace/dsh-plugin-feishu`
- 版本：`1.1.0`（tag `v1.1.0`）
- 规模：21 个源文件、约 3.9k 行、33 项测试（`npm test`）
- 安装位置：`/root/.dsh/profiles/web/node_modules/dsh-plugin-feishu`（以 `github:wooxi/dsh-plugin-feishu` 形式安装，非 link）

---

## 一、这个插件是什么

把 DeepSeek Harness 接到飞书：用户在飞书发消息 → 插件转成 DSH 会话 prompt → agent 的流式输出实时渲染成一张飞书卡片。

核心约束：**飞书长连接是纯出站的**（`@larksuiteoapi/node-sdk` 的 `WSClient`），所以不需要公网 IP、不需要 webhook 地址。这一点决定了整个架构。

```
飞书客户端 ⇄ WebSocket 长连接 ⇄ ws-gateway ⇄ session-bridge ⇄ DSH sessionController
                                      ↓
                              cardkit-controller（流式卡片）
```

## 二、代码结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` (695) | 插件入口。`apply()` 组装所有部件、注册事件、处理入站消息 |
| `lib/config.js` (49) | Schemastery 配置 schema（13 个字段） |
| `lib/client.js` (499) | 设置页 UI（在 DSH settings slot 里渲染） |
| `lib/transport/ws-gateway.js` (184) | 长连接事件循环 |
| `lib/transport/lark-client.js` (196) | REST 封装：发消息、CardKit、资源上传 |
| `lib/streaming/card-builder.js` (350) | 卡片 JSON 构造（流式卡 + 完成卡） |
| `lib/streaming/cardkit-controller.js` (158) | 卡片生命周期：创建 → 流式更新 → 收尾整卡替换 |
| `lib/streaming/flush-controller.js` (66) | 更新节流，避免撞飞书限流 |
| `lib/streaming/markdown-style.js` (91) | 飞书 markdown 适配（标题降级、表格限流、图片 key 过滤） |
| `lib/host/session-bridge.js` (317) | chat → DSH 会话的解析、创建、prompt 投递、中止 |
| `lib/host/admission.js` (92) | 去重、防重放、owner 鉴权、群聊 @ 判定 |
| `lib/host/config-router.js` (473) | 设置页 HTTP API：读写配置、验证、QR 配对 |
| `lib/host/storage-manager.js` (67) | 专用目录布局 + 消息审计日志 |
| `lib/interaction/*` (340) | waterfall 审批、提问、菜单命令 |

## 三、必须知道的六个坑

这些都是真踩过的，不是理论风险。改代码前先看一遍。

### 1. Cordis 的 `inject` 声明错了，`apply()` 直接不执行

```js
// 错：空数组 = 不声明任何依赖，某些版本下 apply 不会被调用
export const inject = [];
```

正确写法是显式列出用到的服务：

```js
export const inject = ['credentials', 'webServer', 'sessionController',
                       'workspaceController', 'agentDefaultModel'];
```

**症状**：日志里连 `Plugin apply called` 都没有，插件像没装一样。

### 2. `package.json` 的 `name` 必须和 loader 里的 id 完全一致

DSH 前端模块加载器（`dsh-client-modules`）扫描包时要求 `pkg.name === 插件标识`。曾经写成 `dsh-feishu-channel` 而 loader 里是 `dsh-plugin-feishu`，结果**设置页菜单凭空消失**——包里明明有 `lib/client.js`，但 `__DSH_BOOT__` 里就是不注入。

排查手法：抓 `/` 的 HTML，看 `__DSH_BOOT__` 的插件清单里有没有这个模块。

### 3. 不要自己指定 sessionId，否则会话永远落在「未分组」

DSH 把会话挂到工作区，是在 `sessionController.create()` 内部调 `workspace.attachSession()` 完成的。这个 attach 依赖 `candidateMatches()`，而它查的是 registry 内部的 `sessionPaths` 缓存。

自己传 `{ workspaceId, sessionId: '自造ID' }` 时，attach 会静默失败：`workspace.json` 里 `sessionIds` 是空数组，侧栏显示「未分组」。

**正确做法**：`create({ workspaceId })`，让宿主生成 ID，插件只负责记住 chatId → sessionId 的映射（存在 `session-bindings.json`）。

### 4. 设置页保存必须能把配置写进 `cordis.patch.yml`

最初实现只在 patch 里**已存在** `appId:` 行时才替换。全新安装时那段不存在，于是保存只改内存：当场能用，一重启凭据全丢。

现在用 `mergePatch()`：没有段就追加整块，有就整段原位替换（用行扫描，不用正则，避免重复键）。有 2 项测试守着。

### 5. `@deepseek-ai/schemastery` 不能放 peerDependencies

DSH profile 的 pnpm 配置是 `autoInstallPeers: false`，peer 永远不会被装。插件 `import('@deepseek-ai/schemastery')` 失败后会走降级 stub，`Config` 不是真 Schema，宿主拿不到默认值和校验。

必须放 **dependencies**（`^3.18.5`，和宿主同版本）。`@deepseek-ai/cordis` 可以留 peer —— 插件只是导出函数，不继承它的类。

### 6. 飞书卡片 schema 2.0 的坑

- `tag: 'action'` 在 2.0 已废弃，用了报 `200861`。按钮改用 `column_set` + `button`。
- 卡片里图片的 key 必须是 `img_` 开头，否则 `200570`。`markdown-style.js` 里会过滤掉非法的。
- 一张卡最多渲染 5 个表格，超出的降级成代码块（`downgradeTables`）。
- 标题只认 H4/H5 两档字重，H1~H3 会被渲染得很怪，`optimizeMarkdownStyle` 做降级。

## 四、运行时依赖的外部配置

部署到新机器时，这两处必须确认，否则装不上/跑不起来：

**1. protobufjs 的 postinstall 被 pnpm 拦**

`@larksuiteoapi/node-sdk` 的传递依赖 `protobufjs` 带 postinstall。pnpm 会写一个占位符到：

```yaml
# ~/.dsh/profiles/<profile>/pnpm-workspace.yaml
allowBuilds:
  protobufjs: true     # 把 set this to true or false 改成 true
```

**2. 飞书后台的事件订阅方式**

必须是**「使用长连接接收事件」**。如果是 Webhook 模式，长连接能建立、能发消息，但**永远收不到任何事件**——所有日志都正常，就是不响应。

这个坑排查了很久：写了个独立探针（`ws-probe.mjs`）跑 3 分钟，`onReady` 正常触发、零事件，才锁定是后台配置问题。

## 五、开发与发布

```sh
npm test                                  # 33 项，不需要真实飞书租户
git tag -a vX.Y.Z -m "..." && git push --tags
```

给用户装：

```sh
dsh plugin --profile web add github:wooxi/dsh-plugin-feishu
```

**改完代码要 bump 版本号**。dshmarket 用 commit 对比已装版本，版本号不动就会一直显示「有新提交（未发版）」——它能看见但不会装。

**重启才有用**。前端模块清单（`__DSH_BOOT__`）在服务启动时一次性编排，改 `package.json`、改 client 代码都得重启 `dsh-web`。

## 六、当前状态与待办

**已验证可用**（2026-10-25，真实飞书租户）：
- 长连接收发、流式卡片、思考折叠、工具调用状态、footer 统计
- 会话归组到 `/dsh-workspace/feishu` 工作区
- 首次消息自动绑定 owner，之后拒绝其他人
- 设置页保存并验证、QR 配对

**待办**：

1. **「保存并验证」按钮没有端到端实测过** —— 代码写完了，用户还没点过。重启后应该点一次确认。
2. **群聊 @ 机器人没有实测** —— `enableGroupChat` 默认关闭，逻辑写了但没跑过真实群。
3. **审批卡片没有实测** —— `approval-handler.js` 按 waterfall 契约实现，但真实审批流没触发过。
4. **多模态图片没有实测** —— 收发图片的代码在，但没有真实用例验证。
5. 上面 2~4 项如果有问题，`test/` 里对应单测是 mock 的，帮不上忙，只能上真机。

## 七、相关文件位置

| 内容 | 路径 |
|---|---|
| 插件源码 | `/dsh-workspace/dsh-plugin-feishu` |
| 已安装副本 | `/root/.dsh/profiles/web/node_modules/dsh-plugin-feishu` |
| profile 配置 | `/root/.dsh/profiles/web/cordis.patch.yml`（`- id: feishu-channel` 段） |
| 会话归属注册表 | `/root/.dsh/storages/workspace.json` |
| 飞书会话文件 | `/root/.dsh/sessions/--dsh-workspace-feishu--/` |
| 附件/日志/绑定 | `/dsh-workspace/feishu/` |
| 重装前的备份 | `/tmp/feishu-reinstall-backup/` |

## 八、排障顺序

遇到「飞书发消息没反应」，按这个顺序查，能少走很多弯路：

1. `journalctl -u dsh-web | grep feishu` —— 有没有 `✅ 飞书长连接已建立`
2. 有没有 `收到 im.message.receive_v1` —— 没有就是飞书后台事件订阅方式不对
3. 有没有 `Inbound message accepted` —— 没有就是被 admission 拦了（看 `reason`）
4. 有没有 `已投递到会话` —— 没有就是 sessionController 出问题
5. 有没有 `card finalized` —— 没有就是卡片链路卡住

---

*文档写于 2026-10-25。代码变动较大时请顺手更新，尤其是第三章那六个坑——它们是最容易重复踩的。*
