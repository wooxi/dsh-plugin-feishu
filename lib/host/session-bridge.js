/**
 * SessionBridge
 * 把飞书入站消息投递进 DSH 宿主会话。
 *
 * 设计对照：dsh-feishu-cui lib/infra/host/session.js（prompt 部分）
 *
 * DSH 事实（源码考证 @deepseek-ai/dsh-api-session-controller/lib/types/index.d.ts:18）：
 * - 宿主**确实**注册了 `sessionController` 服务，但它是 Cordis 服务，必须在插件里
 *   `export const inject = [..., 'sessionController']` 声明后才能访问；
 *   未声明时 ctx 代理会抛 `cannot get property "sessionController" without inject`
 *   （cordis/lib/index.js:676）。此前把 inject 清空是错误方向。
 * - 投递契约：`sessionController.prompt({ requestId, sessionId, mode, content }, signal)`
 *   → `{ accepted: true }`，宿主按 requestId 去重。
 * - 中止：`sessionController.cancel({ sessionId })`。
 * - 会话解析：`list({})` 取最近会话；`create({ cwd })` 新建。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 不会中止的信号：交给宿主 prompt，避免宿主在自身生命周期外被外部 signal 打断。 */
const NEVER_ABORTED = new AbortController().signal;

/** 每个会话一页拉多少条。 */
const LIST_LIMIT_NOTE = 1;

export class SessionBridge {
  constructor(options = {}) {
    this.ctx = options.ctx;
    this.logger = options.logger || console;
    this.defaultSessionId = options.defaultSessionId || '';
    this.defaultCwd = options.defaultCwd || '/dsh-workspace';
    /** 飞书会话归属的 DSH 工作区目录（UI 里那一栏分组）。 */
    this.workspacePath = options.workspacePath || this.defaultCwd;
    /** 已解析到的工作区 ID，避免每条消息都去注册一次。 */
    this.workspaceId = '';
    /** 绑定表落盘目录；为空则只在内存里记。 */
    this.storageDir = options.storageDir || '';
    this.bindingsPath = this.storageDir ? join(this.storageDir, 'session-bindings.json') : '';

    /** 飞书 chatId -> DSH sessionId */
    this.chatSessionMap = new Map();
    /** 已警告过的键，同一件事只警告一次。 */
    this.warned = new Set();

    this.loadBindings();
  }

