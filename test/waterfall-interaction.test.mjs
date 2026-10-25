import test from 'node:test';
import assert from 'node:assert/strict';

test('Task 6: ApprovalHandler 发卡并经 onRequest 回传宿主认的 outcome', async () => {
  const { ApprovalHandler, ALLOWED_ONCE, REJECTED } = await import(
    '../lib/interaction/approval-handler.js'
  );

  const sent = [];
  const mockTransport = {
    sendCard: async ({ receive_id, card }) => {
      sent.push({ receive_id, card });
      return { code: 0, data: { message_id: 'om_appr_card_1' } };
    },
  };

  const handler = new ApprovalHandler({
    transport: mockTransport,
    getReceiveId: () => 'ou_tester_001',
  });

  // 1. 卡片渲染
  const card = handler.renderCard({
    id: 'req_appr_001',
    tool: 'bash',
    args: { command: 'rm -rf /tmp/cache' },
    description: '清理临时缓存目录',
  });
  assert.equal(card.schema, '2.0');
  assert.equal(card.header?.template, 'orange');
  assert.ok(card.body?.elements?.length > 0);

  // 2. 宿主来要授权：onRequest 挂起，等用户点按钮
  const pending = handler.onRequest({ toolName: 'bash', input: { command: 'ls' } }, () => 'unavailable');

  // 等微任务让 sendCard 完成并登记
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1, '应发出一张审批卡');
  assert.equal(sent[0].receive_id, 'ou_tester_001');

  // 3. 用户点「允许」→ outcome 必须是宿主认的 allowed-once
  const requestId = [...handler.pendingApprovals.keys()][0];
  assert.ok(requestId, '应有在册审批');
  const hit = handler.handleCardAction({ value: { requestId, decision: ALLOWED_ONCE } });
  assert.equal(hit, true);

  const outcome = await pending;
  assert.equal(outcome, ALLOWED_ONCE);
  assert.equal(handler.pendingApprovals.size, 0);
});

test('Task 6: ApprovalHandler 没有飞书接收方时把审批让给网页端', async () => {
  const { ApprovalHandler } = await import('../lib/interaction/approval-handler.js');

  const handler = new ApprovalHandler({ transport: null, getReceiveId: () => '' });
  let nextCalled = false;
  const outcome = await handler.onRequest({}, () => {
    nextCalled = true;
    return 'unavailable';
  });

  assert.equal(nextCalled, true);
  assert.equal(outcome, 'unavailable');
});

test('Task 6: QuestionHandler 发卡并支持卡片按钮与私聊文本两种回答', async () => {
  const { QuestionHandler } = await import('../lib/interaction/question-handler.js');

  const sent = [];
  const mockTransport = {
    sendCard: async ({ receive_id, card }) => {
      sent.push({ receive_id, card });
      return { code: 0, data: { message_id: 'om_q_card_1' } };
    },
  };

  // 场景 A：按钮回答
  const handlerA = new QuestionHandler({
    transport: mockTransport,
    getReceiveId: () => 'ou_tester_001',
  });

  const pendingA = handlerA.onRequest(
    {
      questions: [
        {
          id: 'q1',
          question: '请问需要部署到生产环境还是测试环境？',
          options: [{ label: '测试环境' }, { label: '生产环境' }],
        },
      ],
    },
    () => ({ answers: [] }),
  );

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1, '应发出一张反问卡');
  assert.equal(handlerA.pendingQuestions.size, 1);

  const requestId = [...handlerA.pendingQuestions.keys()][0];
  const hit = handlerA.handleCardAction({ value: { requestId, questionId: 'q1', answer: '生产环境' } });
  assert.equal(hit, true);

  const answerA = await pendingA;
  assert.deepEqual(answerA.answers, [{ id: 'q1', selected: ['生产环境'] }]);
  assert.equal(handlerA.hasPending(), false);

  // 场景 B：私聊里直接打文字
  const handlerB = new QuestionHandler({
    transport: mockTransport,
    getReceiveId: () => 'ou_tester_001',
  });

  const pendingB = handlerB.onRequest(
    { questions: [{ id: 'q2', question: '请输入项目名' }] },
    () => ({ answers: [] }),
  );

  await new Promise((r) => setTimeout(r, 10));
  const handled = handlerB.handleDirectReply('my-project');
  assert.equal(handled, true);

  const answerB = await pendingB;
  assert.deepEqual(answerB.answers, [{ id: 'q2', selected: ['my-project'], custom: 'my-project' }]);
  assert.equal(handlerB.hasPending(), false);
});
