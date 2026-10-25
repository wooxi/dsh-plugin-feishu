/**
 * Waterfall User Questions Handler
 *
 * 把 DSH 的 `ask_user_question` 反问接到飞书卡片上，并支持在私聊里直接打文字回答。
 *
 * DSH 契约（dsh-user-questions/lib/types/types.d.ts:145, :49-61）：
 * - 事件名 `user-questions/request`，waterfall 模式，
 *   监听签名 `(request, next) => Promise<AskUserQuestionAnswer>`
 * - 答案形状：`{ answers: [{ id, selected: string[], custom?: string }] }`（**数组**，不是字典）
 *
 * 此前实现用 `waterfall.resolve(requestId, { answers: { [qid]: text } })`：
 * 方法不存在、形状也不对，因此反问从未真正回传。
 */

export class QuestionHandler {
  constructor(options = {}) {
    this.transport = options.transport;
    this.logger = options.logger || console;
    this.receiveId = options.receiveId || '';
    /** 动态取接收方（最近一次与机器人对话的用户 open_id） */
    this.getReceiveId = options.getReceiveId || null;
    /** requestId -> { resolve, messageId, questions, requestedAt } */
    this.pendingQuestions = new Map();
  }

  hasPending(id) {
    if (id) return this.pendingQuestions.has(id);
    return this.pendingQuestions.size > 0;
  }

  getLatestPending() {
    if (this.pendingQuestions.size === 0) return null;
    const entries = Array.from(this.pendingQuestions.entries());
    return entries[entries.length - 1]; // [id, entry]
  }

  /**
   * 构建反问卡片。
   * @param {object} req `{ id, questions }`
   */
  renderCard(req = {}) {
    const { id, questions = [] } = req;
    const elements = [];

    for (const q of questions) {
      elements.push({ tag: 'markdown', content: `**${q.question ?? q.header ?? ''}**` });

      const options = q.options ?? [];
      if (options.length > 0) {
        // schema 2.0 不支持 `tag: 'action'` 容器（200861 unsupported tag action），
        // 选项按钮用 `column_set > column > button`，回调值走 `behaviors`。
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
        // schema 2.0 已废除 `tag: 'note'`（200861 unsupported tag note），
        // 用一行浅色 markdown 代替提示。
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

  /**
   * 宿主来问一次：发卡片并挂起，等用户点按钮或在私聊里打字。
   *
   * @param {object} request `AskUserQuestionRequestEvent`
   * @param {Function} next 让给下一个回答者
   * @returns {Promise<{answers: Array<{id: string, selected: string[], custom?: string}>}>}
   */
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

  /**
   * 用户点了选项按钮。
   * @param {object} actionPayload 卡片回调里的 action.value
   * @returns {boolean} 是否命中在册请求
   */
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

  /**
   * 兜底：私聊里直接打文字，当成最新待答问题的回答。
   * @param {string} text
   * @returns {boolean} true 表示已被当作答案消费
   */
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
