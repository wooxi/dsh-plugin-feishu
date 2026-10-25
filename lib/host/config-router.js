import { generateQrSvg } from './qr-generator.js';
import crypto from 'node:crypto';

/**
 * REST API Router for DSH Web Settings Page & QR Code Pairing.
 * Mounted on DSH WebServer service.
 */
export class FeishuConfigRouter {
  /**
   * @param {object} options
   * @param {object} options.config - current plugin config reference
   * @param {Function} options.onConfigUpdate - callback when config is updated
   * @param {object} options.transport - current LarkTransport instance
   * @param {object} options.logger - logger instance
   */
  constructor({ config, onConfigUpdate, transport, logger, patchPath }) {
    this.config = config;
    this.onConfigUpdate = onConfigUpdate;
    this.transport = transport;
    this.logger = logger || console;

    // 配置落盘位置：必须可注入。
    // 此前这里写死生产路径，导致单元测试每跑一次就把真实凭据覆盖成测试占位值
    // （cli_new_app / old_sec），飞书长连接因此永远建不起来。
    this.patchPath = patchPath ?? null;

    // Active QR pairing sessions: token -> { createdAt, status, openId, userName }
    this.pairingSessions = new Map();
  }

  /**
   * Register HTTP routes with DSH WebServer
   * @param {object} webServer - DSH WebServer service instance
   * @returns {Function} disposer function
   */
  register(webServer) {
    if (!webServer || typeof webServer.register !== 'function') {
      this.logger.warn?.('WebServer service not available; skipping Feishu REST routes registration.');
      return () => {};
    }

    const unregisters = [];

    // Prefix route: /api/feishu
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

  /**
   * Main request dispatcher
   */
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

  /**
   * Helper to parse JSON request body
   */
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

  /**
   * GET /api/feishu/config - Read configuration with masked secrets
   */
  async handleGetConfig(req, res) {
    const safeConfig = { ...this.config };
    const hasSecret = Boolean(safeConfig.appSecret && safeConfig.appSecret.length > 0);
    // Mask secret: keep first 3 and last 3 chars if long enough
    if (hasSecret) {
      const sec = safeConfig.appSecret;
      safeConfig.appSecretMasked = sec.length > 6
        ? `${sec.slice(0, 3)}••••••••${sec.slice(-3)}`
        : '••••••••';
    } else {
      safeConfig.appSecretMasked = '';
    }
    delete safeConfig.appSecret; // Do not return raw secret
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

  /**
   * POST /api/feishu/config - Save and apply updated configuration
   */
  async handleSaveConfig(req, res) {
    const body = await this.parseJsonBody(req);

    // Merge incoming config
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

    // Persist to DSH cordis.patch.yml if available
    try {
      const fs = await import('node:fs');
      const patchPath = this.patchPath;
      if (patchPath && fs.existsSync(patchPath)) {
        let content = fs.readFileSync(patchPath, 'utf-8');
        // Update appId and appSecret in patch
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

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, ok: true, message: 'Settings saved and applied successfully' }));
  }

  /**
   * POST /api/feishu/test - Test credentials validity with Feishu Open API
   */
  async handleTestConnection(req, res) {
    const body = await this.parseJsonBody(req);
    const appId = body.appId || this.config.appId;
    let appSecret = body.appSecret;
    if (!appSecret || appSecret.includes('••••')) {
      appSecret = this.config.appSecret;
    }

    if (!appId || !appSecret) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 400, error: 'App ID and App Secret are required for testing' }));
      return;
    }

    try {
      // Step 1: Request tenant_access_token from Feishu Open API
      const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const tokenData = await tokenResp.json();

      if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: tokenData.code || -1,
          ok: false,
          error: `Feishu Auth Failed: ${tokenData.msg || 'Invalid App ID or App Secret'}`,
        }));
        return;
      }

      const tenantToken = tokenData.tenant_access_token;

      // Step 2: Fetch Bot information to display app name & avatar in UI
      const botResp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${tenantToken}` },
      });
      const botData = await botResp.json();

      const botInfo = botData.bot || {
        app_name: 'Feishu Bot',
        avatar_url: '',
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        ok: true,
        message: 'Connection verified successfully!',
        bot: {
          name: botInfo.app_name,
          avatarUrl: botInfo.avatar_url,
          openMode: botInfo.open_id ? 'active' : 'ready',
        },
      }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: -1,
        ok: false,
        error: `Network error connecting to Feishu: ${err.message}`,
      }));
    }
  }

  /**
   * GET /api/feishu/qr/generate - Generate a pairing token and QR code SVG
   */
  async handleGenerateQr(req, res) {
    const token = crypto.randomBytes(16).toString('hex');
    const appId = this.config.appId || '';

    // Clean up expired sessions (> 10 mins)
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

    // Generate pairing URL that can be scanned by Feishu mobile app
    // When opened in Feishu, triggers bot conversation with pairing payload
    const pairingUrl = appId
      ? `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(appId)}&mode=pair&token=${token}`
      : `feishu-dsh://pair?token=${token}`;

    const svg = generateQrSvg(pairingUrl, {
      size: 220,
      fgColor: '#3370ff', // Feishu brand blue
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

  /**
   * GET /api/feishu/qr/poll?token=xxx - Poll pairing status
   */
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

  /**
   * Called by WS Gateway or webhook when user sends pairing confirmation
   * @param {string} token
   * @param {object} userInfo - { openId, userName }
   */
  confirmPairing(token, userInfo) {
    const session = this.pairingSessions.get(token);
    if (!session) return false;

    session.status = 'scanned';
    session.openId = userInfo.openId;
    session.userName = userInfo.userName;

    // Automatically bind ownerId if not yet set
    if (!this.config.ownerId && userInfo.openId) {
      this.config.ownerId = userInfo.openId;
      if (typeof this.onConfigUpdate === 'function') {
        this.onConfigUpdate(this.config);
      }
    }
    return true;
  }
}
