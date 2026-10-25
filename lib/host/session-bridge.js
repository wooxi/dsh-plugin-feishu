import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NEVER_ABORTED = new AbortController().signal;

const LIST_LIMIT_NOTE = 1;

export class SessionBridge {
  constructor(options = {}) {
    this.ctx = options.ctx;
    this.logger = options.logger || console;
    this.defaultSessionId = options.defaultSessionId || '';
    this.defaultCwd = options.defaultCwd || '/dsh-workspace';
        this.workspacePath = options.workspacePath || this.defaultCwd;
        this.workspaceId = '';
        this.storageDir = options.storageDir || '';
    this.bindingsPath = this.storageDir ? join(this.storageDir, 'session-bindings.json') : '';

        this.chatSessionMap = new Map();
        this.warned = new Set();

    this.loadBindings();
  }

    loadBindings() {
    if (!this.bindingsPath) return;
    try {
      const data = JSON.parse(readFileSync(this.bindingsPath, 'utf8'));
      for (const [chatId, sessionId] of Object.entries(data || {})) {
        if (typeof chatId === 'string' && typeof sessionId === 'string' && sessionId) {
          this.chatSessionMap.set(chatId, sessionId);
        }
      }
      if (this.chatSessionMap.size) {
        this.logger.info?.(`[SessionBridge] 已从磁盘恢复 ${this.chatSessionMap.size} 条会话绑定`);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.logger.warn?.(`[SessionBridge] 读取会话绑定表失败: ${err?.message ?? err}`);
      }
    }
  }

    saveBindings() {
    if (!this.bindingsPath) return;
    try {
      mkdirSync(this.storageDir, { recursive: true });
      writeFileSync(
        this.bindingsPath,
        JSON.stringify(Object.fromEntries(this.chatSessionMap), null, 2),
        'utf8',
      );
    } catch (err) {
      this.warnOnce('save-bindings', `[SessionBridge] 写入会话绑定表失败: ${err?.message ?? err}`);
    }
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn?.(message);
  }

    service(name) {
    try {
      const live = this.ctx?.get?.(name);
      if (!live) this.warnOnce(name, `[SessionBridge] 宿主没有 ${name} 服务`);
      return live;
    } catch (err) {
      this.warnOnce(name, `[SessionBridge] 取宿主服务 ${name} 失败: ${err?.message ?? err}`);
      return undefined;
    }
  }

    method(name, methodName) {
    const live = this.service(name);
    if (!live) return undefined;
    if (typeof live[methodName] !== 'function') {
      this.warnOnce(`${name}.${methodName}`, `[SessionBridge] 宿主服务 ${name} 没有 ${methodName} 方法`);
      return undefined;
    }
    return live[methodName].bind(live);
  }

  getSessionId(chatId) {
    if (!chatId) return this.defaultSessionId;
    return this.chatSessionMap.get(chatId) || this.defaultSessionId;
  }

  bindSession(chatId, sessionId) {
    if (!chatId || !sessionId) return;
    if (this.chatSessionMap.get(chatId) === sessionId) return;
    this.chatSessionMap.set(chatId, sessionId);
    this.saveBindings();
  }

    async ensureWorkspace() {
    if (this.workspaceId) return this.workspaceId;

    const create = this.method('workspaceController', 'create');
    if (!create) {
      this.warnOnce('workspaceController', '[SessionBridge] 宿主没有 workspaceController，会话将落在「未分组」');
      return '';
    }

    try {
      const value = await create({ path: this.workspacePath });
      const id = value?.workspace?.workspaceId || '';
      if (id) {
        this.workspaceId = id;
        this.logger.info?.(
          `[SessionBridge] 飞书工作区${value.created ? '已创建' : '已存在'}: ${id} → ${this.workspacePath}`,
        );
      }
      return id;
    } catch (err) {
      this.warnOnce('workspace', `[SessionBridge] 注册飞书工作区失败: ${err?.message ?? err}`);
      return '';
    }
  }

    async listSessions() {
    const list = this.method('sessionController', 'list');
    if (!list) return null;
    try {
      const value = await list({}, NEVER_ABORTED);
      return (value?.items ?? []).filter(
        (s) => s?.sessionId && !s.parentSessionId && s.origin !== 'subagent',
      );
    } catch (err) {
      this.warnOnce('list', `[SessionBridge] 列举会话失败: ${err?.message ?? err}`);
      return null;
    }
  }

    async findExistingSession(chatId) {
    const items = await this.listSessions();
    if (!items || !items.length) return '';

    const byId = new Map(items.map((s) => [s.sessionId, s]));
    const wantedCwd = String(this.workspacePath || '');
    const candidates = [
      this.chatSessionMap.get(chatId),
      this.deriveSessionId(chatId),
      `feishu-${this.sanitizeKey(chatId)}`,
    ].filter(Boolean);

    for (const id of candidates) {
      const hit = byId.get(id);
      if (!hit) continue;
      if (wantedCwd && hit.cwd && hit.cwd !== wantedCwd) {
        this.logger.info?.(`[SessionBridge] 会话 ${id} 属于 ${hit.cwd}，与当前工作区不符，跳过`);
        continue;
      }
      return hit.sessionId;
    }

    const sameCwd = items.filter((s) => !wantedCwd || !s.cwd || s.cwd === wantedCwd);
    const newest = sameCwd.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (newest?.sessionId) {
      this.logger.info?.(`[SessionBridge] 未按 ID 命中，接上工作区最近会话: ${newest.sessionId}`);
      return newest.sessionId;
    }
    return '';
  }

