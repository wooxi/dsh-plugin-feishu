import { generateQrSvg } from './qr-generator.js';
import crypto from 'node:crypto';

export class FeishuConfigRouter {
    constructor({ config, onConfigUpdate, transport, logger, patchPath, ensureWorkspace }) {
    this.config = config;
    this.onConfigUpdate = onConfigUpdate;
    this.transport = transport;
    this.ensureWorkspace = ensureWorkspace;
    this.logger = logger || console;

    this.patchPath = patchPath ?? null;

    this.pairingSessions = new Map();
  }

    register(webServer) {
    if (!webServer || typeof webServer.register !== 'function') {
      this.logger.warn?.('WebServer service not available; skipping Feishu REST routes registration.');
      return () => {};
    }

    const unregisters = [];

    const disposer = webServer.register({
      kind: 'prefix',
      path: '/api/feishu',
      handler: async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err) {
          this.logger.error?.('Feishu config router error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
          }
        }
      },
    });

    unregisters.push(disposer);
    return () => {
      for (const un of unregisters) un();
    };
  }

    async handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/api/feishu/config' && req.method === 'GET') {
      return this.handleGetConfig(req, res);
    }
    if (pathname === '/api/feishu/config' && req.method === 'POST') {
      return this.handleSaveConfig(req, res);
    }
    if ((pathname === '/api/feishu/test' || pathname === '/api/feishu/test-connection') && req.method === 'POST') {
      return this.handleTestConnection(req, res);
    }
    if (pathname === '/api/feishu/qr/generate' && req.method === 'GET') {
      return this.handleGenerateQr(req, res);
    }
    if (pathname === '/api/feishu/qr/poll' && req.method === 'GET') {
      return this.handlePollQr(req, res, url);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

    async parseJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          reject(new Error('Request entity too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('Invalid JSON format'));
        }
      });
      req.on('error', reject);
    });
  }

    async handleGetConfig(req, res) {
    const safeConfig = { ...this.config };
    const hasSecret = Boolean(safeConfig.appSecret && safeConfig.appSecret.length > 0);
    if (hasSecret) {
      const sec = safeConfig.appSecret;
      safeConfig.appSecretMasked = sec.length > 6
        ? `${sec.slice(0, 3)}••••••••${sec.slice(-3)}`
        : '••••••••';
    } else {
      safeConfig.appSecretMasked = '';
    }
    delete safeConfig.appSecret; 
    safeConfig.workspaceDir = safeConfig.workspaceDir || '/dsh-workspace/feishu';
    safeConfig.feishuWorkspaceDir = safeConfig.feishuWorkspaceDir || '/dsh-workspace/feishu';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      data: safeConfig,
      hasSecret,
      connectionStatus: this.transport?.isConnected ? 'connected' : 'idle',
    }));
  }

    async handleSaveConfig(req, res) {
    const body = await this.parseJsonBody(req);

    const updated = { ...this.config };
    if (body.appId !== undefined) updated.appId = String(body.appId).trim();
    if (body.appSecret && !body.appSecret.includes('••••')) {
      updated.appSecret = String(body.appSecret).trim();
    }
    if (body.ownerId !== undefined) updated.ownerId = String(body.ownerId).trim();
    if (body.workspaceDir !== undefined) updated.workspaceDir = String(body.workspaceDir).trim();
    if (body.feishuWorkspaceDir !== undefined) updated.feishuWorkspaceDir = String(body.feishuWorkspaceDir).trim();
    if (body.enableCardKit !== undefined) updated.enableCardKit = Boolean(body.enableCardKit);
    if (body.enableThinkingFold !== undefined) updated.enableThinkingFold = Boolean(body.enableThinkingFold);
    if (body.enableToolTracker !== undefined) updated.enableToolTracker = Boolean(body.enableToolTracker);
    if (body.enableMultiModal !== undefined) updated.enableMultiModal = Boolean(body.enableMultiModal);
    if (body.enableGroupChat !== undefined) updated.enableGroupChat = Boolean(body.enableGroupChat);

    this.config = updated;
    if (typeof this.onConfigUpdate === 'function') {
      await this.onConfigUpdate(updated);
    }

    try {
      const fs = await import('node:fs');
      const patchPath = this.patchPath;
      if (patchPath && fs.existsSync(patchPath)) {
        let content = fs.readFileSync(patchPath, 'utf-8');
        if (updated.appId) {
          content = content.replace(/appId:\s*.*$/m, `appId: ${updated.appId}`);
        }
        if (updated.appSecret) {
          content = content.replace(/appSecret:\s*.*$/m, `appSecret: ${updated.appSecret}`);
        }
        if (updated.ownerId !== undefined) {
          if (/ownerId:\s*.*$/m.test(content)) {
            content = content.replace(/ownerId:\s*.*$/m, `ownerId: ${updated.ownerId}`);
          }
        }
        if (updated.workspaceDir) {
          if (/workspaceDir:\s*.*$/m.test(content)) {
            content = content.replace(/workspaceDir:\s*.*$/m, `workspaceDir: ${updated.workspaceDir}`);
          } else {
            content = content.replace(/(appSecret:\s*.*$)/m, `$1\n    workspaceDir: ${updated.workspaceDir}`);
          }
        }
        if (updated.feishuWorkspaceDir) {
          if (/feishuWorkspaceDir:\s*.*$/m.test(content)) {
            content = content.replace(/feishuWorkspaceDir:\s*.*$/m, `feishuWorkspaceDir: ${updated.feishuWorkspaceDir}`);
          } else {
            content = content.replace(/(appSecret:\s*.*$)/m, `$1\n    feishuWorkspaceDir: ${updated.feishuWorkspaceDir}`);
          }
        }
        fs.writeFileSync(patchPath, content, 'utf-8');
      }
    } catch (err) {
      this.logger.warn?.('[FeishuConfigRouter] Could not persist patch to disk:', err.message);
    }

    const result = {
      code: 0,
      ok: true,
      saved: true,
      verified: false,
      delivered: false,
      workspace: null,
      bot: null,
      ownerIdSet: Boolean(updated.ownerId),
    };

    if (updated.appId && updated.appSecret) {
      try {
        const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: updated.appId, app_secret: updated.appSecret }),
        });
        const tokenData = await tokenResp.json();

        if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
          result.ok = false;
          result.error = `\u9274\u6743\u5931\u8d25\uff1a${tokenData.msg || 'App ID \u6216 App Secret \u65e0\u6548'}`;
        } else {
          result.verified = true;
          const tenantToken = tokenData.tenant_access_token;

          const botResp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
            headers: { Authorization: `Bearer ${tenantToken}` },
          });
          const botData = await botResp.json();
          result.bot = {
            name: botData.bot?.app_name || 'Feishu Bot',
            avatarUrl: botData.bot?.avatar_url || '',
          };

          if (updated.ownerId) {
            const sendResp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${tenantToken}`,
                'Content-Type': 'application/json; charset=utf-8',
              },
              body: JSON.stringify({
                receive_id: updated.ownerId,
                msg_type: 'text',
                content: JSON.stringify({
                  text: '\u2705 DSH \u98de\u4e66\u901a\u9053\u5df2\u8fde\u63a5\uff1a\u8fd9\u6761\u6d88\u606f\u6536\u5230\uff0c\u8bf4\u660e\u51ed\u636e\u4e0e\u53d1\u9001\u6743\u9650\u5747\u6b63\u5e38\u3002',
                }),
              }),
            });
            const sendData = await sendResp.json();
            result.delivered = sendData.code === 0;
            if (!result.delivered) {
              result.ok = false;
              result.error = `\u53d1\u9001\u6d4b\u8bd5\u6d88\u606f\u5931\u8d25\uff1a${sendData.msg || '\u672a\u77e5\u9519\u8bef'}`;
            }
          }

          if (typeof this.ensureWorkspace === 'function' && result.ok) {
            try {
              const ws = await this.ensureWorkspace(updated.feishuWorkspaceDir || updated.workspaceDir);
              if (ws && ws.id) {
                result.workspace = { id: ws.id, path: ws.path, created: Boolean(ws.created) };
              }
            } catch (wsErr) {
              this.logger.warn?.('[FeishuConfigRouter] \u5de5\u4f5c\u533a\u521b\u5efa\u5931\u8d25:', wsErr.message);
            }
          }
        }
      } catch (err) {
        result.ok = false;
        result.error = `\u8fde\u63a5\u98de\u4e66\u5931\u8d25\uff1a${err.message}`;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

    async persistOwner(ownerId) {
    if (!ownerId) return false;
    this.config = { ...this.config, ownerId };
    try {
      const fs = await import('node:fs');
      const patchPath = this.patchPath;
      if (patchPath && fs.existsSync(patchPath)) {
        let content = fs.readFileSync(patchPath, 'utf-8');
        if (/ownerId:\s*.*$/m.test(content)) {
          content = content.replace(/ownerId:\s*.*$/m, `ownerId: ${ownerId}`);
        }
        fs.writeFileSync(patchPath, content, 'utf-8');
      }
      return true;
    } catch (err) {
      this.logger.warn?.('[FeishuConfigRouter] persistOwner failed:', err.message);
      return false;
    }
  }

    async handleTestConnection(req, res) {
    const body = await this.parseJsonBody(req);
    const appId = body.appId || this.config.appId;
    let appSecret = body.appSecret;
    if (!appSecret || appSecret.includes('\u2022')) {
      appSecret = this.config.appSecret;
    }
    const ownerId = (body.ownerId || this.config.ownerId || '').trim();

    const reply = (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (!appId || !appSecret) {
      reply({ code: 400, ok: false, error: 'App ID \u548c App Secret \u4e3a\u5fc5\u586b\u9879' });
      return;
    }

    try {
      const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const tokenData = await tokenResp.json();

      if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
        reply({
          code: tokenData.code || -1,
          ok: false,
          error: `\u9274\u6743\u5931\u8d25\uff1a${tokenData.msg || 'App ID \u6216 App Secret \u65e0\u6548'}`,
        });
        return;
      }

      const tenantToken = tokenData.tenant_access_token;

      const botResp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${tenantToken}` },
      });
      const botData = await botResp.json();
      const botInfo = botData.bot || { app_name: 'Feishu Bot', avatar_url: '' };

      const bot = {
        name: botInfo.app_name,
        avatarUrl: botInfo.avatar_url,
        openMode: botInfo.open_id ? 'active' : 'ready',
      };

      if (!ownerId) {
        reply({
          code: 0,
          ok: true,
          delivered: false,
          bot,
          message: '\u8fde\u63a5\u6b63\u5e38\u3002\u586b\u5199\u7ba1\u7406\u5458 Open ID \u540e\u53ef\u53d1\u9001\u6d4b\u8bd5\u6d88\u606f\u3002',
        });
        return;
      }

      const sendResp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: ownerId,
          msg_type: 'text',
          content: JSON.stringify({
            text: '\u2705 DSH \u98de\u4e66\u901a\u9053\u6d4b\u8bd5\uff1a\u8fd9\u6761\u6d88\u606f\u80fd\u6536\u5230\uff0c\u8bf4\u660e App ID / App Secret \u4e0e\u53d1\u9001\u6743\u9650\u90fd\u6b63\u5e38\u3002',
          }),
        }),
      });
      const sendData = await sendResp.json();

      if (sendData.code !== 0) {
        reply({
          code: sendData.code || -1,
          ok: false,
          bot,
          delivered: false,
          error: `\u53d1\u9001\u6d4b\u8bd5\u6d88\u606f\u5931\u8d25\uff1a${sendData.msg || '\u672a\u77e5\u9519\u8bef'}`,
        });
        return;
      }

      reply({
        code: 0,
        ok: true,
        delivered: true,
        bot,
        messageId: sendData.data?.message_id || '',
        message: '\u6d4b\u8bd5\u6d88\u606f\u5df2\u53d1\u9001\uff0c\u8bf7\u5230\u98de\u4e66\u67e5\u770b\u3002',
      });
    } catch (err) {
      reply({ code: -1, ok: false, error: `\u8fde\u63a5\u98de\u4e66\u5931\u8d25\uff1a${err.message}` });
    }
  }

    async handleGenerateQr(req, res) {
    const token = crypto.randomBytes(16).toString('hex');
    const appId = this.config.appId || '';

    const now = Date.now();
    for (const [k, v] of this.pairingSessions.entries()) {
      if (now - v.createdAt > 10 * 60 * 1000) {
        this.pairingSessions.delete(k);
      }
    }

    this.pairingSessions.set(token, {
      createdAt: now,
      status: 'pending',
      openId: null,
      userName: null,
    });

    const pairingUrl = appId
      ? `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(appId)}&mode=pair&token=${token}`
      : `feishu-dsh://pair?token=${token}`;

    const svg = generateQrSvg(pairingUrl, {
      size: 220,
      fgColor: '#3370ff', 
      bgColor: '#ffffff',
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      token,
      pairingUrl,
      svg,
      expiresIn: 600,
    }));
  }

    async handlePollQr(req, res, url) {
    const token = url.searchParams.get('token');
    if (!token || !this.pairingSessions.has(token)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 400, status: 'expired', error: 'Invalid or expired token' }));
      return;
    }

    const session = this.pairingSessions.get(token);
    if (Date.now() - session.createdAt > 600 * 1000) {
      session.status = 'expired';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      status: session.status,
      openId: session.openId,
      userName: session.userName,
    }));
  }

    confirmPairing(token, userInfo) {
    const session = this.pairingSessions.get(token);
    if (!session) return false;

    session.status = 'scanned';
    session.openId = userInfo.openId;
    session.userName = userInfo.userName;

    if (!this.config.ownerId && userInfo.openId) {
      this.config.ownerId = userInfo.openId;
      if (typeof this.onConfigUpdate === 'function') {
        this.onConfigUpdate(this.config);
      }
    }
    return true;
  }
}
