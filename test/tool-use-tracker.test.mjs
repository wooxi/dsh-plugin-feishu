import test from 'node:test';
import assert from 'node:assert/strict';

test('Task 4: ToolUseTracker tracks reasoning duration and summary', async () => {
  const { ToolUseTracker } = await import('../lib/streaming/tool-use-tracker.js');
  const tracker = new ToolUseTracker();

  assert.equal(tracker.isThinking, false);

  // Push thinking chunks
  tracker.pushReasoning('First thought...');
  assert.equal(tracker.isThinking, true);
  assert.equal(tracker.thinkingText, 'First thought...');

  tracker.pushReasoning(' Second thought.');
  assert.equal(tracker.thinkingText, 'First thought... Second thought.');

  // Finish thinking
  tracker.finishReasoning();
  assert.equal(tracker.isThinking, false);
  const summary = tracker.getThinkingTitle();
  assert.match(summary, /已完成思考/);
});

test('Task 4: ToolUseTracker tracks tool calls, durations and badges', async () => {
  const { ToolUseTracker } = await import('../lib/streaming/tool-use-tracker.js');
  const tracker = new ToolUseTracker();

  // Start tool
  tracker.onToolStart({
    callId: 'call_1',
    name: 'bash',
    args: { command: 'git status' },
  });

  assert.equal(tracker.activeTools.length, 1);
  const activeBadge = tracker.getActiveBadgeMarkdown();
  assert.match(activeBadge, /⚡ 正在调用工具/);
  assert.match(activeBadge, /bash/);
  assert.match(activeBadge, /git status/);

  // Finish tool
  tracker.onToolEnd({
    callId: 'call_1',
    name: 'bash',
    success: true,
  });

  assert.equal(tracker.activeTools.length, 0);
  assert.equal(tracker.completedTools.length, 1);
  assert.equal(tracker.getActiveBadgeMarkdown(), '');

  const summary = tracker.getCompletedSummaryMarkdown();
  assert.match(summary, /✅ `bash`/);
});
