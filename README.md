# dsh-plugin-feishu

A **Feishu / Lark channel** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Chat with your agent from Feishu — streaming cards, thinking folds, tool-call progress, approvals, images.

Everything runs over an **outbound WebSocket long connection**: no public IP, no port forwarding, no webhook endpoint to expose.

```
Feishu client  ⇄  WebSocket long connection  ⇄  dsh-plugin-feishu  ⇄  DSH host
```

---

## Features

- **CardKit 2.0 streaming cards** — the reply is one live card updated with a debounced `sequence` cursor, so long answers never hit the single-card size limit.
- **Thinking folds** — reasoning streams into a collapsible panel that collapses itself when the answer starts.
- **Tool-call tracking** — every shell/grep/read step shows up as a status line with elapsed time.
- **Waterfall approvals** — DSH approval requests arrive as card buttons; approve or reject without leaving Feishu. Free-form questions accept a plain text reply.
- **Multimodal I/O** — send a screenshot into the chat; local images the agent produces are uploaded and rendered inline.
- **Reply threading** — each answer is a reply to the user's message, not a loose new message.
- **Settings page** — configure App ID / Secret / owner and storage directory from **DSH Settings → Feishu Channel**, including a QR-code pairing flow that fills in the owner Open ID for you.
- **Per-chat sessions** — one Feishu chat maps to one DSH session that survives restarts; a dedicated workspace keeps its files away from your main one.

## Requirements

| | |
|---|---|
| DSH | `>=0.2.0 <0.3.0`, **Web** surface (`webServer` service) |
| Node | `>=20` |
| Feishu | A self-built app in [Feishu Open Platform](https://open.feishu.cn) with long-connection event subscription |

This is a **GUI plugin**. It needs the Web profile's `webServer` service for its settings page; under a headless-only profile it will sit at `waiting for service: webServer`.

## Install

```sh
dsh plugin --profile web add dsh-plugin-feishu
dsh --profile web --dump-config    # the "feishu-channel" row should now appear
dsh --profile web
```

From a local checkout instead:

```sh
dsh plugin --profile web add /path/to/dsh-plugin-feishu
```

Both forms install prebuilt JavaScript — there is no `prepare` build step, so no `allowBuilds` permission is needed.

## Feishu app setup

1. Create a **self-built application** at [open.feishu.cn](https://open.feishu.cn).
2. **Permissions** — add these scopes:
   - `im:message` — send and receive messages
   - `im:message.p2p_msg:readonly` — read direct messages sent to the bot
   - `im:message.group_at_msg:readonly` — read group messages that @-mention the bot (only if you enable group chat)
   - `im:resource` — upload and download images and files
3. **Events** — choose **"Receive events through long connection"** (长连接), *not* a webhook URL. Add:
   - `im.message.receive_v1`
   - `card.action.trigger`
4. **Publish** — create and release a version after changing scopes or events, otherwise the app keeps the old grant.

> The event subscription mode is the most common setup mistake. If replies never arrive but outbound messages work, check that step first.

## Configure

Open **DSH Settings → Feishu Channel** and fill in:

| Field | Meaning |
|---|---|
| App ID / App Secret | from the Feishu app's credentials page |
| Owner Open ID | who may talk to this instance; also settable by scanning the QR code |
| Storage directory | where attachments and the message audit log go (default `/dsh-workspace/feishu`) |
| Workspace directory | the DSH workspace the Feishu sessions are grouped under |
| DM policy | `owner` (only the owner) or `open` |
| Group chat | allow @-mentions in groups |

The same values can be set in the profile's `cordis.patch.yml`:

```yaml
- id: feishu-channel
  config:
    appId: cli_xxxxxxxxxxxx
    appSecret: your_app_secret
    ownerId: ou_xxxxxxxxxxxx
    workspaceDir: /dsh-workspace/feishu
    dmPolicy: owner
```

Files land in the storage directory:

```
<workspaceDir>/
├── attachments/                 # images and files received from Feishu
├── artifacts/                   # files the agent produced for Feishu sessions
├── logs/feishu-messages.jsonl   # inbound/outbound audit trail
└── session-bindings.json        # Feishu chat → DSH session map
```

## How it works

```
lib/
├── index.js                     # plugin entry: apply(), inject, event wiring
├── config.js                    # Schemastery config schema
├── client.js                    # settings-page UI (DSH client slot)
├── transport/
│   ├── ws-gateway.js            # Feishu long-connection event loop
│   └── lark-client.js           # REST: messages, CardKit, resources
├── streaming/
│   ├── card-builder.js          # CardKit 2.0 card JSON (streaming + complete)
│   ├── cardkit-controller.js    # card lifecycle: start → stream → finalize
│   ├── markdown-style.js        # Feishu markdown quirks (headings, tables, img keys)
│   ├── flush-controller.js      # debounce & coalesce chunk updates
│   └── tool-use-tracker.js      # tool-call state → card elements
├── host/
│   ├── session-bridge.js        # chat → DSH session resolution and prompting
│   ├── admission.js             # dedup, replay window, owner gate
│   ├── storage-manager.js       # dedicated directory layout + audit log
│   └── config-router.js         # settings-page HTTP API
├── interaction/
│   ├── approval-handler.js      # waterfall approval → card buttons
│   ├── question-handler.js      # waterfall questions → card / text reply
│   └── menu-handler.js          # /new, /model, /help commands
└── media/                       # image download and upload
```

## Tests

```sh
npm test
```

31 tests cover the config schema, card JSON shape, streaming lifecycle, admission rules, session binding, transport retries and the waterfall interaction handlers. None of them need a live Feishu tenant — the transport is mocked at the `fetch` boundary.

The one thing tests cannot prove is the Feishu side: event subscription mode, scopes and app release. If the plugin logs `飞书长连接已建立` and inbound messages still never appear, that is a Feishu console problem, not a plugin problem.

## License

MIT © wooxi
