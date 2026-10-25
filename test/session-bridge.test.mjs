import test from 'node:test';
import assert from 'node:assert/strict';

test('Task 5: SessionBridge 按宿主 sessionController 契约投递 prompt 并可中止轮次', async () => {
  const { SessionBridge } = await import('../lib/host/session-bridge.js');

  let promptRequest = null;
  let cancelRequest = null;

  // 真实 DSH 契约（dsh-api-session-controller/lib/types/index.d.ts:171 / :189）：
  //   prompt(request, signal) -> { accepted: true }
  //   cancel({ sessionId })
  const mockSessionController = {
    prompt: async (request, _signal) => {
      promptRequest = request;
      return { accepted: true };
    },
    cancel: async (request) => {
      cancelRequest = request;
      return { cancelled: true };
    },
  };

  const mockCtx = {
    get: (name) => (name === 'sessionController' ? mockSessionController : undefined),
  };

  const bridge = new SessionBridge({
    ctx: mockCtx,
    defaultSessionId: 'sess_default_123',
  });

  // 1. 投递 prompt
  const res = await bridge.prompt({
    text: '帮我检查下代码',
    mode: 'queue',
  });
  assert.equal(res.success, true);
  assert.equal(res.sessionId, 'sess_default_123');
  assert.equal(promptRequest.sessionId, 'sess_default_123');
  assert.equal(promptRequest.mode, 'queue');
  assert.equal(promptRequest.content[0].type, 'text');
  assert.equal(promptRequest.content[0].text, '帮我检查下代码');
  assert.ok(promptRequest.requestId, 'requestId 必须由客户端生成');

  // 2. 中止当前轮次
  const stopRes = await bridge.stopTurn();
  assert.equal(stopRes.success, true);
  assert.equal(cancelRequest.sessionId, 'sess_default_123');
});

test('Task 5: SessionBridge 在缺少 sessionController 时给出明确错误而不是静默失败', async () => {
  const { SessionBridge } = await import('../lib/host/session-bridge.js');

  const bridge = new SessionBridge({
    ctx: { get: () => undefined },
    defaultSessionId: 'sess_x',
  });

  const res = await bridge.prompt({ text: '你好' });
  assert.equal(res.success, false);
  assert.match(res.error, /sessionController/);
});

test('Task 5: MenuHandler routes custom menu actions to DSH commands', async () => {
  const { MenuHandler } = await import('../lib/interaction/menu-handler.js');

  const handler = new MenuHandler({
    onNewSession: async () => ({ newSessionId: 'sess_new_999' }),
    onSwitchModel: async (model) => ({ currentModel: model }),
    onGetHelp: () => '欢迎使用 DSH 飞书通道',
  });

  // Action: new session
  const resNew = await handler.handleAction({ action: 'menu_new_session' });
  assert.equal(resNew.newSessionId, 'sess_new_999');

  // Action: switch model
  const resModel = await handler.handleAction({ action: 'menu_switch_model', model: 'deepseek-chat' });
  assert.equal(resModel.currentModel, 'deepseek-chat');

  // Action: help
  const resHelp = await handler.handleAction({ action: 'menu_help' });
  assert.match(resHelp, /DSH/);
});

test('Task 5: 会话 ID 携带工作区指纹，换工作区不会撞 ApiSessionCwdConflict', async () => {
  const { SessionBridge } = await import('../lib/host/session-bridge.js');

  const created = [];
  const mockSessionController = {
    create: async (request) => {
      created.push(request);
      return { sessionId: request.sessionId };
    },
  };
  const mockCtx = {
    get: (name) => (name === 'sessionController' ? mockSessionController : undefined),
  };

  const a = new SessionBridge({ ctx: mockCtx, workspacePath: '/dsh-workspace/feishu' });
  const b = new SessionBridge({ ctx: mockCtx, workspacePath: '/dsh-workspace/feishu-storage' });

  const idA = await a.resolveSessionId('oc_abc123');
  const idB = await b.resolveSessionId('oc_abc123');

  assert.notEqual(idA, idB, '不同工作区必须派生出不同会话 ID');
  assert.match(idA, /^feishu-[a-z0-9]+-oc_abc123$/, `意外格式: ${idA}`);

  // 同一实例重复解析必须命中绑定，不再 create。
  const again = await a.resolveSessionId('oc_abc123');
  assert.equal(again, idA);
  assert.equal(created.filter((r) => r.sessionId === idA).length, 1, '绑定后不应重复 create');
});

test('Task 5: 遇到 "belongs to" 冲突时换带指纹的 ID 重试，而不是直接失败', async () => {
  const { SessionBridge } = await import('../lib/host/session-bridge.js');

  const attempts = [];
  const mockSessionController = {
    create: async (request) => {
      attempts.push(request.sessionId);
      if (attempts.length === 1) {
        throw new Error(
          `session "${request.sessionId}" belongs to "/dsh-workspace/feishu-storage", not "/dsh-workspace/feishu"`,
        );
      }
      return { sessionId: request.sessionId };
    },
  };
  const mockCtx = {
    get: (name) => (name === 'sessionController' ? mockSessionController : undefined),
  };

  const bridge = new SessionBridge({ ctx: mockCtx, workspacePath: '/dsh-workspace/feishu' });
  const id = await bridge.resolveSessionId('oc_xyz');

  assert.equal(attempts.length, 2, '应当重试一次');
  assert.notEqual(attempts[0], attempts[1], '重试必须换 ID');
  assert.equal(id, attempts[1]);
});

test('Task 5: create 彻底失败时复用同工作区已有会话兜底', async () => {
  const { SessionBridge } = await import('../lib/host/session-bridge.js');

  const mockSessionController = {
    create: async () => {
      throw new Error('boom');
    },
    list: async () => ({
      items: [
        { sessionId: 'sess_other_cwd', updatedAt: 999999, cwd: '/elsewhere' },
        { sessionId: 'sess_feishu_old', updatedAt: 123, cwd: '/dsh-workspace/feishu' },
      ],
    }),
  };
  const mockCtx = {
    get: (name) => (name === 'sessionController' ? mockSessionController : undefined),
  };

  const bridge = new SessionBridge({ ctx: mockCtx, workspacePath: '/dsh-workspace/feishu' });
  const id = await bridge.resolveSessionId('oc_fallback');

  assert.equal(id, 'sess_feishu_old', '必须复用本工作区会话，不能借用别处的会话');
});
