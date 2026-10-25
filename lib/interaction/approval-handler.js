export const ALLOWED_ONCE = 'allowed-once';
export const REJECTED = 'rejected';
export const CANCELLED = 'cancelled';

export class ApprovalHandler {
  constructor(options = {}) {
    this.transport = options.transport;
    this.logger = options.logger || console;
    this.receiveId = options.receiveId || '';
        this.getReceiveId = options.getReceiveId || null;
        this.pendingApprovals = new Map();
  }

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

    async onRequest(request, next) {
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
