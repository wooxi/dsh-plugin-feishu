export class LarkTransport {
  constructor(options = {}) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = options.baseUrl || 'https://open.feishu.cn';
    this.logger = options.logger || console;

    this.tokenCache = null;
    this.tokenExpiresAt = 0;
  }

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

    async sendMessage({ receiveIdType = 'open_id', receiveId, msgType, content, replyToMessageId }) {
    const token = await this.getTenantAccessToken();

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
    return data.data; 
  }

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
