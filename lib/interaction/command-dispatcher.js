export class CommandDispatcher {
  constructor({ ctx, sessionBridge, transport, logger, getModelName }) {
    this.ctx = ctx;
    this.sessionBridge = sessionBridge;
    this.transport = transport;
    this.logger = logger || console;
    this.getModelName = getModelName || (() => '');
  }

  isCommand(text) {
    if (!text || typeof text !== 'string') return false;
    return text.trim().startsWith('/');
  }

  async replyText(chatId, messageId, text) {
    try {
      await this.transport.sendMessage({
        receiveId: chatId,
        msgType: 'text',
        content: JSON.stringify({ text }),
        replyToMessageId: messageId,
      });
    } catch (err) {
      this.logger.error?.(`[CommandDispatcher] 回复消息失败: ${err?.message ?? err}`);
    }
  }

  async dispatch({ rawText, senderOpenId, chatId, messageId, conversationKey }) {
    const line = rawText.trim();
    const match = /^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s.exec(line);
    if (!match) {
      await this.replyText(chatId, messageId, '⚠️ 命令格式不正确，命令应以斜杠开头，如 /help');
      return true;
    }

    const commandName = match[1].toLowerCase();

    this.logger.info?.(`[CommandDispatcher] 收到斜杠命令 /${commandName}，直接由宿主执行，不经过模型`);

    if (commandName === 'help') {
      await this.handleHelp(chatId, messageId, conversationKey);
      return true;
    }

    if (commandName === 'new' || commandName === 'clear' || commandName === 'reset') {
      await this.handleNewSession(chatId, messageId, conversationKey);
      return true;
    }

    if (commandName === 'stop' || commandName === 'abort') {
      await this.handleStop(chatId, messageId, conversationKey);
      return true;
    }

    if (commandName === 'status') {
      await this.handleStatus(chatId, messageId, conversationKey);
      return true;
    }

    const handled = await this.handleHostCommand(commandName, line, chatId, messageId, conversationKey);
    if (handled) return true;

    await this.replyText(
      chatId,
      messageId,
      `⚠️ 未知命令 "/${commandName}"\n发送 /help 可查看支持的命令列表。`,
    );
    return true;
  }

  async handleHelp(chatId, messageId, conversationKey) {
    const lines = [
      '🤖 **DeepSeek Harness 飞书通道命令帮助**',
      '',
      '📌 **通道管理指令（直接生效）：**',
      '- `/new` 或 `/clear`：新建/重置会话，开启全新上下文',
      '- `/stop` 或 `/abort`：中止当前正在执行的 Agent 轮次',
      '- `/status`：查看当前通道会话与工作区运行状态',
      '- `/help`：查看所有可用命令',
    ];

    try {
      const targetSessionId = await this.sessionBridge.resolveSessionId(conversationKey);
      const agent = targetSessionId ? await this.sessionBridge.resolveAgent(targetSessionId) : null;
      const commandsService = this.ctx.commands || this.ctx.get?.('commands');
      if (commandsService && agent && typeof commandsService.list === 'function') {
        const hostCommands = commandsService.list(agent);
        if (hostCommands && hostCommands.length > 0) {
          lines.push('');
          lines.push('⚙️ **DSH 系统命令（原生宿主执行）：**');
          for (const cmd of hostCommands) {
            lines.push(`- \`/${cmd.name}\`：${cmd.description || '无说明'}`);
          }
        }
      }
    } catch {}

    lines.push('');
    lines.push('💡 所有以 `/` 开头的命令均由 DSH 宿主直接执行，不会消耗模型 Token，也不会进入模型对话历史。');

    await this.replyText(chatId, messageId, lines.join('\n'));
  }

  async handleNewSession(chatId, messageId, conversationKey) {
    try {
      const newSessionId = await this.sessionBridge.createSession(conversationKey);
      if (newSessionId) {
        await this.replyText(
          chatId,
          messageId,
          `✨ 会话已重置！\n已开启全新会话（ID: \`${newSessionId}\`），后续消息将使用全新的上下文。`,
        );
      } else {
        await this.replyText(chatId, messageId, '⚠️ 重置会话失败，未能创建新会话。');
      }
    } catch (err) {
      await this.replyText(chatId, messageId, `❌ 重置会话出错：${err?.message ?? err}`);
    }
  }

  async handleStop(chatId, messageId, conversationKey) {
    try {
      const targetSessionId = await this.sessionBridge.resolveSessionId(conversationKey);
      if (!targetSessionId) {
        await this.replyText(chatId, messageId, '⚠️ 当前尚无活跃会话。');
        return;
      }
      await this.sessionBridge.stopTurn(targetSessionId, conversationKey);
      await this.replyText(chatId, messageId, '⏹ 已向 DSH 发送中止信号，当前轮次已停止。');
    } catch (err) {
      await this.replyText(chatId, messageId, `❌ 中止任务出错：${err?.message ?? err}`);
    }
  }

  async handleStatus(chatId, messageId, conversationKey) {
    const sessionId = this.sessionBridge.getSessionId(conversationKey) || '未初始化';
    const workspace = this.sessionBridge.workspacePath || this.sessionBridge.defaultCwd || '默认';
    const model = this.getModelName() || '默认模型';
    const text = [
      '📊 **DSH 飞书通道当前状态**',
      `- 当前会话 ID: \`${sessionId}\``,
      `- 工作区路径: \`${workspace}\``,
      `- 当前默认模型: \`${model}\``,
    ].join('\n');
    await this.replyText(chatId, messageId, text);
  }

  async handleHostCommand(commandName, line, chatId, messageId, conversationKey) {
    const commandsService = this.ctx.commands || this.ctx.get?.('commands');
    if (!commandsService) return false;

    let targetSessionId = '';
    try {
      targetSessionId = await this.sessionBridge.resolveSessionId(conversationKey);
    } catch (err) {
      this.logger.warn?.(`[CommandDispatcher] resolveSessionId error: ${err?.message ?? err}`);
      return false;
    }

    if (!targetSessionId) return false;

    const agent = await this.sessionBridge.resolveAgent(targetSessionId);
    if (!agent) {
      this.logger.warn?.(`[CommandDispatcher] Could not resolve agent for session ${targetSessionId}`);
      return false;
    }

    if (typeof commandsService.find === 'function') {
      const def = commandsService.find(agent, commandName);
      if (!def) return false;
    }

    try {
      this.logger.info?.(`[CommandDispatcher] 执行宿主原生命令: ${line}`);
      const execution = await commandsService.execute(agent, line, [], new AbortController().signal);
      if (!execution) return false;

      const result = execution.result;
      const isSuccess = result?.kind === 'success';
      const outputText = result?.text ? `\n\n${result.text}` : '';
      const reply = isSuccess
        ? `✅ 命令 \`/${commandName}\` 执行完成${outputText}`
        : `❌ 命令 \`/${commandName}\` 执行失败${outputText}`;

      await this.replyText(chatId, messageId, reply);
      return true;
    } catch (err) {
      this.logger.error?.(`[CommandDispatcher] 执行命令出错: ${err?.message ?? err}`);
      await this.replyText(chatId, messageId, `❌ 命令 \`/${commandName}\` 执行出错：${err?.message ?? err}`);
      return true;
    }
  }
}
