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

test('Task 5: 新建会话交给宿主生成 ID，并带上 workspaceId 以便归组', async () => {
  const { SessionBridge } = await import('../lib/host/session-bridge.js');

  const created = [];
  const mockSessionController = {
    create: async (request) => {
      created.push(request);
      return { sessionId: 'sess_generated_1' };
    },
  };
  const mockWorkspaceController = {
    create: async ({ path }) => ({ workspace: { workspaceId: 'ws-1' }, path, created: false }),
  };
  const mockCtx = {
    get: (name) => {
      if (name === 'sessionController') return mockSessionController;
      if (name === 'workspaceController') return mockWorkspaceController;
      return undefined;
    },
  };

  const bridge = new SessionBridge({ ctx: mockCtx, workspacePath: '/dsh-workspace/feishu' });
  const id = await bridge.resolveSessionId('oc_abc123');

  assert.equal(id, 'sess_generated_1', '必须采用宿主返回的会话 ID');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], { workspaceId: 'ws-1' }, 'create 只传 workspaceId，不传 sessionId');

  const again = await bridge.resolveSessionId('oc_abc123');
  assert.equal(again, 'sess_generated_1', '同一 chat 重复解析必须命中绑定');
  assert.equal(created.length, 1, '绑定后不应重复 create');
});

test('Task 5: 没有 workspaceController 时退化为 cwd 创建，不丢消息', async () => {
  const { SessionBridge } = await import('../lib/host/session-bridge.js');

  const created = [];
  const mockSessionController = {
    create: async (request) => {
      created.push(request);
      return { sessionId: 'sess_fallback' };
    },
  };
  const mockCtx = {
    get: (name) => (name === 'sessionController' ? mockSessionController : undefined),
  };

  const bridge = new SessionBridge({ ctx: mockCtx, workspacePath: "/dsh-workspace/feishu" });
  const id = await bridge.resolveSessionId('oc_no_ws');

  assert.equal(id, 'sess_fallback');
  assert.equal(created[0].cwd, '/dsh-workspace/feishu');
  assert.equal(created[0].workspaceId, undefined);
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

test('Message dedupe survives a plugin reload (shared across admission instances)', async () => {
  const { AdmissionController } = await import('../lib/host/admission.js');

  const payload = (id) => ({
    sender: { sender_id: { open_id: 'ou_owner' } },
    message: {
      message_id: id,
      chat_type: 'p2p',
      create_time: String(Date.now()),
    },
  });

  const first = new AdmissionController({ ownerId: 'ou_owner', dmPolicy: 'owner' });
  const r1 = first.check(payload('om_same_1'));
  assert.equal(r1.allowed, true);

  const second = new AdmissionController({ ownerId: 'ou_owner', dmPolicy: 'owner' });
  const r2 = second.check(payload('om_same_1'));
  assert.equal(r2.allowed, false);
  assert.equal(r2.reason, 'duplicate_message');

  delete globalThis.__DSH_FEISHU_SEEN_MESSAGES__;
});
