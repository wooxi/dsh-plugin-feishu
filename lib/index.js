import { Config } from './config.js';
import { AdmissionController } from './host/admission.js';
import { createLarkTransport } from './transport/lark-client.js';
import { WsGateway } from './transport/ws-gateway.js';
import { CardKitController } from './streaming/cardkit-controller.js';
import { ToolUseTracker } from './streaming/tool-use-tracker.js';
import { SessionBridge } from './host/session-bridge.js';
import { ApprovalHandler } from './interaction/approval-handler.js';
import { QuestionHandler } from './interaction/question-handler.js';
import { MenuHandler } from './interaction/menu-handler.js';
import { downloadLarkImage } from './media/image-downloader.js';
import { extractMarkdownImages, uploadLocalImageToLark } from './media/image-uploader.js';
import { FeishuConfigRouter } from './host/config-router.js';
import { FeishuStorageManager } from './host/storage-manager.js';
import { registerLogExporter } from './host/log-exporter.js';

export const name = 'dsh-plugin-feishu';
export { Config };

/**
 * 声明的宿主服务依赖。
 *
 * Cordis 语义（cordis/lib/index.js:676）：未在 inject 里声明的服务，读 ctx 属性会抛
 * `cannot get property "X" without inject`。因此这里必须声明真正要用的服务：
 * - credentials：读取飞书应用凭据（可选，缺省回落到 config）
 * - webServer：挂设置页 HTTP 路由
 * - sessionController：把飞书消息投递进 DSH 会话（dsh-api-session-controller 提供）
 * - workspaceController：把飞书目录注册成工作区（会话才不进「未分组」）
 * - agentDefaultModel：读当前模型，显示在卡片 footer
 */
export const inject = [
  'credentials',
  'webServer',
  'sessionController',
  'workspaceController',
  'agentDefaultModel',
];

/**
 * 读当前使用的模型名，失败返回空串（footer 少一行而已，不该影响回消息）。
 *
 * @param {object} ctx Cordis context
 * @returns {string}
 */
function currentModelName(ctx) {
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.();
    if (!selection) return '';
    const { provider, model } = selection;
    // 只显示模型 ID；provider 前缀会显得啰嗦（deepseek/deepseek-v4 之类）。
    return String(model || provider || '');
  } catch {
    return '';
  }
}

