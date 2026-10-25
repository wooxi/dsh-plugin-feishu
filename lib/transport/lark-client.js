/**
 * Lark/Feishu Transport Client
 * Wraps REST calls, token caching, CardKit 2.0 streaming, and media handling.
 */

export class LarkTransport {
  constructor(options = {}) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = options.baseUrl || 'https://open.feishu.cn';
    this.logger = options.logger || console;

    this.tokenCache = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * Acquire or refresh tenant access token
   */
  async getTenantAccessToken() {
    const now = Date.now();
    if (this.tokenCache && this.tokenExpiresAt - now > 60000) {
      return this.tokenCache;
    }

    if (!this.appId || !this.appSecret) {
      throw new Error('Missing appId or appSecret');
    }

    const res = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to get tenant_access_token: ${res.status} ${errText}`);
    }

    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`Feishu auth error [${data.code}]: ${data.msg}`);
    }

    this.tokenCache = data.tenant_access_token;
    this.tokenExpiresAt = now + (data.expire - 120) * 1000;
    return this.tokenCache;
  }

  /**
   * Send a message to user or chat
   */
  async sendMessage({ receiveIdType = 'open_id', receiveId, msgType, content, replyToMessageId }) {
    const token = await this.getTenantAccessToken();

    // 引用回复与新建消息是两个不同端点：
    //   POST /open-apis/im/v1/messages            → 发新消息
    //   POST /open-apis/im/v1/messages/:id/reply   → 挂在那条消息下面（用户能看到引用）
    // 官方 openclaw-lark 也是这么分流的（src/messaging/outbound/send.ts:276-299）。
    const body = {
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    };
    let url;
    if (replyToMessageId) {
      url = `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`;
    } else {
      url = `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
      body.receive_id = receiveId;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`sendMessage failed [${data.code}]: ${data.msg}`);
    }
    return data.data;
  }

  /**
   * 发送一张交互卡片（msg_type=interactive）。
   *
   * @param {object} params
   * @param {string} params.receive_id 接收方 open_id / chat_id
   * @param {object} params.card 卡片 JSON（schema 2.0）
   * @returns {Promise<object>} 飞书返回的 data（含 message_id）
   */
  async sendCard({ receive_id, card, receiveIdType = 'open_id' }) {
    const token = await this.getTenantAccessToken();
    const url = `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
    });

    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`sendCard failed [${data.code}]: ${data.msg}`);
    }
    return data;
  }

  /**
   * Create an interactive card entity via CardKit 2.0
   */
  async createCardEntity({ card }) {
    const token = await this.getTenantAccessToken();
    const url = `${this.baseUrl}/open-apis/cardkit/v1/cards`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        type: 'card_json',
        data: JSON.stringify(card),
      }),
    });

    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`createCardEntity failed [${data.code}]: ${data.msg}`);
    }
    return data.data; // { card_id }
  }

  /**
   * Stream content update into a specific element in CardKit 2.0
   * @param {object} params
   * @param {string} params.cardId
   * @param {number} params.sequence
   * @param {string} params.elementId
   * @param {string} params.content
   * @param {boolean} params.finished
   */
  async streamCardContent({ cardId, sequence, elementId, content, finished = false }) {
    const token = await this.getTenantAccessToken();
    const url = `${this.baseUrl}/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`;

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        sequence,
        content,
        finished,
      }),
    });

    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`streamCardContent failed [${data.code}]: ${data.msg}`);
    }
    return data;
  }

  /**
   * 整卡替换（CardKit 2.0 `PUT /cards/:id`）。
   *
   * 流式收尾时用它把骨架卡换成成品卡（绿 header + 折叠面板 + footer），
   * 比 `patchCard` 更可靠：走的是 CardKit 的卡片实体，sequence 与
   * 元素更新共用同一条递增链。
   *
   * @param {object} params
   * @param {string} params.cardId
   * @param {object} params.card    完整 CardKit 2.0 卡片 JSON
   * @param {number} params.sequence
   */
  async updateCardKitCard({ cardId, card, sequence }) {
    const token = await this.getTenantAccessToken();
    const url = `${this.baseUrl}/open-apis/cardkit/v1/cards/${cardId}`;

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        card: { type: 'card_json', data: JSON.stringify(card) },
        sequence,
      }),
    });

    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`updateCardKitCard failed [${data.code}]: ${data.msg}`);
    }
    return data;
  }

  /**
   * Fallback: update an existing card message via IM patch API
   */
  async patchCard({ messageId, card }) {
    const token = await this.getTenantAccessToken();
    const url = `${this.baseUrl}/open-apis/im/v1/messages/${messageId}`;

    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
      }),
    });

    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`patchCard failed [${data.code}]: ${data.msg}`);
    }
    return data.data;
  }
}

export function createLarkTransport(options) {
  return new LarkTransport(options);
}
