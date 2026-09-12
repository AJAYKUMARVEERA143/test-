"use strict";

const { v4: uuidv4 } = require("uuid");

// Non-shot calls (asset generation, project-level text calls) use this sentinel
// instead of SQL NULL for segment_id, so `GROUP BY segment_id` rollups always
// include them uniformly rather than needing a separate NULL-handling branch.
const CREATOR_PROJECT_LEVEL_SEGMENT_KEY = "__project_level__";

class CreatorApiCallRepository {
  constructor(db) {
    if (!db?.execute) throw new TypeError("CreatorApiCallRepository requires a database pool");
    this.db = db;
  }

  async recordCall(userId, {
    projectId = null, taskId = null, segmentId = CREATOR_PROJECT_LEVEL_SEGMENT_KEY,
    callType, provider, model, costAmount = 0, currency = "USD", isEstimate = false,
    inputTokens = null, outputTokens = null, totalTokens = null,
  }) {
    const id = uuidv4();
    await this.db.execute(
      `INSERT INTO creator_api_calls
       (id, user_id, project_id, task_id, segment_id, call_type, provider, model, cost_amount, currency, is_estimate, input_tokens, output_tokens, total_tokens)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, userId, projectId, taskId, segmentId || CREATOR_PROJECT_LEVEL_SEGMENT_KEY, callType, provider, model, costAmount, currency, isEstimate ? 1 : 0, inputTokens, outputTokens, totalTokens],
    );
    const [rows] = await this.db.execute(`SELECT * FROM creator_api_calls WHERE id=? LIMIT 1`, [id]);
    return rows[0] || null;
  }

  // Always grouped by currency — costs in different currencies are never summed
  // together into one misleading number. projectId=null rolls up the global
  // (cross-project) scope — `project_id=?` would never match NULL rows under
  // SQL's normal NULL semantics, so this branches to `IS NULL` instead.
  async rollupByProject(userId, projectId, { isEstimate } = {}) {
    const values = [userId];
    const scopeClause = projectId ? "project_id=?" : "project_id IS NULL";
    if (projectId) values.push(projectId);
    let extra = "";
    if (isEstimate !== undefined) { extra = " AND is_estimate=?"; values.push(isEstimate ? 1 : 0); }
    const [rows] = await this.db.execute(
      `SELECT currency, is_estimate, SUM(cost_amount) AS total_cost, COUNT(*) AS call_count
       FROM creator_api_calls WHERE user_id=? AND ${scopeClause}${extra}
       GROUP BY currency, is_estimate`,
      values,
    );
    return rows;
  }

  async rollupBySegment(userId, projectId, segmentId, { isEstimate } = {}) {
    const values = [userId, projectId, segmentId || CREATOR_PROJECT_LEVEL_SEGMENT_KEY];
    let extra = "";
    if (isEstimate !== undefined) { extra = " AND is_estimate=?"; values.push(isEstimate ? 1 : 0); }
    const [rows] = await this.db.execute(
      `SELECT currency, is_estimate, SUM(cost_amount) AS total_cost, COUNT(*) AS call_count
       FROM creator_api_calls WHERE user_id=? AND project_id=? AND segment_id=?${extra}
       GROUP BY currency, is_estimate`,
      values,
    );
    return rows;
  }

  // Episode-level rollup: filters by a caller-supplied list of segment ids
  // (the shots/units belonging to that episode) rather than a stored
  // episode_id column on creator_api_calls, keeping the ledger schema
  // segment-shaped and episode grouping a query-time concern.
  async rollupBySegments(userId, projectId, segmentIds, { isEstimate } = {}) {
    if (!segmentIds?.length) return [];
    const placeholders = segmentIds.map(() => "?").join(",");
    const values = [userId, projectId, ...segmentIds];
    let extra = "";
    if (isEstimate !== undefined) { extra = " AND is_estimate=?"; values.push(isEstimate ? 1 : 0); }
    const [rows] = await this.db.execute(
      `SELECT currency, is_estimate, SUM(cost_amount) AS total_cost, COUNT(*) AS call_count
       FROM creator_api_calls WHERE user_id=? AND project_id=? AND segment_id IN (${placeholders})${extra}
       GROUP BY currency, is_estimate`,
      values,
    );
    return rows;
  }
}

module.exports = { CreatorApiCallRepository, CREATOR_PROJECT_LEVEL_SEGMENT_KEY };
