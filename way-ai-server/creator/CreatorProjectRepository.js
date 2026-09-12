"use strict";

const { v4: uuidv4 } = require("uuid");

class CreatorProjectRepository {
  constructor(db) {
    if (!db?.execute) throw new TypeError("CreatorProjectRepository requires a database pool");
    this.db = db;
  }

  async create(userId, { name, contentMode, generationMode, style = null, aspectRatio = "9:16", overview = {} }) {
    const id = uuidv4();
    await this.db.execute(
      `INSERT INTO creator_projects (id, user_id, name, content_mode, generation_mode, style, aspect_ratio, overview_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, userId, String(name).slice(0, 255), contentMode, generationMode, style, aspectRatio, JSON.stringify(overview || {})],
    );
    return this.getById(userId, id);
  }

  async getById(userId, id) {
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_projects WHERE id=? AND user_id=? AND deleted_at IS NULL LIMIT 1`,
      [id, userId],
    );
    return rows[0] || null;
  }

  async list(userId, { limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_projects WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
      [userId, safeLimit],
    );
    return rows;
  }

  // generation_mode is intentionally never accepted here — ArcReel's own design
  // treats it as immutable once a project exists (downstream generation work
  // assumes it never changes mid-project), enforced here rather than in the schema.
  async update(userId, id, { name, style, aspectRatio, overview } = {}) {
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push("name=?"); values.push(String(name).slice(0, 255)); }
    if (style !== undefined) { fields.push("style=?"); values.push(style); }
    if (aspectRatio !== undefined) { fields.push("aspect_ratio=?"); values.push(aspectRatio); }
    if (overview !== undefined) { fields.push("overview_json=?"); values.push(JSON.stringify(overview || {})); }
    if (!fields.length) return this.getById(userId, id);
    values.push(id, userId);
    await this.db.execute(
      `UPDATE creator_projects SET ${fields.join(", ")} WHERE id=? AND user_id=? AND deleted_at IS NULL`,
      values,
    );
    return this.getById(userId, id);
  }

  async softDelete(userId, id) {
    const [result] = await this.db.execute(
      `UPDATE creator_projects SET deleted_at=NOW(6) WHERE id=? AND user_id=? AND deleted_at IS NULL`,
      [id, userId],
    );
    return Number(result.affectedRows || 0) === 1;
  }
}

module.exports = { CreatorProjectRepository };