  /**
   * 从磁盘恢复 chatId → sessionId 绑定。
   *
   * 这张表是「同一飞书会话永远回到同一个 DSH 会话」的唯一保证：
   * 宿主重启后内存态全丢，只靠派生 ID 会在工作区/配置变动时错开。
   */
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
      // 首次运行没有文件是正常的，其他读取错误才值得报。
      if (err?.code !== 'ENOENT') {
        this.logger.warn?.(`[SessionBridge] 读取会话绑定表失败: ${err?.message ?? err}`);
      }
    }
  }

  /** 把绑定表写回磁盘（失败不影响主流程）。 */
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

  /** 借宿主服务本身；没挂载时返回 undefined（ctx.get 不会抛）。 */
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

  /** 借服务上绑好 this 的方法；没服务或没该方法时 undefined。 */
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

  /**
   * 把飞书专用目录注册成 DSH 工作区（幂等），返回 workspaceId。
   *
   * DSH 的 `sessionController.create` 支持 `{ workspaceId }` 或 `{ cwd }`，
   * 但只有 workspaceId 会让会话出现在设置/侧栏的某个工作区分组下；
   * 只传 cwd 的会话一律落在「未分组」。
   *
   * @returns {Promise<string>} workspaceId；不可用时为空串
   */
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

  /**
   * 拉一次会话列表（过滤掉 subagent 与子会话）。
   *
   * @returns {Promise<Array|null>} 会话数组；`null` 表示宿主没提供 list（无法校验）。
   */
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

  /**
   * 在会话列表里找回这个飞书会话应该续用的 DSH 会话。
   *
   * 候选顺序（都是「这个 chat 专属」的 ID，绝不碰用户自己的 Web 会话）：
   * 1. 绑定表里记下的 ID（最权威）
   * 2. 当前目录派生的 ID
   * 3. 旧版本不带目录指纹的 ID（迁移用）
   *
   * 目录不符的一律跳过——否则会把旧目录里的会话拽到新目录，agent 在错的地方干活。
   *
   * @param {string} chatId
   * @returns {Promise<string>} 命中的 sessionId；没命中为空串
   */
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

    // 4. 兜底：这个工作区本来就只给飞书用，接上里面最近的会话总好过又开一个新的。
    //    宿主在 workspace.sessionIds 尚未就绪时会把我们指定的 sessionId 换成随机 ID
    //    （dsh-api-session-controller/lib/index.js:755-775 的 reusable 判定），
    //    那种会话只能靠「最近活跃」认回来，否则每次重启都会多一个空会话。
    const sameCwd = items.filter((s) => !wantedCwd || !s.cwd || s.cwd === wantedCwd);
    const newest = sameCwd.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (newest?.sessionId) {
      this.logger.info?.(`[SessionBridge] 未按 ID 命中，接上工作区最近会话: ${newest.sessionId}`);
      return newest.sessionId;
    }
    return '';
  }

  /** 把 chatId 收敛成可做 ID 的字符集。 */
  sanitizeKey(chatId) {
    return String(chatId || 'default')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 40);
  }

  /**
   * 解析要投递的会话 ID。
   *
   * 顺序：内存/磁盘绑定 → 会话列表里找回 → 新建。
   *
   * @param {string} chatId 飞书 chatId（用于绑定查找）
   * @returns {Promise<string>} 会话 ID；完全无法解析时为空串
   */
  async resolveSessionId(chatId) {
    // 显式配置了默认会话就直接用它：这是管理员写死的意图，不该被自动解析覆盖。
    if (this.defaultSessionId) return this.defaultSessionId;

    // 1. 已有绑定（内存或磁盘恢复的）→ 直接续用，这是常态。
    //    只有「列表明确不含该 ID」才认定会话已死；拿不到列表时信任绑定，
    //    否则宿主一旦不提供 list，同一会话每来一条消息都会新建一次。
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

    // 2. 列表里按 ID 找回（覆盖重启后绑定表丢失、ID 格式升级等情况）。
    const existing = await this.findExistingSession(chatId);
    if (existing) {
      this.logger.info?.(`[SessionBridge] 续用已有会话: ${existing}`);
      this.bindSession(chatId, existing);
      return existing;
    }

    // 3. 确实没有 → 新建一个专属会话。
    return this.createSession(chatId);
  }

  /**
   * 新建一个专属会话。
   *
   * 飞书通道使用**固定且专属**的会话 ID，绝不复用用户正在用的 Web 会话：
   * 否则飞书消息会插进人的浏览器会话里，且回复会错投。
   *
   * @param {string} chatId
   * @returns {Promise<string>}
   */
  async createSession(chatId) {
    const create = this.method('sessionController', 'create');
    if (!create) return '';

    // 先把目录注册成 DSH 工作区，会话按 workspaceId 归属；
    // 否则 create({cwd}) 建出来的会话在 Web 侧落在「未分组」里。
    const workspaceId = await this.ensureWorkspace();
    const desired = this.deriveSessionId(chatId);

    /** 组一次 create 请求：workspaceId 与 cwd 互斥。 */
    const buildRequest = (sessionId) =>
      workspaceId ? { workspaceId, sessionId } : { cwd: this.defaultCwd, sessionId };

    try {
      const value = await create(buildRequest(desired));
      const id = value?.sessionId || desired;
      if (id !== desired) {
        // 宿主换了 ID：说明该 sessionId 当时不可复用（典型是 workspace 尚未加载完）。
        // 这里如实记录，绑定表会记住真实 ID，后续就稳定了。
        this.logger.warn?.(
          `[SessionBridge] 宿主把会话 ID 从 ${desired} 换成了 ${id}（工作区未就绪或 ID 已归档）`,
        );
      }
      this.logger.info?.(
        `[SessionBridge] 新建飞书会话: ${id}${workspaceId ? `（工作区 ${workspaceId}）` : '（未分组）'}`,
      );
      this.bindSession(chatId, id);
      return id;
    } catch (err) {
      const reason = err?.message ?? String(err);

      // 同一个 sessionId 已经属于另一个目录时，宿主会抛
      // ApiSessionCwdConflict：「session "x" belongs to "/a", not "/b"」。
      // 这通常发生在工作区目录被改过之后——旧 ID 认了新目录，撞车。
      if (/belongs to/i.test(reason)) {
        const retried = `${desired}-${Date.now().toString(36)}`;
        this.logger.info?.(`[SessionBridge] 会话 ID 与其他工作区冲突，改用 ${retried} 重试`);
        try {
          const value = await create(buildRequest(retried));
          const id = value?.sessionId || retried;
          this.bindSession(chatId, id);
          return id;
        } catch (retryErr) {
          this.warnOnce('create-conflict', `[SessionBridge] 换 ID 重试仍失败: ${retryErr?.message ?? retryErr}`);
        }
      }

      this.warnOnce('create', `[SessionBridge] 新建会话失败: ${reason}`);

      // 最后兜底：在本工作区里找一个已有会话复用，别让消息直接丢掉。
      const reused = await this.findReusableSession();
      if (reused) {
        this.logger.info?.(`[SessionBridge] 复用工作区已有会话: ${reused}`);
        this.bindSession(chatId, reused);
        return reused;
      }
      return '';
    }
  }

  /**
   * 由 chatId 派生稳定的会话 ID，并带上工作区指纹。
   *
   * 指纹的意义：工作区目录一改，ID 就变，天然避开 ApiSessionCwdConflict；
   * 同时同一个工作区里重启重连仍然复用同一个会话。
   *
   * @param {string} chatId
   * @returns {string}
   */
  deriveSessionId(chatId) {
    if (this.defaultSessionId) return this.defaultSessionId;
    return `feishu-${this.workspaceFingerprint()}-${this.sanitizeKey(chatId)}`;
  }

  /** 工作区路径的稳定短指纹（djb2）。 */
  workspaceFingerprint() {
    const src = String(this.workspacePath || this.defaultCwd || '');
    let h = 5381;
    for (let i = 0; i < src.length; i += 1) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 6);
  }

  /**
   * 在本工作区里找一个可复用的会话（最近更新的那个）。
   * @returns {Promise<string>}
   */
  async findReusableSession() {
    const items = await this.listSessions();
    if (!items || !items.length) return '';
    const want = String(this.workspacePath || '');
    const match = items
      .filter((s) => !want || !s.cwd || s.cwd === want)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    return match?.sessionId ?? '';
  }

  /**
   * 把一段文本投递给会话。
   *
   * @param {object} params
   * @param {string} [params.sessionId] 目标会话；省略时按 chatId 解析
   * @param {string} [params.chatId] 飞书 chatId，用于会话绑定
   * @param {string} params.text 正文
   * @param {'queue'|'steer'} [params.mode]
   * @param {Array<{path?: string, type?: string}>} [params.attachments]
   * @returns {Promise<{success: boolean, sessionId?: string, error?: string}>}
   */
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

  /**
   * 中止会话当前这一轮。
   *
   * @param {string} [sessionId]
   * @param {string} [chatId]
   */
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

  /**
   * 撤销排队里还没跑的一条消息。
   *
   * @param {string} sessionId
   * @param {string} itemId
   */
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
