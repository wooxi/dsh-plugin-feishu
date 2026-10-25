/**
 * Inbound Admission & Security Controller
 */
export class AdmissionController {
  constructor(options = {}) {
    this.ownerId = options.ownerId || '';
    this.botOpenId = options.botOpenId || '';
    this.enableGroupChat = Boolean(options.enableGroupChat);
    this.dmPolicy = options.dmPolicy || (this.ownerId ? 'owner' : 'open');
    this.maxAgeMs = options.maxAgeMs ?? 120000; // 2 minutes age tolerance

    // LRU set for message deduplication
    this.seenMessageIds = new Set();
    this.maxCacheSize = 2000;
  }

  setOwnerId(id) {
    this.ownerId = id;
  }

  setBotOpenId(id) {
    this.botOpenId = id;
  }

  /**
   * Check if inbound message event is admitted for processing
   * @param {object} eventPayload - event content from feishu im.message.receive_v1
   * @returns {{ allowed: boolean, reason?: string, isFirstBinding?: boolean }}
   */
  check(eventPayload) {
    const sender = eventPayload.sender || {};
    const message = eventPayload.message || {};
    const senderOpenId = sender.sender_id?.open_id || '';
    const messageId = message.message_id || '';
    const chatType = message.chat_type || 'p2p';

    // 1. Loopback check: don't process bot's own echo
    if (this.botOpenId && senderOpenId === this.botOpenId) {
      return { allowed: false, reason: 'loopback_bot_self' };
    }

    // 2. Message deduplication check (strict idempotency)
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

    // 3. Message age check (with millisecond/second normalization)
    if (message.create_time) {
      let createTime = Number(message.create_time);
      if (!Number.isNaN(createTime)) {
        // Normalize 10-digit unix seconds to 13-digit milliseconds
        if (createTime < 1e11) {
          createTime *= 1000;
        }
        const now = Date.now();
        // Allow up to maxAgeMs skew in the past, and up to 30s future clock skew
        if (now - createTime > this.maxAgeMs && now - createTime < 86400000) {
          return { allowed: false, reason: 'message_too_old' };
        }
      }
    }

    // 4. Group chat checks
    if (chatType === 'group') {
      if (!this.enableGroupChat) {
        return { allowed: false, reason: 'group_chat_disabled' };
      }
      // In group chat, if botOpenId is known, check if bot is @mentioned
      const mentions = message.mentions || [];
      if (this.botOpenId) {
        const mentionedBot = mentions.some((m) => m.id?.open_id === this.botOpenId);
        if (!mentionedBot) {
          return { allowed: false, reason: 'not_mentioned' };
        }
      }
      return { allowed: true };
    }

    // 5. P2P Direct chat checks
    if (this.dmPolicy === 'open') {
      if (!this.ownerId) {
        this.ownerId = senderOpenId;
        return { allowed: true, isFirstBinding: true };
      }
      return { allowed: true };
    }

    // dmPolicy === 'owner': only bound administrator can direct chat
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
