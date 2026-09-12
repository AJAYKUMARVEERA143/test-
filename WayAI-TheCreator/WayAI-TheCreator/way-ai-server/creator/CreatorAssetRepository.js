"use strict";

const { v4: uuidv4 } = require("uuid");

class CreatorAssetRepository {
  constructor(db) {
    if (!db?.execute) throw new TypeError("CreatorAssetRepository requires a database pool");
    this.db = db;
  }

  // projectId omitted (undefined/null) creates a global cross-project library asset.
  async create(userId, { projectId = null, assetType, name, definition = {}, referenceImagePath = null, source = "generated" }) {
    const id = uuidv4();
    await this.db.execute(
      `INSERT INTO creator_assets (id, user_id, project_id, asset_type, name, definition_json, reference_image_path, source)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, userId, projectId, assetType, String(name).slice(0, 255), JSON.stringify(definition || {}), referenceImagePath, source],
    );
    return this.getById(userId, id);
  }

  async getById(userId, id) {
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_assets WHERE id=? AND user_id=? AND deleted_at IS NULL LIMIT 1`,
      [id, userId],
    );
    return rows[0] || null;
  }

  // projectId: omit for the global library, pass a project id for that project's
  // own assets. There is deliberately no "all assets everywhere" query — callers
  // always pick one scope or the other, matching the two real UI surfaces (global
  // asset library page vs. a project's own asset view).
  async list(userId, { projectId, assetType, limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const values = [userId];
    let scopeClause;
    if (projectId) {
      scopeClause = "project_id=?";
      values.push(projectId);
    } else {
      scopeClause = "project_id IS NULL";
    }
    let extra = "";
    if (assetType) { extra = " AND asset_type=?"; values.push(assetType); }
    values.push(safeLimit);
    const [rows] = await this.db.execute(
      `SELECT * FROM creator_assets WHERE user_id=? AND ${scopeClause}${extra} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
      values,
    );
    return rows;
  }

  async update(userId, id, { name, definition, referenceImagePath, currentVersionId } = {}) {
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push("name=?"); values.push(String(name).slice(0, 255)); }
    if (definition !== undefined) { fields.push("definition_json=?"); values.push(JSON.stringify(definition || {})); }
    if (referenceImagePath !== undefined) { fields.push("reference_image_path=?"); values.push(referenceImagePath); }
    if (currentVersionId !== undefined) { fields.push("current_version_id=?"); values.push(currentVersionId); }
    if (!fields.length) return this.getById(userId, id);
    values.push(id, userId);
    await this.db.execute(
      `UPDATE creator_assets SET ${fields.join(", ")} WHERE id=? AND user_id=? AND deleted_at IS NULL`,
      values,
    );
    return this.getById(userId, id);
  }

  async softDelete(userId, id) {
    const [result] = await this.db.execute(
      `UPDATE creator_assets SET deleted_at=NOW(6) WHERE id=? AND user_id=? AND deleted_at IS NULL`,
      [id, userId],
    );
    return Number(result.affectedRows || 0) === 1;
  }
}

module.exports = { CreatorAssetRepository };
