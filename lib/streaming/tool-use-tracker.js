/**
 * ToolUseTracker
 * Tracks agent reasoning/thinking chunks and tool call execution status for visual presentation.
 */

export class ToolUseTracker {
  constructor() {
    this.thinkingText = '';
    this.isThinking = false;
    this.thinkingStartTime = 0;
    this.thinkingDurationSec = 0;

    this.activeTools = []; // [{ callId, name, summary, startTime }]
    this.completedTools = []; // [{ callId, name, summary, durationMs, success }]
  }

  /**
   * Append reasoning/thinking chunk
   * @param {string} chunk
   */
  pushReasoning(chunk) {
    if (!chunk) return;
    if (!this.isThinking) {
      this.isThinking = true;
      this.thinkingStartTime = Date.now();
    }
    this.thinkingText += chunk;
  }

  /**
   * Mark thinking as completed
   */
  finishReasoning() {
    if (this.isThinking) {
      this.isThinking = false;
      this.thinkingDurationSec = Math.max(0.1, (Date.now() - this.thinkingStartTime) / 1000);
    }
  }

  /**
   * Get title for collapsible thinking panel
   */
  getThinkingTitle() {
    if (this.isThinking) {
      return '💭 正在思考中...';
    }
    if (this.thinkingText) {
      const dur = this.thinkingDurationSec > 0 ? `${this.thinkingDurationSec.toFixed(1)}s` : '完成';
      return `💭 已完成思考 (耗时 ${dur})`;
    }
    return '💭 思考过程';
  }

  /**
   * Record tool call start
   * @param {object} param
   */
  onToolStart({ callId, name, args = {} }) {
    let summary = '';
    if (args.command) summary = String(args.command);
    else if (args.path) summary = String(args.path);
    else if (args.query) summary = String(args.query);
    else if (args.description) summary = String(args.description);
    else summary = Object.keys(args).slice(0, 2).map((k) => `${k}=${JSON.stringify(args[k])}`).join(', ');

    if (summary.length > 50) {
      summary = summary.slice(0, 47) + '...';
    }

    this.activeTools.push({
      callId,
      name,
      summary,
      startTime: Date.now(),
    });
  }

  /**
   * Record tool call completion
   * @param {object} param
   */
  onToolEnd({ callId, name, success = true, error = null }) {
    const idx = this.activeTools.findIndex((t) => t.callId === callId || t.name === name);
    let tool = null;
    if (idx !== -1) {
      tool = this.activeTools.splice(idx, 1)[0];
    } else {
      tool = { name, summary: '', startTime: Date.now() };
    }

    const durationMs = Date.now() - tool.startTime;
    this.completedTools.push({
      ...tool,
      durationMs,
      success,
      error,
    });
  }

  /**
   * Markdown badge for currently running tool
   */
  getActiveBadgeMarkdown() {
    if (this.activeTools.length === 0) return '';
    const active = this.activeTools[0];
    return `⚡ 正在调用工具: \`${active.name}\`${active.summary ? ` (${active.summary})` : ''}`;
  }

  /**
   * Markdown summary of completed tools
   */
  getCompletedSummaryMarkdown() {
    if (this.completedTools.length === 0) return '';
    return this.completedTools
      .map((t) => `${t.success ? '✅' : '❌'} \`${t.name}\`${t.summary ? ` (${t.summary})` : ''} - ${t.durationMs}ms`)
      .join('\n');
  }
}
