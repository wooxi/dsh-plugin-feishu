import test from 'node:test';
import assert from 'node:assert/strict';

test('Task 2: admission control - filters loopback and checks owner/group rules', async () => {
  const { AdmissionController } = await import('../lib/host/admission.js');
  const admission = new AdmissionController({
    ownerId: 'ou_owner_123',
    botOpenId: 'ou_bot_999',
    enableGroupChat: false,
  });

  // 1. Loopback check: ignore bot's own messages
  assert.equal(
    admission.check({
      sender: { sender_id: { open_id: 'ou_bot_999' } },
      message: { message_id: 'msg_001', chat_type: 'p2p' },
    }).allowed,
    false,
    'Bot self messages must be rejected'
  );

  // 2. Stranger check: non-owner p2p message rejected
  assert.equal(
    admission.check({
      sender: { sender_id: { open_id: 'ou_stranger_456' } },
      message: { message_id: 'msg_002', chat_type: 'p2p' },
    }).allowed,
    false,
    'Stranger p2p message should be rejected when ownerId is set'
  );

  // 3. Owner p2p message accepted
  assert.equal(
    admission.check({
      sender: { sender_id: { open_id: 'ou_owner_123' } },
      message: { message_id: 'msg_003', chat_type: 'p2p', create_time: `${Date.now()}` },
    }).allowed,
    true,
    'Owner p2p message should be accepted'
  );

  // 4. Duplicate message check
  assert.equal(
    admission.check({
      sender: { sender_id: { open_id: 'ou_owner_123' } },
      message: { message_id: 'msg_003', chat_type: 'p2p', create_time: `${Date.now()}` },
    }).allowed,
    false,
    'Duplicate message_id must be rejected'
  );

  // 5. Group chat rejection when enableGroupChat is false
  assert.equal(
    admission.check({
      sender: { sender_id: { open_id: 'ou_owner_123' } },
      message: { message_id: 'msg_004', chat_type: 'group', mentions: [{ id: { open_id: 'ou_bot_999' } }] },
    }).allowed,
    false,
    'Group message should be rejected when enableGroupChat is false'
  );
});

test('Task 2: LarkTransport client factory creates usable client interface', async () => {
  const { createLarkTransport } = await import('../lib/transport/lark-client.js');
  const transport = createLarkTransport({
    appId: 'cli_mock_app',
    appSecret: 'mock_secret',
  });

  assert.ok(transport, 'Transport instance should be created');
  assert.equal(typeof transport.sendMessage, 'function');
  assert.equal(typeof transport.streamCardContent, 'function');
  assert.equal(typeof transport.patchCard, 'function');
});

test('Task 2: WS Gateway handles event dispatching and deduplication', async () => {
  const { WsGateway } = await import('../lib/transport/ws-gateway.js');
  let dispatched = null;

  const gateway = new WsGateway({
    onEvent: async (event) => {
      dispatched = event;
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  // Emulate dispatching an inbound message event
  await gateway.handleRawEvent({
    header: { event_id: 'evt_123', event_type: 'im.message.receive_v1' },
    event: { message: { message_id: 'om_123', content: '{"text":"hello"}' } },
  });

  assert.ok(dispatched, 'Event should be dispatched');
  assert.equal(dispatched.event.message.message_id, 'om_123');

  // Duplicate event_id should be ignored
  dispatched = null;
  await gateway.handleRawEvent({
    header: { event_id: 'evt_123', event_type: 'im.message.receive_v1' },
    event: { message: { message_id: 'om_123' } },
  });
  assert.equal(dispatched, null, 'Duplicate event_id must be deduplicated');
});