/**
 * Main entry point for DSH Feishu Channel Plugin
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  // Cordis 的 ctx.logger 默认只写内存 buffer，不打印到 stdout；
  // 不挂 exporter 的话 journalctl 里看不到本插件任何一行日志。
  registerLogExporter(ctx);

  const logger = ctx.logger ? ctx.logger('dsh-feishu') : console;

  let currentConfig = { ...config };
  console.log('[dsh-feishu-channel] Plugin apply called with appId:', currentConfig.appId ? `${currentConfig.appId.slice(0, 6)}***` : '(empty)');

  logger.info('[dsh-feishu-channel] Starting plugin with config:', {
    appId: currentConfig.appId ? `${currentConfig.appId.slice(0, 6)}***` : '(empty)',
    enableCardKit: currentConfig.enableCardKit ?? true,
    enableThinkingFold: currentConfig.enableThinkingFold ?? true,
    enableToolTracker: currentConfig.enableToolTracker ?? true,
  });

  // 0. Initialize Dedicated Storage Manager
  const FEISHU_STORAGE = currentConfig.workspaceDir || '/dsh-workspace/feishu';
  const storageManager = new FeishuStorageManager({
    workspaceDir: FEISHU_STORAGE,
    logger,
  });

  // 1. Initialize Admission
  const admission = new AdmissionController({
    ownerId: currentConfig.ownerId || '',
    enableGroupChat: Boolean(currentConfig.enableGroupChat),
    dmPolicy: currentConfig.dmPolicy || 'open',
  });

  // 2. Initialize Transport
  let transport = createLarkTransport({
    appId: currentConfig.appId,
    appSecret: currentConfig.appSecret,
    logger,
  });

  // 3. Initialize Session Bridge & Interaction Handlers
  // SessionBridge 走宿主 sessionController.prompt() 投递消息（已在 inject 中声明）。
  // 飞书专用目录：既是 DSH 工作区（会话分组），也是 Agent 的工作目录，
  // 附件与审计日志都落在它下面，避免污染主工作区。
  const FEISHU_WORKSPACE = currentConfig.feishuWorkspaceDir || '/dsh-workspace/feishu';

  const sessionBridge = new SessionBridge({
    ctx,
    logger,
    defaultCwd: FEISHU_WORKSPACE,
    workspacePath: FEISHU_WORKSPACE,
    /** 绑定表落盘位置：重启后同一飞书会话仍回到同一个 DSH 会话。 */
    storageDir: FEISHU_STORAGE,
  });

  // 最近一次与机器人对话的用户，用于把审批/反问卡片发回给正确的人
  let lastSenderOpenId = currentConfig.ownerId || '';

  const approvalHandler = new ApprovalHandler({
    transport,
    logger,
    getReceiveId: () => lastSenderOpenId,
  });

  const questionHandler = new QuestionHandler({
    transport,
    logger,
    getReceiveId: () => lastSenderOpenId,
  });

  const menuHandler = new MenuHandler({
    logger,
    onGetHelp: () =>
      `🤖 **DeepSeek Harness 飞书通道已就绪**\n\n` +
      `- 直接发送消息：向 Agent 发送工作指令\n` +
      `- 发送图片：支持多模态输入分析\n` +
      `- 思考链折叠：实时流式折叠显示模型思考过程\n` +
      `- 工具调用指示：清晰了解 Agent 正在执行的命令与耗时\n` +
      `- 审批/反问：直接在私聊卡片或文本输入中快捷回复`,
  });

  // Active streaming controllers mapped by turn/session
  const activeStreams = new Map();

  /**
   * 从工具参数里挑一段最有信息量的摘要，卡片工具面板显示用。
   * @param {Record<string, unknown>} args
   * @returns {string}
   */
  const pickToolSummary = (args) => {
    if (!args || typeof args !== 'object') return '';
    for (const key of ['command', 'path', 'file_path', 'query', 'description', 'pattern', 'url']) {
      const v = args[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return Object.keys(args)
      .slice(0, 2)
      .map((k) => `${k}=${JSON.stringify(args[k])}`)
      .join(', ');
  };

  // 4. Connect WebSocket Gateway
  //
  // 单例保护：同一个飞书应用的多条长连接会被飞书**随机分发**事件，
  // 消息可能落到已废弃的那条上，表现为「长连接正常但收不到消息」。
  // DSH 配置变更会重新 apply 本插件，因此必须主动收掉上一个实例。
  const previousGateway = globalThis.__DSH_FEISHU_GATEWAY__;
  if (previousGateway && previousGateway !== undefined) {
    // apply 是同步函数，这里不 await：先发起关闭，新连接随后建立。
    Promise.resolve()
      .then(() => previousGateway.stop())
      .catch(() => {});
    logger.warn('[dsh-feishu-channel] 检测到上一个长连接实例，已发起关闭（避免同一应用多条连接）');
  }

  let wsGateway = new WsGateway({
    logger,
    onEvent: async (payload) => {
      const type = payload.header?.event_type;
      if (type === 'im.message.receive_v1') {
        await handleInboundMessage(payload.event);
      } else if (type === 'card.action.trigger') {
        return await handleCardAction(payload.event);
      }
    },
  });
  globalThis.__DSH_FEISHU_GATEWAY__ = wsGateway;

  // 5. Config Router & Web Settings Integration
  let configRouter = null;
  configRouter = new FeishuConfigRouter({
    config: currentConfig,
    transport,
    logger,
    // 设置页保存时回写 profile 的 cordis.patch.yml。
    // 路径必须显式给出：单元测试不传该参数，因此永远不会碰真实配置。
    patchPath: (() => {
      const profileDir = process.env.DSH_PROFILE_DIR;
      if (profileDir) return `${profileDir}/cordis.patch.yml`;
      const home = process.env.DSH_HOME;
      if (home) return `${home}/profiles/${process.env.DSH_PROFILE || 'web'}/cordis.patch.yml`;
      return null;
    })(),
    onConfigUpdate: async (newConfig) => {
      logger.info?.('[dsh-feishu-channel] Config updated via Web Settings UI');
      currentConfig = { ...newConfig };
      if (newConfig.workspaceDir) {
        storageManager.setWorkspaceDir(newConfig.workspaceDir);
      }
      if (newConfig.ownerId !== undefined) {
        admission.ownerId = newConfig.ownerId;
      }
      if (newConfig.enableGroupChat !== undefined) {
        admission.enableGroupChat = Boolean(newConfig.enableGroupChat);
      }
      if (newConfig.dmPolicy !== undefined) {
        admission.dmPolicy = newConfig.dmPolicy;
      }

      // Re-create transport with updated credentials
      transport = createLarkTransport({
        appId: newConfig.appId,
        appSecret: newConfig.appSecret,
        logger,
      });
      configRouter.transport = transport;

      // Restart WS gateway if credentials changed
      if (newConfig.appId && newConfig.appSecret) {
        await wsGateway.stop();
        await wsGateway.start({
          appId: newConfig.appId,
          appSecret: newConfig.appSecret,
        });
      }
    },
  });

  if (ctx.inject && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (serverCtx) => {
        configRouter.register(serverCtx.webServer);
      });
    } catch {
      // webServer service not present in current profile
    }
  }

  // 6. Handle Feishu Inbound Message Event
  async function handleInboundMessage(eventData) {
    const message = eventData.message || {};
    const senderOpenId = eventData.sender?.sender_id?.open_id;
    // 记下最近对话的人：审批/反问卡片要发回给这个人
    if (senderOpenId) lastSenderOpenId = senderOpenId;

    let contentText = '';
    if (message.message_type === 'text') {
      try {
        const parsed = JSON.parse(message.content);
        contentText = (parsed.text || '').trim();
      } catch {
        contentText = (message.content || '').trim();
      }
    }

    // Check for QR pairing handshake messages (e.g. /pair <token> or pairing url token)
    if (contentText.includes('mode=pair') || contentText.startsWith('/pair ')) {
      const tokenMatch = contentText.match(/token=([a-f0-9]+)/) || contentText.match(/\/pair\s+([a-f0-9]+)/);
      if (tokenMatch && tokenMatch[1]) {
        const pairToken = tokenMatch[1];
        const confirmed = configRouter.confirmPairing(pairToken, {
          openId: senderOpenId,
          userName: eventData.sender?.sender_id?.user_id || 'Feishu User',
        });
        if (confirmed) {
          logger.info?.(`[dsh-feishu-channel] Confirmed pairing via chat message for token ${pairToken}`);
          await transport.sendMessage({
            receiveId: senderOpenId,
            msgType: 'text',
            content: JSON.stringify({ text: '🎉 成功与 DSH 实例完成配对！您已被绑定为管理员。' }),
          });
          return;
        }
      }
    }

    const check = admission.check(eventData);
    if (!check.allowed) {
      logger.warn?.(`[dsh-feishu-channel] Inbound message dropped: ${check.reason} (sender: ${senderOpenId}, chatType: ${message.chat_type || 'p2p'})`);
      return;
    }

    logger.info?.(`[dsh-feishu-channel] Inbound message accepted from ${senderOpenId}: "${contentText.slice(0, 80)}"`);

    // Audit log inbound message to dedicated feishu workspace directory
    storageManager.logMessage({
      direction: 'inbound',
      eventId: eventData.message?.message_id || eventData.event_id,
      senderId: senderOpenId,
      chatId: message.chat_id,
      text: contentText,
      type: message.message_type,
    });

    // Check if user is replying to a pending waterfall question
    if (message.message_type === 'text') {
      if (questionHandler.hasPending()) {
        const answered = questionHandler.handleDirectReply(contentText);
        if (answered) {
          logger.info?.('[dsh-feishu-channel] Chat text consumed as answer to pending question');
          return;
        }
      }

      // Submit new prompt to DSH session
      // 会话按 chatId 区分：私聊 = 与该用户的会话，群聊 = 群里那条会话。
      // 用 openId 当 key 会把同一用户在群里的消息串到私聊会话上。
      const conversationKey = message.chat_id || senderOpenId;
      // 直接解析出确定的会话 ID（绑定 → 已有会话 → 新建），
      // 让日志和卡片都能看到「这条消息进了哪个会话」。
      const targetSessionId = await sessionBridge.resolveSessionId(conversationKey);

      // Start CardKit streaming controller
      const streamCtrl = new CardKitController({
        transport,
        receiveId: senderOpenId,
        logger,
        // 引用回复用户那条消息（飞书会显示成引用样式）。
        replyToMessageId: message.message_id,
      });
      // 卡片 footer 要显示当前模型，这里先记上（token 用量出来后再补）。
      streamCtrl.setMetrics({ model: currentModelName(ctx) });

      const tracker = new ToolUseTracker();

      // 每一步都双写到 stdout：Cordis logger 未必挂了 exporter，
      // 出问题时 journalctl 必须能看到「卡在哪一步」。
      const trace = (step, extra) =>
        console.log(`[dsh-feishu] 投递链路 ${step}${extra ? ` ${extra}` : ''}`);

      trace('1/4 开始创建流式卡片', `receiveId=${senderOpenId}`);
      let cardReady = false;
      try {
        await streamCtrl.start({
          title: 'DeepSeek Harness 正在思考',
        });
        cardReady = true;
        trace('2/4 流式卡片已发出', `messageId=${streamCtrl.messageId || '(none)'}`);
      } catch (err) {
        trace('2/4 流式卡片发送失败', `err=${err?.message ?? err}`);
        logger.error?.('[dsh-feishu-channel] Failed to start stream card:', err);
      }

      // 卡片挂掉时用一条纯文本兜底：用户必须立刻知道「收到了，正在处理」，
      // 否则表现为「发了消息完全没反应」。
      if (!cardReady) {
        try {
          await transport.sendMessage({
            receiveId: senderOpenId,
            msgType: 'text',
            content: JSON.stringify({
              text: '📥 已收到你的消息，正在处理…（流式卡片不可用，稍后直接回复纯文本）',
            }),
          });
          trace('2b 已用纯文本兜底告知用户');
        } catch (err) {
          trace('2b 纯文本兜底也失败', `err=${err?.message ?? err}`);
        }
      }

      activeStreams.set(targetSessionId, {
        streamCtrl: cardReady ? streamCtrl : null,
        tracker,
        senderOpenId,
        promptText: contentText,
        fallbackText: true,
        toolCallNames: new Map(),
        usageTokens: 0,
      });

      trace('3/4 提交给 DSH 会话', `sessionId=${targetSessionId || '(auto)'}`);
      const promptRes = await sessionBridge.prompt({
        sessionId: targetSessionId,
        chatId: message.chat_id,
        text: contentText,
        mode: 'queue',
      });
      trace('4/4 提交结果', promptRes.success ? `OK session=${promptRes.sessionId}` : `FAIL ${promptRes.error}`);

      if (!promptRes.success) {
        logger.error?.(`[dsh-feishu-channel] Prompt submission failed: ${promptRes.error}`);
        const failureText = `⚠️ 消息提交失败: ${promptRes.error}`;
        try {
          if (cardReady) {
            await streamCtrl.pushChunk(failureText);
            await streamCtrl.finish();
          } else {
            await transport.sendMessage({
              receiveId: senderOpenId,
              msgType: 'text',
              content: JSON.stringify({ text: failureText }),
            });
          }
        } catch {}
        activeStreams.delete(targetSessionId);
        return;
      }

      // 以真实 Agent 身份重新对齐出站流的 key（agent.id 即 DSH sessionId）
      if (promptRes.sessionId && promptRes.sessionId !== targetSessionId) {
        const entry = activeStreams.get(targetSessionId);
        if (entry) {
          activeStreams.delete(targetSessionId);
          activeStreams.set(promptRes.sessionId, entry);
        }
      }
    } else if (message.message_type === 'image') {
      // Multimodal image inbound
      let imageKey = '';
      try {
        const parsed = JSON.parse(message.content);
        imageKey = parsed.image_key;
      } catch {}

      if (imageKey) {
        // 图片消息按 chat 归属（和文字消息同一个会话），不是按发送人。
        const imageConversationKey = message.chat_id || senderOpenId;
        const targetSessionId = await sessionBridge.resolveSessionId(imageConversationKey);
        try {
          // Download to dedicated storage attachments directory
          const localPath = await downloadLarkImage({
            transport,
            messageId: message.message_id,
            imageKey,
            saveDir: storageManager.getAttachmentsDir(),
          });

          logger.info?.(`[dsh-feishu-channel] Saved Feishu inbound image to dedicated directory: ${localPath}`);

          const promptRes = await sessionBridge.prompt({
            sessionId: targetSessionId,
            text: `[用户发送了图片: @${localPath}]`,
            mode: 'queue',
            attachments: [{ path: localPath, type: 'image' }],
          });

          if (promptRes.success && promptRes.sessionId && promptRes.sessionId !== targetSessionId) {
            sessionBridge.bindSession(imageConversationKey, promptRes.sessionId);
          } else if (!promptRes.success) {
            logger.error?.(`[dsh-feishu-channel] Image prompt submission failed: ${promptRes.error}`);
            await transport.sendMessage({
              receiveId: senderOpenId,
              msgType: 'text',
              content: JSON.stringify({ text: `⚠️ 图片消息提交失败: ${promptRes.error}` }),
            }).catch?.(() => {});
          }
        } catch (err) {
          logger.error?.('[dsh-feishu-channel] Error processing image inbound:', err);
        }
      }
    }
  }

  // 7. Handle Feishu Card Action (Buttons, Stop, Approval)
  async function handleCardAction(actionData) {
    const action = actionData.action?.value?.action;
    if (action === 'abort_turn') {
      const senderOpenId = actionData.open_id;
      const targetSessionId = sessionBridge.getSessionId(senderOpenId);
      await sessionBridge.stopTurn(targetSessionId);

      const active = activeStreams.get(targetSessionId);
      if (active?.streamCtrl) {
        await active.streamCtrl.abort('用户手动中断');
        activeStreams.delete(targetSessionId);
      }
      return { toast: { type: 'info', content: '已中断执行' } };
    }

    if (action === 'waterfall_approval') {
      approvalHandler.handleCardAction(actionData.action);
      return { toast: { type: 'success', content: '审批结果已提交' } };
    }

    if (action === 'waterfall_question_answer') {
      questionHandler.handleCardAction(actionData.action);
      return { toast: { type: 'success', content: '选项已提交' } };
    }

    // Menu fallback
    const menuRes = await menuHandler.handleAction(actionData.action);
    return { toast: { type: 'info', content: '操作完成' }, data: menuRes };
  }

  if (currentConfig.appId && currentConfig.appSecret) {
    console.log(
      `[dsh-feishu-channel] 启动飞书长连接（App ID ${String(currentConfig.appId).slice(0, 8)}…）`,
    );
    wsGateway
      .start({
        appId: currentConfig.appId,
        appSecret: currentConfig.appSecret,
      })
      .then((res) => {
        if (res?.started) {
          // 注意：start 只代表「已发起建连」，真实连接状态由 onReady 回调确认。
          console.log('[dsh-feishu-channel] 长连接已发起，等待 onReady 回调确认');
        } else {
          console.error(`[dsh-feishu-channel] 长连接未启动: ${res?.reason}`);
        }
      })
      .catch((err) => {
        console.error('[dsh-feishu-channel] 启动长连接异常:', err);
      });
  } else {
    console.warn(
      '[dsh-feishu-channel] 未配置 appId / appSecret，长连接未启动。请在 DSH 设置页「飞书通道」中填写。',
    );
  }

  // 8. Subscribe to real DSH agent events（dsh-agent/lib/types/runtime-types.d.ts 事实面）：
  //    - agent/assistant-stream: payload { agent, frame }，frame.type = start|chunk|end，
  //      chunk.chunk 为 StreamChunk（text-delta / reasoning-delta / tool-call-delta / finish）
  //    - agent/turn-stopping: 轮次即将关闭（finish 卡片）
  //    此前监听的 session/chunk、session/turn-end 在 DSH 中不存在，出站链路从未触发。
  if (ctx.on) {
    const offAssistantStream = ctx.on('agent/assistant-stream', async ({ agent, frame }) => {
      const active = activeStreams.get(agent.id);
      if (!active || frame?.type !== 'chunk') return;
      const chunk = frame.chunk;

      if (chunk?.type === 'reasoning-delta') {
        active.tracker.pushReasoning(chunk.text);
        // 思考过程实时同步给卡片，收尾时才能整卡渲染出「思考了 Ns」折叠面板。
        if (active.streamCtrl) active.streamCtrl.setReasoning(active.tracker.thinkingText);
        return;
      }

      if (chunk?.type === 'tool-call-delta') {
        // 模型一开始吐工具名就把上一轮思考收掉，并登记新工具。
        if (active.tracker.isThinking) active.tracker.finishReasoning();
        if (chunk.name) {
          active.toolCallNames.set(chunk.id, chunk.name);
          if (!active.tracker.activeTools.some((t) => t.callId === chunk.id)) {
            active.tracker.onToolStart({ callId: chunk.id, name: chunk.name, args: {} });
          }
        }
        return;
      }

      if (chunk?.type === 'block-end') {
        const block = chunk.block;
        if (block?.type === 'tool-call') {
          // 参数这时才完整，用它刷新工具摘要（比如具体读了哪个文件）。
          const existing = active.tracker.activeTools.find((t) => t.callId === block.id);
          if (existing) {
            let args = {};
            try {
              args = JSON.parse(block.arguments || '{}');
            } catch {}
            const summary = pickToolSummary(args);
            if (summary) existing.summary = summary.slice(0, 60);
          }
        }
        return;
      }

      if (chunk?.type === 'usage') {
        // 之前 token 用量和缓存命中率都没有来源，footer 只能显示耗时。
        if (active.streamCtrl && chunk.usage) {
          const u = chunk.usage;
          const total = u.totalTokens ?? (u.inputTokens || 0) + (u.outputTokens || 0);
          // §工具链口径：命中率 = 缓存读 / 整体输入（含缓存部分）。
          const promptSide = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
          const cached = u.cacheReadTokens || 0;
          active.usageTokens = total;
          active.streamCtrl.setMetrics({
            totalTokens: total,
            cacheHitRate: promptSide > 0 ? cached / promptSide : undefined,
          });
        }
        return;
      }

      if (chunk?.type === 'text-delta') {
        if (active.tracker.isThinking) {
          active.tracker.finishReasoning();
        }
        // 模型恢复输出正文 = 之前那批工具已经跑完。
        for (const t of active.tracker.activeTools.splice(0)) {
          active.tracker.completedTools.push({ ...t, durationMs: Date.now() - t.startTime, success: true });
        }
        // 卡片不可用时先攒文本，轮次结束一次性以纯文本发回。
        if (!active.streamCtrl) {
          active.plainBuffer = (active.plainBuffer || '') + (chunk.text || '');
          return;
        }
        try {
          await active.streamCtrl.pushChunk(chunk.text);
        } catch (err) {
          logger.error?.('[dsh-feishu-channel] Failed to push stream chunk to Feishu card:', err);
        }
      }
    });

    /** 把工具追踪器状态映射成卡片面板需要的数据结构。 */
    const toToolSteps = (tracker) => [
      ...tracker.completedTools.map((t) => ({
        name: t.name,
        status: t.success ? 'success' : 'error',
        detail: [t.summary, t.durationMs != null ? `${t.durationMs}ms` : ''].filter(Boolean).join(' · '),
      })),
      ...tracker.activeTools.map((t) => ({
        name: t.name,
        status: 'running',
        detail: t.summary || '',
      })),
    ];

    const offTurnStopping = ctx.on('agent/turn-stopping', async ({ agent }) => {
      const active = activeStreams.get(agent.id);
      if (active) {
        if (active.streamCtrl) {
          try {
            // 收尾前把思考与工具步骤灌进控制器，finish 时整卡渲染。
            active.streamCtrl.setToolSteps(toToolSteps(active.tracker));
            active.streamCtrl.setReasoning(active.tracker.thinkingText);
            await active.streamCtrl.finish();
          } catch (err) {
            logger.error?.('[dsh-feishu-channel] Failed to finish stream card:', err);
          }
        } else if (active.plainBuffer && active.senderOpenId) {
          // 没有卡片就把完整回复以纯文本发出去——绝不能静默结束。
          try {
            const chunks = String(active.plainBuffer).match(/[\s\S]{1,1800}/g) || [];
            for (const piece of chunks) {
              await transport.sendMessage({
                receiveId: active.senderOpenId,
                msgType: 'text',
                content: JSON.stringify({ text: piece }),
              });
            }
            console.log(`[dsh-feishu] 已用纯文本回传回复（${String(active.plainBuffer).length} 字，${chunks.length} 条）`);
          } catch (err) {
            logger.error?.('[dsh-feishu-channel] Failed to send plain fallback reply:', err);
          }
        }
        storageManager.logMessage({
          direction: 'outbound',
          eventId: `turn_end_${Date.now()}`,
          senderId: active.senderOpenId,
          text: `[DSH 会话回复完成: turn finished for ${agent.id}]`,
          metadata: { sessionId: agent.id },
        });
        activeStreams.delete(agent.id);
      }
    });

    const offAgentError = ctx.on('agent/error', async ({ agent, error }) => {
      const active = activeStreams.get(agent.id);
      if (active) {
        const msg = `⚠️ 执行出错: ${error?.message || String(error)}`;
        if (active.streamCtrl) {
          try {
            await active.streamCtrl.pushChunk(`\n\n${msg}`);
            // 出错也要收尾：把 header 变红、footer 标红，否则卡片永远转圈。
            await active.streamCtrl.finish({ isError: true });
          } catch {}
        } else if (active.senderOpenId) {
          try {
            await transport.sendMessage({
              receiveId: active.senderOpenId,
              msgType: 'text',
              content: JSON.stringify({ text: msg }),
            });
          } catch {}
        }
      }
    });

    // 工具授权：宿主 waterfall 模式，回调返回宿主认的 outcome
    const offApproval = ctx.on('approval/request', (request, next) =>
      approvalHandler.onRequest(request, next),
    );

    // 反问：宿主 waterfall 模式，回调返回 { answers: [{id, selected, custom?}] }
    const offQuestions = ctx.on('user-questions/request', (request, next) =>
      questionHandler.onRequest(request, next),
    );

    // 统一退订：Cordis 的 ctx.on 返回 disposer，插件卸载时必须调用，否则监听泄漏。
    const offAll = () => {
      for (const off of [
        offAssistantStream,
        offTurnStopping,
        offAgentError,
        offApproval,
        offQuestions,
      ]) {
        try {
          off?.();
        } catch {}
      }
    };
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => offAll, 'dsh-feishu-channel: agent 事件退订');
    } else {
      // 测试 / 精简宿主：没有 effect 时挂到 dispose 上
      ctx.on?.('dispose', offAll);
    }
  }

  ctx.on('dispose', async () => {
    await wsGateway.stop();
    if (globalThis.__DSH_FEISHU_GATEWAY__ === wsGateway) {
      globalThis.__DSH_FEISHU_GATEWAY__ = null;
    }
    for (const [, active] of activeStreams) {
      active.streamCtrl.abort('插件关闭');
    }
    activeStreams.clear();
  });

  // 9. Return standard Cordis disposer function (never return a bare non-function object to safeCollect)
  const disposer = async () => {
    logger.info?.('[dsh-feishu-channel] Disposing Feishu channel plugin...');
    try {
      await wsGateway.stop();
    } catch (err) {
      logger.error?.('[dsh-feishu-channel] Error stopping ws gateway on dispose:', err);
    }
    for (const [, active] of activeStreams) {
      try {
        await active.streamCtrl.abort('插件关闭');
      } catch {}
    }
    activeStreams.clear();
  };

  // Attach internal handles to disposer function for testability and runtime inspection
  disposer.transport = transport;
  disposer.sessionBridge = sessionBridge;
  disposer.questionHandler = questionHandler;
  disposer.wsGateway = wsGateway;
  disposer.configRouter = configRouter;

  return disposer;
}

apply.Config = Config;
apply.inject = inject;

export default {
  name,
  Config,
  inject,
  apply,
};
