"use strict";

const { v4: uuidv4 } = require("uuid");

class CreatorVersionRepository {
  constructor(db) {
    if (!db?.execute) throw new TypeError("CreatorVersionRepository requires a database pool");
    this.db = db;
  }

  // Regeneration never overwrites — each call inserts the next version number
  // for (resourceType, resourceId) rather than updating a prior row. Version
  // numbers are computed from MAX(version)+1 inside the same call, so two
  // concurrent recordVersion calls for the same resource is the one case the
  // uq_creator_version unique key is there to catch (an unlikely double-submit,
  // not a normal path — no other write in Creator Studio races on this table).
  async recordVersion(userId, { resourceType, resourceId, filePath, metadata = {} }) {
    const [rows] = await this.db.execute(
      `SELECT COALESCE(MAX(version), 0) AS maxVersion FROM creator_asset_versions WHERE resource_type=? AND resource_id=?`,
      [resourceType, resourceId],
    );
    const version = Number(rows[0]?.maxVersion || 0) + 1;
    const id = uuidv4();
    await this.db.execute(
      `INSERT INTO creator_asset_versions (id, user_id, resource_type, resource_id, version, file_path, metadata_json, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, userId, resourceType, resourceId, version, filePath, JSON.stringify(metadata || {}), userId],
    );
    return this.getById(id);
  }

  async getById(id) {
    const [rows] = await this.db.execute(`SELECT * FROM creator_asset_versions WHERE id=? LIMIT 1`, [id]);
    return rows[0] || null;
  }

  // userId-scoped — versions carry per-user reference data (file paths,
  // prompts in metadata_json), so listing must never cross users even when a
  // resourceId is guessed or leaked.
  async listByResource(userId, resourceType, resourceId) {
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_asset_versions WHERE user_id=? AND resource_type=? AND resource_id=? ORDER BY version DESC`,
      [userId, resourceType, resourceId],
    );
    return rows;
  }

  async getVersion(userId, resourceType, resourceId, version) {
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_asset_versions WHERE user_id=? AND resource_type=? AND resource_id=? AND version=? LIMIT 1`,
      [userId, resourceType, resourceId, version],
    );
    return rows[0] || null;
  }
}

module.exports = { CreatorVersionRepository };
