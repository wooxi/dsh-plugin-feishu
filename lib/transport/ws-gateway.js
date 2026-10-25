/**
 * Lark WebSocket Gateway & Event Dispatcher
 *
 * 设计对照：dsh-feishu-cui lib/transport/feishu/websocket-client.js
 * 关键差异（此前实现有误）：
 * - `WSClient.start()` 是长期阻塞调用，**不能 await**（await 会让 apply 永不返回，
 *   或在其提前返回时打印虚假的"连接成功"）。必须 fire-and-forget，靠回调判状态。
 * - 连接是否真的建立只能由 `onReady` / `onError` 回调确认，不能靠 start 的返回。
 * - 用 `autoReconnect` + `pingTimeout` 让 SDK 自己维持连接。
 */

/** 发出去的 ping 等这么久（秒）还没收到回帧，判定连接已死并重连。 */
export const WS_PING_TIMEOUT_SEC = 15;

export class WsGateway {
  constructor(options = {}) {
    this.client = options.client;
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus || (() => {});
    this.logger = options.logger || console;

    this.isRunning = false;
    this.wsClient = null;
    this.lastStatus = { connected: false, state: 'idle' };

    this.processedEvents = new Set();
    this.maxEventCache = 2000;
  }

  /**
   * 双写日志：ctx.logger 未必挂 exporter，长连接状态必须无条件可见，
   * 所以关键节点同时写 stderr/stdout。
   *
   * @param {'info'|'warn'|'error'|'debug'} level
   * @param {string} message
   */
  emit(level, message) {
    try {
      this.logger?.[level]?.(message);
    } catch {}
    if (level === 'error') process.stderr.write(`[WsGateway] ${message}\n`);
    else if (level !== 'debug') process.stdout.write(`[WsGateway] ${message}\n`);
  }

  /**
   * Handle raw inbound event from WebSocket or Webhook
   * @param {object} payload
   */
  async handleRawEvent(payload) {
    if (!payload || !payload.header) return null;

    const eventId = payload.header.event_id;
    if (eventId) {
      if (this.processedEvents.has(eventId)) {
        this.logger.debug?.(`[WsGateway] Dropping duplicate event: ${eventId}`);
        return null;
      }
      this.processedEvents.add(eventId);
      if (this.processedEvents.size > this.maxEventCache) {
        const oldest = this.processedEvents.values().next().value;
        this.processedEvents.delete(oldest);
      }
    }

    if (this.onEvent) {
      try {
        await this.onEvent(payload);
        return payload;
      } catch (err) {
        this.logger.error?.('[WsGateway] Error processing event:', err);
      }
    }
    return payload;
  }

  /**
   * Start the long-connection client.
   *
   * @param {object} params
   * @param {string} params.appId
   * @param {string} params.appSecret
   * @returns {Promise<{started: boolean, reason?: string}>}
   */
  async start({ appId, appSecret }) {
    if (this.isRunning) return { started: true, reason: 'already-running' };

    if (!appId || !appSecret) {
      const reason = '未配置飞书凭据（appId / appSecret 为空），未建立长连接';
      this.emit('warn', reason);
      this.onStatus({ connected: false, error: reason });
      return { started: false, reason };
    }

    this.isRunning = true;
    this.emit('info', `正在建立飞书长连接（App ID ${String(appId).slice(0, 8)}…）`);

    let lark;
    try {
      lark = await import('@larksuiteoapi/node-sdk');
    } catch (err) {
      this.isRunning = false;
      const reason = `无法加载 @larksuiteoapi/node-sdk: ${err?.message ?? err}`;
      this.emit('error', reason);
      this.onStatus({ connected: false, error: reason });
      return { started: false, reason };
    }

    const sdk = lark?.default ?? lark;
    const { WSClient, EventDispatcher, Domain, LoggerLevel } = sdk;

    if (typeof WSClient !== 'function' || typeof EventDispatcher !== 'function') {
      this.isRunning = false;
      const reason = '@larksuiteoapi/node-sdk 缺少 WSClient / EventDispatcher 导出';
      this.emit('error', reason);
      this.onStatus({ connected: false, error: reason });
      return { started: false, reason };
    }

    const dispatcher = new EventDispatcher({});

    // 收消息：SDK 把 v2 事件 payload 直接交给 handler（形如 { sender, message }）。
    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        const eventId = data?.event_id || data?.header?.event_id || `msg_${Date.now()}`;
        const eventData = data?.message ? data : (data?.event ?? data);
        this.emit(
          'info',
          `收到 im.message.receive_v1 event_id=${eventId} ` +
          `sender=${eventData?.sender?.sender_id?.open_id ?? '(unknown)'} ` +
          `type=${eventData?.message?.message_type ?? '(unknown)'}`,
        );
        await this.handleRawEvent({
          header: { event_id: eventId, event_type: 'im.message.receive_v1' },
          event: eventData,
        });
      },
      'card.action.trigger': async (data) => {
        const eventId = data?.event_id || data?.header?.event_id || `card_${Date.now()}`;
        const eventData = data?.action ? data : (data?.event ?? data);
        this.emit('info', `收到 card.action.trigger event_id=${eventId}`);
        return await this.handleRawEvent({
          header: { event_id: eventId, event_type: 'card.action.trigger' },
          event: eventData,
        });
      },
    });

    try {
      this.wsClient = new WSClient({
        appId,
        appSecret,
        domain: Domain?.Feishu,
        loggerLevel: LoggerLevel?.info,
        autoReconnect: true,
        wsConfig: { pingTimeout: WS_PING_TIMEOUT_SEC },
        onReady: () => {
          this.lastStatus = { connected: true, state: 'ready' };
          this.emit('info', '✅ 飞书长连接已建立，开始监听事件');
          this.onStatus({ connected: true });
        },
        onReconnecting: () => {
          this.lastStatus = { connected: false, state: 'reconnecting' };
          this.emit('warn', '飞书长连接断开，正在重连');
          this.onStatus({ connected: false });
        },
        onReconnected: () => {
          this.lastStatus = { connected: true, state: 'ready' };
          this.emit('info', '飞书长连接已重连');
          this.onStatus({ connected: true });
        },
        onError: (error) => {
          const reason = `长连接错误：${error?.message ?? error}`;
          this.lastStatus = { connected: false, state: 'error', error: reason };
          this.emit('error', reason);
          this.onStatus({ connected: false, error: reason });
        },
      });
    } catch (err) {
      this.isRunning = false;
      const reason = `创建 WSClient 失败: ${err?.message ?? err}`;
      this.emit('error', reason);
      this.onStatus({ connected: false, error: reason });
      return { started: false, reason };
    }

    // 关键：start 是长期阻塞调用，绝不能 await。
    Promise.resolve()
      .then(() => this.wsClient.start({ eventDispatcher: dispatcher }))
      .catch((err) => {
        this.isRunning = false;
        const reason = `长连接启动失败: ${err?.message ?? err}`;
        this.emit('error', reason);
        this.onStatus({ connected: false, error: reason });
      });

    return { started: true };
  }

  /**
   * Stop gateway and cleanup resources
   */
  async stop() {
    this.isRunning = false;
    const client = this.wsClient;
    this.wsClient = null;
    this.lastStatus = { connected: false, state: 'stopped' };
    if (client && typeof client.close === 'function') {
      try {
        await client.close({ force: true });
      } catch (err) {
        this.emit('warn', `关闭 wsClient 出错: ${err?.message ?? err}`);
      }
    }
    this.emit('info', '飞书长连接已停止');
  }

  /** 当前连接状态（供设置页展示）。 */
  status() {
    return this.lastStatus;
  }
}
