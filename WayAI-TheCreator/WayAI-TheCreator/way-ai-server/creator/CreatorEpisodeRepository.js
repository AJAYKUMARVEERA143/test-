"use strict";

const { v4: uuidv4 } = require("uuid");

class CreatorEpisodeRepository {
  constructor(db) {
    if (!db?.execute) throw new TypeError("CreatorEpisodeRepository requires a database pool");
    this.db = db;
  }

  async create(userId, projectId, { episodeNumber, title = null, script = null }) {
    const id = uuidv4();
    await this.db.execute(
      `INSERT INTO creator_episodes (id, project_id, user_id, episode_number, title, script_json)
       VALUES (?,?,?,?,?,?)`,
      [id, projectId, userId, episodeNumber, title, script ? JSON.stringify(script) : null],
    );
    return this.getById(userId, projectId, id);
  }

  async getById(userId, projectId, id) {
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_episodes WHERE id=? AND project_id=? AND user_id=? LIMIT 1`,
      [id, projectId, userId],
    );
    return rows[0] || null;
  }

  async listByProject(userId, projectId) {
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_episodes WHERE project_id=? AND user_id=? ORDER BY episode_number ASC`,
      [projectId, userId],
    );
    return rows;
  }

  async update(userId, projectId, id, { title, script } = {}) {
    const fields = [];
    const values = [];
    if (title !== undefined) { fields.push("title=?"); values.push(title); }
    if (script !== undefined) { fields.push("script_json=?"); values.push(script ? JSON.stringify(script) : null); }
    if (!fields.length) return this.getById(userId, projectId, id);
    values.push(id, projectId, userId);
    await this.db.execute(
      `UPDATE creator_episodes SET ${fields.join(", ")} WHERE id=? AND project_id=? AND user_id=?`,
      values,
    );
    return this.getById(userId, projectId, id);
  }
}

module.exports = { CreatorEpisodeRepository };
