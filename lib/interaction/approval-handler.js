/**
 * Waterfall Approval Handler
 *
 * 把 DSH 的工具授权请求接到飞书卡片上。
 *
 * DSH 契约（dsh-user-approval/lib/index.js:30-35, :176）：
 * - 事件名 `approval/request`，waterfall 模式，监听签名 `(request, next) => Promise<outcome>`
 * - 合法 outcome：'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
 * - 不接这次请求时调用 `next()` 让给下一个回答者（通常是网页端）
 *
 * 此前实现用 `waterfall.resolve(requestId, ...)` 是虚构 API，宿主不存在该方法，
 * 因此审批卡从未真正回传结果。
 */

/** 宿主认的「本次允许」决议词。 */
export const ALLOWED_ONCE = 'allowed-once';
/** 宿主认的「拒绝」决议词。 */
export const REJECTED = 'rejected';
/** 本轮被停掉时的决议词。 */
export const CANCELLED = 'cancelled';

export class ApprovalHandler {
  constructor(options = {}) {
    this.transport = options.transport;
    this.logger = options.logger || console;
    this.receiveId = options.receiveId || '';
    /** 动态取接收方（最近一次与机器人对话的用户 open_id） */
    this.getReceiveId = options.getReceiveId || null;
    /** requestId -> { resolve, messageId, requestedAt } */
    this.pendingApprovals = new Map();
  }

  /**
   * 构建审批卡片。
   * @param {object} req
   */
  renderCard(req = {}) {
    const { id, tool = 'unknown', args = {}, description = '' } = req;

    const detailMarkdown = [
      `⚠️ **操作需要授权**`,
      `**工具名称**: \`${tool}\``,
      description ? `**说明**: ${description}` : '',
      `**参数详情**:\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: '🛡️ DSH 风险操作授权申请' },
        template: 'orange',
      },
      body: {
        elements: [
          { tag: 'markdown', content: detailMarkdown },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '✅ 允许执行' },
                    type: 'primary',
                    behaviors: [
                      {
                        type: 'callback',
                        value: { action: 'waterfall_approval', requestId: id, decision: ALLOWED_ONCE },
                      },
                    ],
                  },
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '❌ 拒绝' },
                    type: 'danger',
                    behaviors: [
                      {
                        type: 'callback',
                        value: { action: 'waterfall_approval', requestId: id, decision: REJECTED },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  }

  /**
   * 宿主来要授权：发卡片并挂起，等用户点按钮。
   *
   * @param {object} request 宿主给的审批请求
   * @param {Function} next 让给下一个回答者
   * @returns {Promise<string>} 宿主认的 outcome
   */
  async onRequest(request, next) {
    // 只接飞书发起的轮次：没有接收方就交还网页端
    const receiveId = this.getReceiveId?.() || this.receiveId;
    if (!receiveId || !this.transport) {
      this.logger.info?.('[ApprovalHandler] 没有飞书接收方，审批让给网页端');
      return typeof next === 'function' ? next() : 'unavailable';
    }

    const requestId = `apv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const card = this.renderCard({
      id: requestId,
      tool: request?.toolName ?? request?.tool ?? 'unknown',
      args: request?.input ?? request?.args ?? {},
      description: request?.reason ?? request?.description ?? '',
    });

    return await new Promise(async (resolve) => {
      const settle = (outcome) => {
        if (!this.pendingApprovals.has(requestId)) return;
        this.pendingApprovals.delete(requestId);
        resolve(outcome);
      };

      // 这一轮被停掉时按 cancelled 交回，避免宿主一直等
      const signal = request?.signal;
      if (signal?.addEventListener) {
        const onAbort = () => settle(CANCELLED);
        if (signal.aborted) {
          settle(CANCELLED);
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      let messageId = '';
      try {
        const sent = await this.transport.sendCard?.({
          receive_id: receiveId,
          card,
        });
        messageId = sent?.data?.message_id ?? sent?.message_id ?? '';
      } catch (err) {
        this.logger.error?.('[ApprovalHandler] 发送审批卡片失败:', err);
        settle('unavailable');
        return;
      }

      this.pendingApprovals.set(requestId, { resolve: settle, messageId, requestedAt: Date.now() });
      this.logger.info?.(`[ApprovalHandler] 已发出审批卡片 ${requestId}，等待用户点击`);
    });
  }

  /**
   * 用户点了卡片按钮。
   * @param {object} actionPayload 卡片回调里的 action.value
   * @returns {boolean} 是否命中在册请求
   */
  handleCardAction(actionPayload = {}) {
    const value = actionPayload.value || actionPayload;
    const requestId = value.requestId;
    const decision = value.decision === ALLOWED_ONCE ? ALLOWED_ONCE : REJECTED;

    const entry = this.pendingApprovals.get(requestId);
    if (!entry) {
      this.logger.warn?.(`[ApprovalHandler] 没有在册的审批请求: ${requestId}`);
      return false;
    }

    entry.resolve(decision);
    this.logger.info?.(`[ApprovalHandler] 审批 ${requestId} 结果: ${decision}`);
    return true;
  }
}
