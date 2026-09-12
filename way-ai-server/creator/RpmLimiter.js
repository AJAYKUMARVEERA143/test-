"use strict";

// Simple sliding-window RPM (requests-per-minute) limiter, one instance per
// media_type channel — keeps a channel from hammering a provider faster than
// its rate limit even though tasks are claimed as fast as the worker can poll.
class RpmLimiter {
  constructor(maxPerMinute = 20) {
    this.maxPerMinute = Math.max(1, Number(maxPerMinute) || 20);
    this.timestamps = [];
  }

  // Resolves once it's safe to proceed, waiting if the channel is currently at
  // its per-minute cap.
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((ts) => now - ts < 60000);
      if (this.timestamps.length < this.maxPerMinute) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0];
      const waitMs = Math.max(50, 60000 - (now - oldest));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

module.exports = { RpmLimiter };
