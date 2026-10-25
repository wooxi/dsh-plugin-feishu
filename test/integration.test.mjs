import test from 'node:test';
import assert from 'node:assert/strict';

test('Integration: 插件全链路（入站消息 → sessionController 投递 → 流式卡片 → 中止）', async () => {
  const plugin = await import('../lib/index.js');

  /** 收到的 prompt 请求（真实契约：{ requestId, sessionId, mode, content }） */
  const promptRequests = [];
  /** 收到的 cancel 请求 */
  const cancelRequests = [];
  let waterfallResolved = null;

  const mockSessionController = {
    prompt: async (request) => {
      promptRequests.push(request);
      return { accepted: true };
    },
    cancel: async (request) => {
      cancelRequests.push(request);
      return { cancelled: true };
    },
    list: async () => ({ items: [] }),
    create: async () => ({ sessionId: 'feishu-main' }),
  };

  // 模拟真实 Cordis Context：ctx.get(name) 是安全取值口（不会因未声明 inject 抛错）
  const mockCtx = {
    logger: () => ({
      info() {},
      warn() {},
      error() {},
      debug() {},
    }),
    get: (name) => (name === 'sessionController' ? mockSessionController : undefined),
    waterfall: {
      resolve: (reqId, payload) => {
        waterfallResolved = { reqId, payload };
      },
    },
    _eventHandlers: {},
    on(event, handler) {
      if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
      this._eventHandlers[event].push(handler);
      return () => {
        this._eventHandlers[event] = (this._eventHandlers[event] || []).filter((h) => h !== handler);
      };
    },
    emit(event, data) {
      const handlers = this._eventHandlers[event] || [];
      for (const h of handlers) h(data);
    },
  };

  const instance = await plugin.apply(mockCtx, {
    appId: 'cli_integration_test',
    appSecret: 'test_secret',
    workspaceDir: '/tmp/feishu-it',
  });

  assert.ok(instance.transport, 'Transport 应初始化');
  assert.ok(instance.sessionBridge, 'SessionBridge 应初始化');
  assert.ok(instance.questionHandler, 'QuestionHandler 应初始化');

  // 用 mock 替换网络调用
  instance.transport.createCardEntity = async () => ({ card_id: 'card_int_test_1' });
  instance.transport.sendMessage = async () => ({ message_id: 'msg_int_test_1' });
  instance.transport.streamCardContent = async () => ({ code: 0 });
  instance.transport.updateCard = async () => ({ code: 0 });
  instance.transport.sendCard = async () => ({ code: 0, data: { message_id: 'om_card_it' } });

  // 1. 入站文本消息
  await instance.wsGateway.handleRawEvent({
    header: { event_id: 'evt_user_msg_1', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_tester_001' } },
      message: {
        message_id: 'om_user_msg_1',
        message_type: 'text',
        content: JSON.stringify({ text: '请列出当前项目文件' }),
        create_time: `${Date.now()}`,
      },
    },
  });

  // 应通过 sessionController.prompt 投递一次
  assert.equal(promptRequests.length, 1, '应投递恰好一条 prompt');
  assert.equal(promptRequests[0].content[0].type, 'text');
  assert.equal(promptRequests[0].content[0].text, '请列出当前项目文件');
  assert.equal(promptRequests[0].mode, 'queue');
  assert.ok(promptRequests[0].requestId);

  // 2. 模拟宿主流式事件（agent/assistant-stream：payload { agent, frame }）
  const agent = { id: promptRequests[0].sessionId };
  mockCtx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '先看目录结构…' } },
  });
  mockCtx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '文件列表：\n- README.md' } },
  });

  // 3. 轮次收尾
  mockCtx.emit('agent/turn-stopping', { agent, turn: 1 });

  // 4. 反问（宿主 waterfall 模式）：onRequest 发卡并挂起，随后用私聊文本回答
  const pendingQuestion = instance.questionHandler.onRequest(
    { questions: [{ id: 'mode', question: '请选择部署模式' }] },
    () => ({ answers: [] }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(instance.questionHandler.hasPending(), '应有在册反问');

  await instance.wsGateway.handleRawEvent({
    header: { event_id: 'evt_user_reply_2', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_tester_001' } },
      message: {
        message_id: 'om_user_reply_2',
        message_type: 'text',
        content: JSON.stringify({ text: '生产模式' }),
        create_time: `${Date.now()}`,
      },
    },
  });

  // 回复被当成问题答案，不应再投递新 prompt
  assert.equal(promptRequests.length, 1, '回答问题不应产生新 prompt');
  const questionAnswer = await pendingQuestion;
  assert.deepEqual(questionAnswer.answers, [{ id: 'mode', selected: ['生产模式'], custom: '生产模式' }]);
  assert.equal(instance.questionHandler.hasPending(), false);

  // 5. 点击卡片上的停止按钮
  await instance.wsGateway.handleRawEvent({
    header: { event_id: 'evt_card_abort_3', event_type: 'card.action.trigger' },
    event: {
      open_id: 'ou_tester_001',
      action: { value: { action: 'abort_turn' } },
    },
  });

  assert.equal(cancelRequests.length, 1, '应通过 sessionController.cancel 中止一轮');
});
