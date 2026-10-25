/**
 * FlushController
 * Buffers streaming text chunks and debounces updates to Feishu CardKit API.
 */

export class FlushController {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || 250;
    this.onFlush = options.onFlush;
    this.logger = options.logger || console;

    this.buffer = '';
    this.timer = null;
    this.isFlushing = false;
    this.pendingFlush = false;
  }

  /**
   * Push an incoming string chunk into buffer
   * @param {string} chunk
   */
  push(chunk) {
    if (!chunk) return;
    this.buffer += chunk;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => {
        this.logger.error?.('[FlushController] Error in scheduled flush:', err);
      });
    }, this.intervalMs);
  }

  /**
   * Flush all buffered chunks immediately
   */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.isFlushing) {
      this.pendingFlush = true;
      return;
    }

    if (!this.buffer) return;

    const toSend = this.buffer;
    this.buffer = '';
    this.isFlushing = true;

    try {
      if (this.onFlush) {
        await this.onFlush(toSend);
      }
    } finally {
      this.isFlushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        await this.flush();
      }
    }
  }

  /**
   * Stop timer and reset
   */
  dispose() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }
}
