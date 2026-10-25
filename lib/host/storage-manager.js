import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Feishu Channel Dedicated Storage & Log Manager
 * Manages dedicated workspace directory for Feishu attachments, audit logs, and artifacts.
 */
export class FeishuStorageManager {
  constructor(options = {}) {
    this.workspaceDir = resolve(options.workspaceDir || '/dsh-workspace/feishu-storage');
    this.attachmentsDir = join(this.workspaceDir, 'attachments');
    this.logsDir = join(this.workspaceDir, 'logs');
    this.artifactsDir = join(this.workspaceDir, 'artifacts');
    this.messageLogFile = join(this.logsDir, 'feishu-messages.jsonl');
    this.logger = options.logger || console;

    this.ensureDirectories();
  }

  ensureDirectories() {
    try {
      if (!existsSync(this.workspaceDir)) mkdirSync(this.workspaceDir, { recursive: true });
      if (!existsSync(this.attachmentsDir)) mkdirSync(this.attachmentsDir, { recursive: true });
      if (!existsSync(this.logsDir)) mkdirSync(this.logsDir, { recursive: true });
      if (!existsSync(this.artifactsDir)) mkdirSync(this.artifactsDir, { recursive: true });
      this.logger.info?.(`[FeishuStorageManager] Dedicated storage initialized at ${this.workspaceDir}`);
    } catch (err) {
      this.logger.error?.('[FeishuStorageManager] Failed to create directories:', err);
    }
  }

  setWorkspaceDir(newDir) {
    if (!newDir || newDir === this.workspaceDir) return;
    this.workspaceDir = resolve(newDir);
    this.attachmentsDir = join(this.workspaceDir, 'attachments');
    this.logsDir = join(this.workspaceDir, 'logs');
    this.artifactsDir = join(this.workspaceDir, 'artifacts');
    this.messageLogFile = join(this.logsDir, 'feishu-messages.jsonl');
    this.ensureDirectories();
  }

  getAttachmentsDir() {
    return this.attachmentsDir;
  }

  getLogsDir() {
    return this.logsDir;
  }

  getArtifactsDir() {
    return this.artifactsDir;
  }

  /**
   * Append an audit entry for inbound or outbound Feishu message
   */
  logMessage({ direction = 'inbound', eventId = '', senderId = '', chatId = '', text = '', type = 'text', metadata = {} }) {
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        direction,
        eventId,
        senderId,
        chatId,
        type,
        text,
        metadata,
      };
      appendFileSync(this.messageLogFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      this.logger.error?.('[FeishuStorageManager] Failed to append message log:', err);
    }
  }
}
