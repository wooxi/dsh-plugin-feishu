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
    this.withHeader = options.withHeader === true;
        this.replyToMessageId = options.replyToMessageId || '';

    this.state = 'idle'; 
    this.cardId = null;
    this.messageId = null;
    this.sequence = 1;
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
        await this._sendStreamChunk(false);
      },
    });
  }

    setMetrics({ model, totalTokens, cacheHitRate }) {
    if (model) this.model = model;
    if (Number.isFinite(totalTokens) && totalTokens > 0) this.totalTokens = totalTokens;
    if (Number.isFinite(cacheHitRate)) this.cacheHitRate = cacheHitRate;
  }

    setReasoning(text) {
    if (typeof text === 'string' && text) this.reasoningText = text;
  }

    setToolSteps(steps) {
    if (Array.isArray(steps)) this.toolSteps = steps;
  }

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

    async pushChunk(chunk) {
    if (this.state !== 'streaming' || !chunk) return;
    this.accumulatedText += chunk;
    this.flusher.push(chunk);
  }

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
      await this.transport.updateCardKitCard({
        cardId: this.cardId,
        card,
        sequence: this.sequence++,
      });
      this.logger.info?.(`[CardKit] card finalized in ${elapsedMs}ms (${this.state})`);
    } catch (err) {
      this.logger.warn?.('[CardKit] final card update failed:', err?.message || err);
      try {
        await this._sendStreamChunk(true);
      } catch {
              }
    }
  }

    async abort(reason = '已停止') {
    if (this.state !== 'streaming') return;
    await this.finish({ isAborted: true, stopReason: reason });
  }
}
