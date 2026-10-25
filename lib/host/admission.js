export class AdmissionController {
  constructor(options = {}) {
    this.ownerId = options.ownerId || '';
    this.botOpenId = options.botOpenId || '';
    this.enableGroupChat = Boolean(options.enableGroupChat);
    this.dmPolicy = options.dmPolicy || (this.ownerId ? 'owner' : 'open');
    this.maxAgeMs = options.maxAgeMs ?? 120000; 

    const shared = globalThis.__DSH_FEISHU_SEEN_MESSAGES__ ??= new Set();
    this.seenMessageIds = shared;
    this.maxCacheSize = 2000;
  }

  setOwnerId(id) {
    this.ownerId = id;
  }

  setBotOpenId(id) {
    this.botOpenId = id;
  }

    check(eventPayload) {
    const sender = eventPayload.sender || {};
    const message = eventPayload.message || {};
    const senderOpenId = sender.sender_id?.open_id || '';
    const messageId = message.message_id || '';
    const chatType = message.chat_type || 'p2p';

    if (this.botOpenId && senderOpenId === this.botOpenId) {
      return { allowed: false, reason: 'loopback_bot_self' };
    }

    if (messageId) {
      if (this.seenMessageIds.has(messageId)) {
        return { allowed: false, reason: 'duplicate_message' };
      }
      this.seenMessageIds.add(messageId);
      if (this.seenMessageIds.size > this.maxCacheSize) {
        const oldest = this.seenMessageIds.values().next().value;
        this.seenMessageIds.delete(oldest);
      }
    }

    if (message.create_time) {
      let createTime = Number(message.create_time);
      if (!Number.isNaN(createTime)) {
        if (createTime < 1e11) {
          createTime *= 1000;
        }
        const now = Date.now();
        if (now - createTime > this.maxAgeMs && now - createTime < 86400000) {
          return { allowed: false, reason: 'message_too_old' };
        }
      }
    }

    if (chatType === 'group') {
      if (!this.enableGroupChat) {
        return { allowed: false, reason: 'group_chat_disabled' };
      }
      const mentions = message.mentions || [];
      if (this.botOpenId) {
        const mentionedBot = mentions.some((m) => m.id?.open_id === this.botOpenId);
        if (!mentionedBot) {
          return { allowed: false, reason: 'not_mentioned' };
        }
      }
      return { allowed: true };
    }

    if (this.dmPolicy === 'open') {
      if (!this.ownerId) {
        this.ownerId = senderOpenId;
        return { allowed: true, isFirstBinding: true };
      }
      if (this.ownerId !== senderOpenId) {
        return { allowed: false, reason: 'not_owner' };
      }
      return { allowed: true };
    }

    if (!this.ownerId) {
      this.ownerId = senderOpenId;
      return { allowed: true, isFirstBinding: true };
    }

    if (this.ownerId !== senderOpenId) {
      return { allowed: false, reason: 'not_owner' };
    }

    return { allowed: true };
  }
}
