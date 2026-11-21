import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_PROFILE_DIR = mkdtempSync(join(tmpdir(), 'dsh-feishu-cmd-'));
delete process.env.DSH_HOME;

test('CommandDispatcher: isCommand 正确识别斜杠命令', async () => {
  const { CommandDispatcher } = await import('../lib/interaction/command-dispatcher.js');
  const dispatcher = new CommandDispatcher({});

  assert.equal(dispatcher.isCommand('/help'), true);
  assert.equal(dispatcher.isCommand('  /compact  '), true);
  assert.equal(dispatcher.isCommand('/new session'), true);
  assert.equal(dispatcher.isCommand('你好 /help'), false);
  assert.equal(dispatcher.isCommand(''), false);
  assert.equal(dispatcher.isCommand(null), false);
});

test('CommandDispatcher: /help 返回帮助信息并包含宿主注册命令', async () => {
  const { CommandDispatcher } = await import('../lib/interaction/command-dispatcher.js');

  const sentMessages = [];
  const mockTransport = {
    sendMessage: async (msg) => {
      sentMessages.push(msg);
      return { message_id: 'reply_1' };
    },
  };

  const mockCommands = {
    list: () => [
      { name: 'compact', description: '压缩历史上下文' },
      { name: 'goal', description: '设置当前目标' },
    ],
  };

  const mockSessionBridge = {
    resolveSessionId: async () => 'sess_1',
    resolveAgent: async () => ({ id: 'agent_1' }),
  };

  const mockCtx = {
    commands: mockCommands,
  };

  const dispatcher = new CommandDispatcher({
    ctx: mockCtx,
    sessionBridge: mockSessionBridge,
    transport: mockTransport,
    logger: { info() {}, warn() {}, error() {} },
  });

  const handled = await dispatcher.dispatch({
    rawText: '/help',
    senderOpenId: 'ou_user',
    chatId: 'chat_1',
    messageId: 'msg_1',
    conversationKey: 'chat_1',
  });

  assert.equal(handled, true);
  assert.equal(sentMessages.length, 1);
  const content = JSON.parse(sentMessages[0].content);
  assert.match(content.text, /\/new/);
  assert.match(content.text, /\/stop/);
  assert.match(content.text, /\/compact/);
  assert.match(content.text, /压缩历史上下文/);
  assert.equal(sentMessages[0].replyToMessageId, 'msg_1');
});

test('CommandDispatcher: /new 重置会话并返回新会话ID', async () => {
  const { CommandDispatcher } = await import('../lib/interaction/command-dispatcher.js');

  const sentMessages = [];
  const mockTransport = {
    sendMessage: async (msg) => {
      sentMessages.push(msg);
      return { message_id: 'reply_2' };
    },
  };

  let createdChat = '';
  const mockSessionBridge = {
    createSession: async (key) => {
      createdChat = key;
      return 'sess_brand_new_999';
    },
  };

  const dispatcher = new CommandDispatcher({
    ctx: {},
    sessionBridge: mockSessionBridge,
    transport: mockTransport,
    logger: { info() {}, warn() {}, error() {} },
  });

  const handled = await dispatcher.dispatch({
    rawText: '/new',
    senderOpenId: 'ou_user',
    chatId: 'chat_1',
    messageId: 'msg_2',
    conversationKey: 'chat_1',
  });

  assert.equal(handled, true);
  assert.equal(createdChat, 'chat_1');
  assert.equal(sentMessages.length, 1);
  const content = JSON.parse(sentMessages[0].content);
  assert.match(content.text, /sess_brand_new_999/);
});

