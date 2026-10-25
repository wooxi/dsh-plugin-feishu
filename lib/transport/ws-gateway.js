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

    emit(level, message) {
    try {
      this.logger?.[level]?.(message);
    } catch {}
    if (level === 'error') process.stderr.write(`[WsGateway] ${message}\n`);
    else if (level !== 'debug') process.stdout.write(`[WsGateway] ${message}\n`);
  }

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

    status() {
    return this.lastStatus;
  }
}
