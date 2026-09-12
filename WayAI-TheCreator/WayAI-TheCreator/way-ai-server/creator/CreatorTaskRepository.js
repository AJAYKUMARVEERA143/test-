"use strict";

const { v4: uuidv4 } = require("uuid");

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

class CreatorTaskRepository {
  constructor(db) {
    if (!db?.execute) throw new TypeError("CreatorTaskRepository requires a database pool");
    this.db = db;
  }

  async create(userId, { projectId = null, taskType, mediaType, resourceId, resourceType, payload = {}, dependencyTaskId = null, dependencyGroup = null }) {
    const id = uuidv4();
    try {
      await this.db.execute(
        `INSERT INTO creator_generation_tasks
         (id, user_id, project_id, task_type, media_type, resource_id, resource_type, payload_json, dependency_task_id, dependency_group)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, userId, projectId, taskType, mediaType, resourceId, resourceType, JSON.stringify(payload || {}), dependencyTaskId, dependencyGroup],
      );
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") {
        err.message = `A task is already active for resource ${resourceId} (${taskType})`;
      }
      throw err;
    }
    return this.getById(userId, id);
  }

  async getById(userId, id) {
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_generation_tasks WHERE id=? AND user_id=? LIMIT 1`,
      [id, userId],
    );
    return rows[0] || null;
  }

  // No userId scoping — this is the internal worker-claim path, not a user-facing
  // read; the worker processes tasks across all users, one media_type channel at
  // a time. Claiming is atomic even if more than one worker is ever running
  // against this channel concurrently: the candidate id is read first, then the
  // UPDATE re-checks status='queued' for that exact id — if another worker won
  // the race in between, affectedRows is 0 and this worker gets nothing back
  // rather than two workers believing they both claimed the same task.
  async claimNext(mediaType) {
    const [candidates] = await this.db.execute(
      `SELECT id FROM creator_generation_tasks WHERE media_type=? AND status='queued' ORDER BY created_at ASC LIMIT 1`,
      [mediaType],
    );
    const candidateId = candidates[0]?.id;
    if (!candidateId) return null;
    const [result] = await this.db.execute(
      `UPDATE creator_generation_tasks SET status='running', started_at=NOW(6) WHERE id=? AND status='queued'`,
      [candidateId],
    );
    if (!result.affectedRows) return null;
    return this._getRaw(candidateId);
  }

  // Crash-recovery scan: tasks left 'running' by a prior process for this
  // channel, to be resumed (polled via their persisted provider_job_id) rather
  // than claimed fresh or resubmitted.
  async listRunningByMediaType(mediaType) {
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_generation_tasks WHERE media_type=? AND status='running' ORDER BY started_at ASC`,
      [mediaType],
    );
    return rows;
  }

  async listByProject(userId, projectId, { status } = {}) {
    const values = [userId, projectId];
    let extra = "";
    if (status) { extra = " AND status=?"; values.push(status); }
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_generation_tasks WHERE user_id=? AND project_id=?${extra} ORDER BY created_at DESC`,
      values,
    );
    return rows;
  }

  async listSince(userId, projectId, sinceId) {
    const values = [userId, projectId];
    let extra = "";
    if (sinceId) { extra = " AND id > ?"; values.push(sinceId); }
    // id is a UUID (not sortable by string comparison as a real "since" cursor),
    // so sinceId here is treated as a created_at-ordered position via a subquery
    // instead of a naive id > ? string compare.
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_generation_tasks
       WHERE user_id=? AND project_id=?
       ${sinceId ? "AND created_at > (SELECT created_at FROM creator_generation_tasks WHERE id=? LIMIT 1)" : ""}
       ORDER BY created_at ASC`,
      sinceId ? [userId, projectId, sinceId] : [userId, projectId],
    );
    return rows;
  }

  async markCompleted(id, result) {
    await this.db.execute(
      `UPDATE creator_generation_tasks SET status='completed', completed_at=NOW(6), result_json=? WHERE id=?`,
      [JSON.stringify(result ?? {}), id],
    );
    return this._getRaw(id);
  }

  async markFailed(id, { errorCode = "unknown_error", errorMessage = "" } = {}) {
    await this.db.execute(
      `UPDATE creator_generation_tasks SET status='failed', completed_at=NOW(6), error_code=?, error_message=? WHERE id=?`,
      // The id was missing here (3 placeholders, 2 values): MySQL rejected the
      // statement, the task stayed 'running', was re-picked on every restart,
      // and the unhandled rejection took the whole API process down each time.
      [String(errorCode || "unknown_error").slice(0, 64), String(errorMessage ?? "").slice(0, 60000), id],
    );
    return this._getRaw(id);
  }

  async cancel(userId, id) {
    const [result] = await this.db.execute(
      `UPDATE creator_generation_tasks SET status='cancelled', completed_at=NOW(6)
       WHERE id=? AND user_id=? AND status NOT IN ('completed','failed','cancelled')`,
      [id, userId],
    );
    return Number(result.affectedRows || 0) === 1;
  }

  // Called immediately after a submit-then-poll provider call actually reaches
  // the provider — before awaiting completion — so a server restart mid-flight
  // doesn't lose the ability to reconnect (poll, don't resubmit) instead of
  // risking a duplicate paid job.
  async attachProviderJob(id, { providerId, providerJobId, providerEndpoint, submittedBaseUrl }) {
    await this.db.execute(
      `UPDATE creator_generation_tasks SET provider_id=?, provider_job_id=?, provider_endpoint=?, submitted_base_url=? WHERE id=?`,
      [providerId, providerJobId, providerEndpoint, submittedBaseUrl, id],
    );
    return this._getRaw(id);
  }

  isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
  }

  async _getRaw(id) {
    const [rows] = await this.db.execute(`SELECT * FROM creator_generation_tasks WHERE id=? LIMIT 1`, [id]);
    return rows[0] || null;
  }
}

module.exports = { CreatorTaskRepository };
