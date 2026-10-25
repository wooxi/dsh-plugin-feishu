/**
 * CardKit 流式生命周期控制器。
 *
 * 三个阶段（对齐官方 openclaw-lark / hermes-lark-streaming）：
 *
 * 1. `start()`   建卡实体 → 发 interactive 消息 → 拿到 card_id/message_id
 * 2. `pushChunk` 把增量并进累积全文，节流后调用
 *                `PUT /cards/:id/elements/:eid/content`（**设置语义**，发全文）
 * 3. `finish()`  整卡替换成完成态（header 变绿、折叠面板、footer 统计），
 *                关掉 `streaming_mode`，并删掉 loading 图标
 */

import { buildStreamingCard, buildCompleteCard, STREAMING_ELEMENT_ID } from './card-builder.js';
import { FlushController } from './flush-controller.js';

export class CardKitController {
  constructor(options = {}) {
    this.transport = options.transport;
    this.receiveId = options.receiveId;
    this.receiveIdType = options.receiveIdType || 'open_id';
    this.throttleMs = options.throttleMs ?? 200;
    this.logger = options.logger || console;
    this.showToolUse = options.showToolUse !== false;
    // 官方 buildCompleteCard / buildStreamingPreAnswerCard 都不带 header：
    // 状态只出现在 footer 第一行，避免每条回复都顶着「已完成」这种标题。
    this.withHeader = options.withHeader === true;
    /** 被引用的用户消息 ID，存在时卡片以「引用回复」形式发出。 */
    this.replyToMessageId = options.replyToMessageId || '';

    this.state = 'idle'; // idle | streaming | completed | failed | stopped
    this.cardId = null;
    this.messageId = null;
    this.sequence = 1;
    /** 飞书 elementID 限制：字母开头、仅 [A-Za-z0-9_]、不超过 20 字符。 */
    this.contentElementId = STREAMING_ELEMENT_ID;
    this.accumulatedText = '';

    this.startedAt = 0;
    this.reasoningText = '';
    this.toolSteps = [];
    this.model = '';
    this.totalTokens = 0;
    this.cacheHitRate = null;

    this.flusher = new FlushController({
      intervalMs: this.throttleMs,
      logger: this.logger,
      onFlush: async () => {
        // 飞书 `PUT /cards/:id/elements/:eid/content` 是「设置」语义而非追加，
        // 必须每次发累积全文，否则卡片只会显示最后一段增量。
        await this._sendStreamChunk(false);
      },
    });
  }

  /** 记录本轮模型/用量，供 footer 展示。 */
  setMetrics({ model, totalTokens, cacheHitRate }) {
    if (model) this.model = model;
    if (Number.isFinite(totalTokens) && totalTokens > 0) this.totalTokens = totalTokens;
    if (Number.isFinite(cacheHitRate)) this.cacheHitRate = cacheHitRate;
  }

  /** 记录思考内容。 */
  setReasoning(text) {
    if (typeof text === 'string' && text) this.reasoningText = text;
  }

  /** 记录工具步骤（覆盖式，便于最后整卡替换）。 */
  setToolSteps(steps) {
    if (Array.isArray(steps)) this.toolSteps = steps;
  }

  /**
   * 启动流式卡片。
   * @param {object} [options]
   */
  async start(options = {}) {
    if (this.state !== 'idle') return;
    this.startedAt = Date.now();

    const initialCard = buildStreamingCard({
      withToolPanel: this.showToolUse,
      withHeader: this.withHeader,
    });

    try {
      const cardEntity = await this.transport.createCardEntity({ card: initialCard });
      this.cardId = cardEntity.card_id;

      const msgRes = await this.transport.sendMessage({
        receiveIdType: this.receiveIdType,
        receiveId: this.receiveId,
        msgType: 'interactive',
        content: { type: 'card', data: { card_id: this.cardId } },
        // 挂在用户那条消息下面，飞书会显示成引用回复。
        replyToMessageId: this.replyToMessageId || undefined,
      });

      this.messageId = msgRes?.message_id;
      this.state = 'streaming';
      this.logger.info?.(`[CardKit] streaming card started (card=${this.cardId}, msg=${this.messageId})`);
    } catch (err) {
      this.state = 'failed';
      this.logger.error?.('[CardKit] failed to start streaming:', err?.message || err);
      throw err;
    }
  }

  /**
   * 推入正文增量。
   * @param {string} chunk
   */
  async pushChunk(chunk) {
    if (this.state !== 'streaming' || !chunk) return;
    this.accumulatedText += chunk;
    this.flusher.push(chunk);
  }

  /**
   * 把当前累积全文推给飞书。
   * @param {boolean} finished
   */
  async _sendStreamChunk(finished = false) {
    if (!this.cardId) return;
    const content = this.accumulatedText || '...';
    try {
      await this.transport.streamCardContent({
        cardId: this.cardId,
        sequence: this.sequence++,
        elementId: this.contentElementId,
        content,
        finished,
      });
    } catch (err) {
      this.logger.warn?.('[CardKit] stream chunk failed:', err?.message || err);
    }
  }

  /**
   * 收尾：整卡替换成完成态。
   *
   * @param {object} [options]
   * @param {string} [options.finalText] 追加到正文末尾的文本
   * @param {boolean} [options.isError]
   * @param {boolean} [options.isAborted]
   * @param {string} [options.stopReason]
   */
  async finish(options = {}) {
    if (this.state !== 'streaming') return;
    await this.flusher.flush();
    this.flusher.dispose();

    if (options.finalText) this.accumulatedText += options.finalText;

    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const isError = options.isError === true;
    const isAborted = options.isAborted === true;

    if (isAborted && options.stopReason) {
      this.accumulatedText += `\n\n*[${options.stopReason}]*`;
    }

    const card = buildCompleteCard({
      text: this.accumulatedText,
      reasoningText: this.reasoningText,
      reasoningElapsedMs: 0,
      toolSteps: this.toolSteps,
      toolElapsedMs: 0,
      elapsedMs,
      model: this.model,
      totalTokens: this.totalTokens,
      cacheHitRate: this.cacheHitRate,
      isError,
      isAborted,
      showToolUse: this.showToolUse,
      withHeader: this.withHeader,
    });

    this.state = isError ? 'failed' : isAborted ? 'stopped' : 'completed';

    try {
      // 整卡替换：sequence 必须比之前所有更新都大。
      await this.transport.updateCardKitCard({
        cardId: this.cardId,
        card,
        sequence: this.sequence++,
      });
      this.logger.info?.(`[CardKit] card finalized in ${elapsedMs}ms (${this.state})`);
    } catch (err) {
      this.logger.warn?.('[CardKit] final card update failed:', err?.message || err);
      // 兜底：至少把流式关掉，避免卡片一直转圈。
      try {
        await this._sendStreamChunk(true);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 中止流式（用户 stop / 超时）。
   * @param {string} [reason]
   */
  async abort(reason = '已停止') {
    if (this.state !== 'streaming') return;
    await this.finish({ isAborted: true, stopReason: reason });
  }
}