test('CommandDispatcher: /stop 中止当前会话轮次', async () => {
  const { CommandDispatcher } = await import('../lib/interaction/command-dispatcher.js');

  const sentMessages = [];
  const mockTransport = {
    sendMessage: async (msg) => {
      sentMessages.push(msg);
      return { message_id: 'reply_3' };
    },
  };

  let stoppedSession = '';
  const mockSessionBridge = {
    resolveSessionId: async () => 'sess_active',
    stopTurn: async (sessionId) => {
      stoppedSession = sessionId;
      return { success: true };
    },
  };

  const dispatcher = new CommandDispatcher({
    ctx: {},
    sessionBridge: mockSessionBridge,
    transport: mockTransport,
    logger: { info() {}, warn() {}, error() {} },
  });

  const handled = await dispatcher.dispatch({
    rawText: '/stop',
    senderOpenId: 'ou_user',
    chatId: 'chat_1',
    messageId: 'msg_3',
    conversationKey: 'chat_1',
  });

  assert.equal(handled, true);
  assert.equal(stoppedSession, 'sess_active');
  const content = JSON.parse(sentMessages[0].content);
  assert.match(content.text, /中止/);
});

test('CommandDispatcher: DSH 原生命令直接由 commands.execute 执行', async () => {
  const { CommandDispatcher } = await import('../lib/interaction/command-dispatcher.js');

  const sentMessages = [];
  const mockTransport = {
    sendMessage: async (msg) => {
      sentMessages.push(msg);
      return { message_id: 'reply_4' };
    },
  };

  let executedCmd = null;
  const mockCommands = {
    find: (agent, name) => (name === 'compact' ? { name: 'compact' } : undefined),
    execute: async (agent, line) => {
      executedCmd = { agent, line };
      return {
        commandId: 'cmd-1',
        result: { kind: 'success', text: '历史上下文已压缩至 20%' },
      };
    },
  };

  const mockAgent = { id: 'agent_target' };
  const mockSessionBridge = {
    resolveSessionId: async () => 'sess_compact',
    resolveAgent: async (sessionId) => (sessionId === 'sess_compact' ? mockAgent : null),
  };

  const dispatcher = new CommandDispatcher({
    ctx: { commands: mockCommands },
    sessionBridge: mockSessionBridge,
    transport: mockTransport,
    logger: { info() {}, warn() {}, error() {} },
  });

  const handled = await dispatcher.dispatch({
    rawText: '/compact force',
    senderOpenId: 'ou_user',
    chatId: 'chat_1',
    messageId: 'msg_4',
    conversationKey: 'chat_1',
  });

  assert.equal(handled, true);
  assert.deepEqual(executedCmd, { agent: mockAgent, line: '/compact force' });
  assert.equal(sentMessages.length, 1);
  const content = JSON.parse(sentMessages[0].content);
  assert.match(content.text, /历史上下文已压缩至 20%/);
  assert.match(content.text, /✅/);
});

test('CommandDispatcher: 未知命令返回错误提示并不报错', async () => {
  const { CommandDispatcher } = await import('../lib/interaction/command-dispatcher.js');

  const sentMessages = [];
  const mockTransport = {
    sendMessage: async (msg) => {
      sentMessages.push(msg);
      return { message_id: 'reply_5' };
    },
  };

  const mockCommands = {
    find: () => undefined,
  };

  const mockSessionBridge = {
    resolveSessionId: async () => 'sess_1',
    resolveAgent: async () => ({ id: 'agent_1' }),
  };

  const dispatcher = new CommandDispatcher({
    ctx: { commands: mockCommands },
    sessionBridge: mockSessionBridge,
    transport: mockTransport,
    logger: { info() {}, warn() {}, error() {} },
  });

  const handled = await dispatcher.dispatch({
    rawText: '/not_exist_command',
    senderOpenId: 'ou_user',
    chatId: 'chat_1',
    messageId: 'msg_5',
    conversationKey: 'chat_1',
  });

  assert.equal(handled, true);
  assert.equal(sentMessages.length, 1);
  const content = JSON.parse(sentMessages[0].content);
  assert.match(content.text, /未知命令/);
  assert.match(content.text, /\/not_exist_command/);
});
