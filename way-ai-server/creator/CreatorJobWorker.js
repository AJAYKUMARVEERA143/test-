"use strict";

const { RpmLimiter } = require("./RpmLimiter.js");
const { CREATOR_PROJECT_LEVEL_SEGMENT_KEY } = require("./CreatorApiCallRepository.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One worker per media_type channel (image/video/audio/text), each with its own
// RPM limiter — mirrors server/agents/AgentWorker.js's shape, adapted for an
// async MySQL-backed store instead of a sync in-memory Map, and adapted for
// submit-then-poll providers (a claimed task isn't done when the claim loop
// moves on — it keeps polling in the background up to maxConcurrent at a time,
// so one slow video generation doesn't stall the whole channel).
class CreatorJobWorker {
  constructor({ mediaType, taskRepo, apiCallRepo, providers, rpmLimit = 20, maxConcurrent = 3, pollIntervalMs = 1000 }) {
    this.mediaType = mediaType;
    this.taskRepo = taskRepo;
    this.apiCallRepo = apiCallRepo;
    this.providers = providers; // { [task_type]: { submit, poll, PROVIDER_ID, estimateCost? } }
    this.rpmLimiter = new RpmLimiter(rpmLimit);
    this.maxConcurrent = maxConcurrent;
    this.pollIntervalMs = pollIntervalMs;
    this.running = false;
    this.activeCount = 0;
    this._loopPromise = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    // Recover any tasks left 'running' by a prior crash for this channel before
    // claiming fresh work — resumed via their persisted provider_job_id, never
    // resubmitted.
    const orphaned = await this.taskRepo.listRunningByMediaType?.(this.mediaType) || [];
    for (const task of orphaned) {
      if (this.activeCount >= this.maxConcurrent) break;
      this._spawn(task);
    }
    this._loopPromise = this._loop();
  }

  stop() {
    this.running = false;
  }

  async _loop() {
    while (this.running) {
      if (this.activeCount < this.maxConcurrent) {
        const task = await this.taskRepo.claimNext(this.mediaType).catch(() => null);
        if (task) {
          this._spawn(task);
          continue;
        }
      }
      await sleep(this.pollIntervalMs);
    }
  }

  _spawn(task) {
    this.activeCount += 1;
    // A background task must never be able to take the API process down: an
    // uncaught rejection here used to crash Node, so every in-flight request
    // (Google sign-in included) came back as a bare 503 / "Failed to fetch".
    this._process(task)
      .catch((error) => console.error(`[creator:${this.mediaType}] task ${task?.id} failed:`, error?.message || error))
      .finally(() => {
        this.activeCount -= 1;
      });
  }

  async _process(task) {
    const provider = this.providers[task.task_type];
    if (!provider) {
      await this.taskRepo.markFailed(task.id, { errorCode: "unknown_task_type", errorMessage: `No provider registered for task_type "${task.task_type}"` });
      return;
    }
    let payload;
    try {
      payload = typeof task.payload_json === "string" ? JSON.parse(task.payload_json) : (task.payload_json || {});
    } catch {
      await this.taskRepo.markFailed(task.id, { errorCode: "bad_payload", errorMessage: "Task payload is not valid JSON" });
      return;
    }

    try {
      let current = task;
      if (!current.provider_job_id) {
        await this.rpmLimiter.acquire();
        const submission = await provider.submit(payload);
        current = await this.taskRepo.attachProviderJob(task.id, submission);
      }

      let backoffMs = 1000;
      for (;;) {
        const outcome = await provider.poll(current);
        if (outcome.done) {
          await this.apiCallRepo.recordCall(task.user_id, {
            projectId: task.project_id,
            taskId: task.id,
            segmentId: payload.segmentId || CREATOR_PROJECT_LEVEL_SEGMENT_KEY,
            callType: this.mediaType,
            provider: provider.PROVIDER_ID,
            model: payload.model || provider.PROVIDER_ID,
            costAmount: payload.estimatedCostAmount || 0,
            currency: payload.estimatedCostCurrency || "USD",
            isEstimate: false,
          });
          await this.taskRepo.markCompleted(task.id, outcome);
          return;
        }
        await sleep(backoffMs);
        backoffMs = Math.min(10000, backoffMs * 1.5);
      }
    } catch (error) {
      await this.taskRepo.markFailed(task.id, { errorCode: error?.name || "provider_error", errorMessage: error?.message || String(error) });
    }
  }
}

class CreatorJobWorkerPool {
  constructor({ taskRepo, apiCallRepo, channels }) {
    // channels: [{ mediaType, providers, rpmLimit, maxConcurrent }]
    this.workers = channels.map((channel) => new CreatorJobWorker({ taskRepo, apiCallRepo, ...channel }));
  }

  async start() {
    for (const worker of this.workers) await worker.start();
  }

  stop() {
    this.workers.forEach((worker) => worker.stop());
  }
}

module.exports = { CreatorJobWorker, CreatorJobWorkerPool };
