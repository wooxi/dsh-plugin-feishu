import test from 'node:test';
import assert from 'node:assert/strict';

test('Task 3: card-builder produces valid Feishu 2.0 Card JSON', async () => {
  const { buildStreamingCard, STREAMING_ELEMENT_ID } = await import('../lib/streaming/card-builder.js');
  const card = buildStreamingCard();

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.streaming_mode, true, 'Must enable streaming_mode');
  // 官方卡片不带 header：状态由 footer 表达，避免每条回复都顶个标题。
  assert.equal(card.header, undefined, 'Streaming card must not carry a header');
  assert.ok(Array.isArray(card.body?.elements), 'Body elements must be an array');

  const streamElem = card.body.elements.find((e) => e.element_id === STREAMING_ELEMENT_ID);
  assert.ok(streamElem, 'Stream content element must exist');
  assert.equal(streamElem.tag, 'markdown');
  assert.equal(streamElem.text_size, 'normal_v2', 'Body needs explicit text_size');
});

test('Task 3: complete card carries footer/panels and downgrades headings', async () => {
  const { buildCompleteCard } = await import('../lib/streaming/card-builder.js');
  const card = buildCompleteCard({
    text: '# 大标题\n\n正文 **加粗**',
    reasoningText: '想过一下',
    toolSteps: [{ name: 'read', status: 'success', detail: 'a.js · 3ms' }],
    elapsedMs: 5200,
    model: 'test-model',
  });

  assert.equal(card.header, undefined, 'Completed card must not carry a header');
  assert.equal(card.config.streaming_mode, undefined, 'Completed card must not stream');

  const tags = card.body.elements.map((e) => e.tag);
  assert.equal(tags.filter((t) => t === 'collapsible_panel').length, 2, 'Need tool + reasoning panels');
  assert.ok(tags.includes('hr'), 'Footer must be separated by hr');

  const footer = card.body.elements.at(-1);
  assert.match(footer.content, /test-model/, 'Footer should mention the model');

  const bodyText = card.body.elements
    .filter((e) => e.tag === 'markdown' && e.text_size === 'normal_v2')
    .map((e) => e.content)
    .join('');
  assert.match(bodyText, /^#### 大标题/, 'H1 must be downgraded to H4 for CardKit');
});

test('Task 3: error card paints the footer red', async () => {
  const { buildCompleteCard } = await import('../lib/streaming/card-builder.js');
  const card = buildCompleteCard({ text: 'boom', isError: true });
  assert.match(card.body.elements.at(-1).content, /<font color='red'>/);
});

test('Task 3: flush-controller debounces high-frequency stream updates', async () => {
  const { FlushController } = await import('../lib/streaming/flush-controller.js');
  const flushedChunks = [];

  const flusher = new FlushController({
    intervalMs: 50,
    onFlush: async (chunk) => {
      flushedChunks.push(chunk);
    },
  });

  // Push 5 fast chunks
  flusher.push('chunk 1, ');
  flusher.push('chunk 2, ');
  flusher.push('chunk 3');

  // Immediately, flusher should buffer without invoking onFlush
  assert.equal(flushedChunks.length, 0);

  // Wait for flush interval
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(flushedChunks.length, 1);
  assert.equal(flushedChunks[0], 'chunk 1, chunk 2, chunk 3');

  // Push final chunk and force immediate flush
  flusher.push(' - final');
  await flusher.flush();
  assert.equal(flushedChunks.length, 2);
  assert.equal(flushedChunks[1], ' - final');
});

test('Task 3: cardkit-controller orchestrates streaming lifecycle with sequence increments', async () => {
  const { CardKitController } = await import('../lib/streaming/cardkit-controller.js');

  const streamCalls = [];
  const mockTransport = {
    createCardEntity: async ({ card }) => ({ card_id: 'card_entity_999' }),
    sendMessage: async (msg) => ({ message_id: 'om_card_msg_111' }),
    streamCardContent: async (params) => {
      streamCalls.push({ ...params });
      return { code: 0 };
    },
  };

  const controller = new CardKitController({
    transport: mockTransport,
    receiveId: 'ou_target_user',
    throttleMs: 10,
  });

  await controller.start({ title: '执行任务' });
  assert.equal(controller.state, 'streaming');
  assert.equal(controller.cardId, 'card_entity_999');

  // Push chunks
  await controller.pushChunk('第一段内容');
  await new Promise((r) => setTimeout(r, 30));
  await controller.pushChunk('第二段内容');
  await new Promise((r) => setTimeout(r, 30));

  await controller.finish();
  assert.equal(controller.state, 'completed');

  assert.ok(streamCalls.length >= 1, 'Should have made streamCardContent calls');
  const lastCall = streamCalls[streamCalls.length - 1];
  assert.equal(lastCall.finished, true, 'Last call should mark finished: true');
  assert.ok(lastCall.sequence >= 1, 'Sequence should increment');
});
