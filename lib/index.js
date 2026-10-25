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

export const inject = [
  'credentials',
  'webServer',
  'sessionController',
  'workspaceController',
  'agentDefaultModel',
];

function currentModelName(ctx) {
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.();
    if (!selection) return '';
    const { provider, model } = selection;
    return String(model || provider || '');
  } catch {
    return '';
  }
}

export function apply(ctx, config = {}) {
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

  const FEISHU_STORAGE = currentConfig.workspaceDir || '/dsh-workspace/feishu';
  const storageManager = new FeishuStorageManager({
    workspaceDir: FEISHU_STORAGE,
    logger,
  });

  const admission = new AdmissionController({
    ownerId: currentConfig.ownerId || '',
    enableGroupChat: Boolean(currentConfig.enableGroupChat),
    dmPolicy: currentConfig.dmPolicy || 'open',
  });

  let transport = createLarkTransport({
    appId: currentConfig.appId,
    appSecret: currentConfig.appSecret,
    logger,
  });

  const FEISHU_WORKSPACE = currentConfig.feishuWorkspaceDir || '/dsh-workspace/feishu';

  const sessionBridge = new SessionBridge({
    ctx,
    logger,
    defaultCwd: FEISHU_WORKSPACE,
    workspacePath: FEISHU_WORKSPACE,
        storageDir: FEISHU_STORAGE,
  });

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

  const activeStreams = new Map();

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

  const previousGateway = globalThis.__DSH_FEISHU_GATEWAY__;
  if (previousGateway && previousGateway !== undefined) {
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

  let configRouter = null;
  configRouter = new FeishuConfigRouter({
    config: currentConfig,
    transport,
    logger,
    ensureWorkspace: async (dir) => {
      if (!dir) return null;
      const normalised = String(dir).trim();
      if (sessionBridge.workspacePath !== normalised) {
        sessionBridge.workspacePath = normalised;
        sessionBridge.defaultCwd = normalised;
        sessionBridge.workspaceId = '';
      }
      const id = await sessionBridge.ensureWorkspace();
      return id ? { id, path: normalised, created: true } : null;
    },
    patchPath: (() => {
      const profileDir = process.env.DSH_PROFILE_DIR;
      if (profileDir) return `${profileDir}/cordis.patch.yml`;
      const home = process.env.DSH_HOME;
      if (home) return `${home}/profiles/${process.env.DSH_PROFILE || 'web'}/cordis.patch.yml`;
      return null;
    })(),
    onConfigUpdate: async (newConfig) => {
      logger.info?.('[dsh-feishu-channel] Config updated via Web Settings UI');
      const previousConfig = currentConfig;
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

      const credentialsChanged =
        newConfig.appId !== previousConfig.appId ||
        newConfig.appSecret !== previousConfig.appSecret;

      if (!credentialsChanged) {
        logger.info?.('[dsh-feishu-channel] 凭据未变更，保持现有长连接');
        return;
      }

      transport = createLarkTransport({
        appId: newConfig.appId,
        appSecret: newConfig.appSecret,
        logger,
      });
      configRouter.transport = transport;

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
    }
  }

  async function handleInboundMessage(eventData) {
    const message = eventData.message || {};
    const senderOpenId = eventData.sender?.sender_id?.open_id;
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
      if (check.reason === 'not_owner' && typeof transport.sendText === 'function') {
        await transport
          .sendText(message.chat_id, '\u8fd9\u4e2a\u673a\u5668\u4eba\u5df2\u7ed1\u5b9a\u4e13\u5c5e\u7ba1\u7406\u5458\uff0c\u6682\u4e0d\u63a5\u53d7\u5176\u4ed6\u4eba\u7684\u6d88\u606f\u3002')
          .catch(() => {});
      }
      return;
    }

    if (check.isFirstBinding) {
      logger.info?.(`[dsh-feishu-channel] \u9996\u6b21\u7ed1\u5b9a\u7ba1\u7406\u5458: ${senderOpenId}`);
      if (typeof transport.sendText === 'function') {
        await transport
          .sendText(
            message.chat_id,
            `\u5df2\u5c06\u4f60\u7ed1\u5b9a\u4e3a\u672c\u901a\u9053\u7684\u4e13\u5c5e\u7ba1\u7406\u5458\uff08${senderOpenId}\uff09\uff0c\u540e\u7eed\u4ec5\u4f60\u53ef\u4e0e\u6b64\u5b9e\u4f8b\u5bf9\u8bdd\u3002`,
          )
          .catch(() => {});
      }
      try {
        currentConfig = { ...currentConfig, ownerId: senderOpenId };
        if (typeof configRouter?.persistOwner === 'function') {
          await configRouter.persistOwner(senderOpenId);
        }
      } catch (err) {
        logger.warn?.(`[dsh-feishu-channel] \u6301\u4e45\u5316\u7ba1\u7406\u5458\u5931\u8d25: ${err?.message ?? err}`);
      }
    }

    logger.info?.(`[dsh-feishu-channel] Inbound message accepted from ${senderOpenId}: "${contentText.slice(0, 80)}"`);

    storageManager.logMessage({
      direction: 'inbound',
      eventId: eventData.message?.message_id || eventData.event_id,
      senderId: senderOpenId,
      chatId: message.chat_id,
      text: contentText,
      type: message.message_type,
    });

    if (message.message_type === 'text') {
      if (questionHandler.hasPending()) {
        const answered = questionHandler.handleDirectReply(contentText);
        if (answered) {
          logger.info?.('[dsh-feishu-channel] Chat text consumed as answer to pending question');
          return;
        }
      }

      const conversationKey = message.chat_id || senderOpenId;
      const targetSessionId = await sessionBridge.resolveSessionId(conversationKey);

      const streamCtrl = new CardKitController({
        transport,
        receiveId: senderOpenId,
        logger,
        replyToMessageId: message.message_id,
      });
      streamCtrl.setMetrics({ model: currentModelName(ctx) });

      const tracker = new ToolUseTracker();

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

      if (promptRes.sessionId && promptRes.sessionId !== targetSessionId) {
        const entry = activeStreams.get(targetSessionId);
        if (entry) {
          activeStreams.delete(targetSessionId);
          activeStreams.set(promptRes.sessionId, entry);
        }
      }
    } else if (message.message_type === 'image') {
      let imageKey = '';
      try {
        const parsed = JSON.parse(message.content);
        imageKey = parsed.image_key;
      } catch {}

      if (imageKey) {
        const imageConversationKey = message.chat_id || senderOpenId;
        const targetSessionId = await sessionBridge.resolveSessionId(imageConversationKey);
        try {
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

  if (ctx.on) {
    const offAssistantStream = ctx.on('agent/assistant-stream', async ({ agent, frame }) => {
      const active = activeStreams.get(agent.id);
      if (!active || frame?.type !== 'chunk') return;
      const chunk = frame.chunk;

      if (chunk?.type === 'reasoning-delta') {
        active.tracker.pushReasoning(chunk.text);
        if (active.streamCtrl) active.streamCtrl.setReasoning(active.tracker.thinkingText);
        return;
      }

      if (chunk?.type === 'tool-call-delta') {
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
        if (active.streamCtrl && chunk.usage) {
          const u = chunk.usage;
          const total = u.totalTokens ?? (u.inputTokens || 0) + (u.outputTokens || 0);
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
        for (const t of active.tracker.activeTools.splice(0)) {
          active.tracker.completedTools.push({ ...t, durationMs: Date.now() - t.startTime, success: true });
        }
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
            active.streamCtrl.setToolSteps(toToolSteps(active.tracker));
            active.streamCtrl.setReasoning(active.tracker.thinkingText);
            await active.streamCtrl.finish();
          } catch (err) {
            logger.error?.('[dsh-feishu-channel] Failed to finish stream card:', err);
          }
        } else if (active.plainBuffer && active.senderOpenId) {
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

    const offApproval = ctx.on('approval/request', (request, next) =>
      approvalHandler.onRequest(request, next),
    );

    const offQuestions = ctx.on('user-questions/request', (request, next) =>
      questionHandler.onRequest(request, next),
    );

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