    sanitizeKey(chatId) {
    return String(chatId || 'default')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 40);
  }

    async resolveSessionId(chatId) {
    if (this.defaultSessionId) return this.defaultSessionId;

    const bound = this.getSessionId(chatId);
    if (bound) {
      const items = await this.listSessions();
      if (items === null || items.length === 0 || items.some((s) => s.sessionId === bound)) {
        this.bindSession(chatId, bound);
        return bound;
      }
      this.logger.warn?.(`[SessionBridge] 绑定的会话 ${bound} 已不存在，重新解析`);
      this.chatSessionMap.delete(chatId);
      this.saveBindings();
    }

    const existing = await this.findExistingSession(chatId);
    if (existing) {
      this.logger.info?.(`[SessionBridge] 续用已有会话: ${existing}`);
      this.bindSession(chatId, existing);
      return existing;
    }

    return this.createSession(chatId);
  }

    async createSession(chatId) {
    const create = this.method('sessionController', 'create');
    if (!create) return '';

    const workspaceId = await this.ensureWorkspace();

    try {
      const value = await create(workspaceId ? { workspaceId } : { cwd: this.workspacePath || this.defaultCwd });
      const id = value?.sessionId || '';
      if (!id) return '';
      this.logger.info?.(`[SessionBridge] 新建飞书会话: ${id}`);
      this.bindSession(chatId, id);
      return id;
    } catch (err) {
      this.warnOnce('create', `[SessionBridge] 新建会话失败: ${err?.message ?? err}`);
      const reused = await this.findReusableSession();
      if (reused) {
        this.logger.info?.(`[SessionBridge] 复用工作区已有会话: ${reused}`);
        this.bindSession(chatId, reused);
        return reused;
      }
      return '';
    }
  }

    deriveSessionId(chatId) {
    if (this.defaultSessionId) return this.defaultSessionId;
    return `feishu-${this.workspaceFingerprint()}-${this.sanitizeKey(chatId)}`;
  }

    workspaceFingerprint() {
    const src = String(this.workspacePath || this.defaultCwd || '');
    let h = 5381;
    for (let i = 0; i < src.length; i += 1) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 6);
  }

    async findReusableSession() {
    const items = await this.listSessions();
    if (!items || !items.length) return '';
    const want = String(this.workspacePath || '');
    const match = items
      .filter((s) => !want || !s.cwd || s.cwd === want)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    return match?.sessionId ?? '';
  }

    async prompt({ sessionId, chatId, text, mode = 'queue', attachments = [] }) {
    const call = this.method('sessionController', 'prompt');
    if (!call) {
      return {
        success: false,
        error: '宿主没有 sessionController.prompt，请确认插件 inject 声明包含 sessionController',
      };
    }

    const targetSessionId = sessionId || (await this.resolveSessionId(chatId));
    if (!targetSessionId) {
      return { success: false, error: '无法解析目标会话（list/create 均失败）' };
    }

    let promptText = text ?? '';
    for (const att of attachments) {
      if (att?.path) promptText += `\n[附件: @${att.path}]`;
    }
    if (!promptText.trim()) {
      return { success: false, error: '空消息' };
    }

    const requestId = `feishu-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      await call(
        {
          requestId,
          sessionId: targetSessionId,
          mode: mode === 'steer' ? 'steer' : 'queue',
          content: [{ type: 'text', text: promptText }],
        },
        NEVER_ABORTED,
      );
      this.bindSession(chatId, targetSessionId);
      this.logger.info?.(
        `[SessionBridge] 已投递到会话 ${targetSessionId}（requestId=${requestId}, mode=${mode}）`,
      );
      return { success: true, sessionId: targetSessionId };
    } catch (err) {
      this.logger.error?.(`[SessionBridge] prompt 投递失败: ${err?.message ?? err}`);
      return { success: false, error: err?.message ?? String(err) };
    }
  }

    async stopTurn(sessionId, chatId) {
    const call = this.method('sessionController', 'cancel');
    if (!call) return { success: false, error: '宿主没有 sessionController.cancel' };

    const targetSessionId = sessionId || (await this.resolveSessionId(chatId));
    if (!targetSessionId) return { success: false, error: '无法解析目标会话' };

    try {
      await call({ sessionId: targetSessionId });
      this.logger.info?.(`[SessionBridge] 已中止会话 ${targetSessionId} 的当前轮次`);
      return { success: true, sessionId: targetSessionId };
    } catch (err) {
      this.logger.error?.(`[SessionBridge] cancel 失败: ${err?.message ?? err}`);
      return { success: false, error: err?.message ?? String(err) };
    }
  }

    async withdrawQueued(sessionId, itemId) {
    const call = this.method('sessionController', 'updateQueue');
    if (!call) return { success: false, reason: 'unsupported' };
    try {
      await call({ sessionId, itemId, action: { kind: 'remove' } });
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message ?? String(err) };
    }
  }
}
