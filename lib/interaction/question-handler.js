export class QuestionHandler {
  constructor(options = {}) {
    this.transport = options.transport;
    this.logger = options.logger || console;
    this.receiveId = options.receiveId || '';
        this.getReceiveId = options.getReceiveId || null;
        this.pendingQuestions = new Map();
  }

  hasPending(id) {
    if (id) return this.pendingQuestions.has(id);
    return this.pendingQuestions.size > 0;
  }

  getLatestPending() {
    if (this.pendingQuestions.size === 0) return null;
    const entries = Array.from(this.pendingQuestions.entries());
    return entries[entries.length - 1]; 
  }

    renderCard(req = {}) {
    const { id, questions = [] } = req;
    const elements = [];

    for (const q of questions) {
      elements.push({ tag: 'markdown', content: `**${q.question ?? q.header ?? ''}**` });

      const options = q.options ?? [];
      if (options.length > 0) {
        elements.push({
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: options.map((opt) => ({
                tag: 'button',
                text: { tag: 'plain_text', content: opt.label ?? opt },
                type: 'default',
                behaviors: [
                  {
                    type: 'callback',
                    value: {
                      action: 'waterfall_question_answer',
                      requestId: id,
                      questionId: q.id,
                      answer: opt.label ?? opt,
                    },
                  },
                ],
              })),
            },
          ],
        });
      } else {
        elements.push({
          tag: 'markdown',
          content: '<font color="grey">💬 提示：直接在私聊窗口输入文字发送即可回答此问题。</font>',
        });
      }
    }

    return {
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: '❓ DSH 提问需要您的确认' },
        template: 'blue',
      },
      body: { elements },
    };
  }

    async onRequest(request, next) {
    const receiveId = this.getReceiveId?.() || this.receiveId;
    if (!receiveId || !this.transport) {
      this.logger.info?.('[QuestionHandler] 没有飞书接收方，反问让给网页端');
      return typeof next === 'function' ? next() : { answers: [] };
    }

    const questions = request?.questions ?? [];
    if (questions.length === 0) {
      return typeof next === 'function' ? next() : { answers: [] };
    }

    const requestId = `qst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const card = this.renderCard({ id: requestId, questions });

    return await new Promise(async (resolve) => {
      const settle = (answer) => {
        if (!this.pendingQuestions.has(requestId)) return;
        this.pendingQuestions.delete(requestId);
        resolve(answer);
      };

      const signal = request?.signal;
      if (signal?.addEventListener) {
        if (signal.aborted) {
          settle({ answers: [] });
          return;
        }
        signal.addEventListener('abort', () => settle({ answers: [] }), { once: true });
      }

      let messageId = '';
      try {
        const sent = await this.transport.sendCard?.({ receive_id: receiveId, card });
        messageId = sent?.data?.message_id ?? sent?.message_id ?? '';
      } catch (err) {
        this.logger.error?.('[QuestionHandler] 发送反问卡片失败:', err);
        settle({ answers: [] });
        return;
      }

      this.pendingQuestions.set(requestId, {
        resolve: settle,
        messageId,
        questions,
        requestedAt: Date.now(),
      });
      this.logger.info?.(`[QuestionHandler] 已发出反问卡片 ${requestId}，等待用户回答`);
    });
  }

    handleCardAction(actionPayload = {}) {
    const value = actionPayload.value || actionPayload;
    const { requestId, questionId, answer } = value;

    const entry = this.pendingQuestions.get(requestId);
    if (!entry) {
      this.logger.warn?.(`[QuestionHandler] 没有在册的反问请求: ${requestId}`);
      return false;
    }

    const qid = questionId ?? entry.questions[0]?.id ?? 'answer';
    entry.resolve({ answers: [{ id: qid, selected: [String(answer)] }] });
    this.logger.info?.(`[QuestionHandler] 反问 ${requestId} 已由按钮回答: ${answer}`);
    return true;
  }

    handleDirectReply(text) {
    const latest = this.getLatestPending();
    if (!latest) return false;

    const [requestId, entry] = latest;
    const firstQId = entry.questions?.[0]?.id ?? 'answer';
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return false;

    entry.resolve({ answers: [{ id: firstQId, selected: [trimmed], custom: trimmed }] });
    this.logger.info?.(`[QuestionHandler] 反问 ${requestId} 已由文本回答: ${trimmed}`);
    return true;
  }
}
