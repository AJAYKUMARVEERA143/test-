// way-ai-server/routes/creatorVersions.js
// Creator Studio Phase E: version history. Regeneration never overwrites —
// every generation lands as a new row here; callers separately update the
// owning resource's current_version_id pointer.

const express = require("express");
const { CreatorVersionRepository } = require("../creator/CreatorVersionRepository.js");

const RESOURCE_TYPES = new Set(["character", "scene", "prop", "product", "shot", "episode_video"]);

module.exports = (db) => {
  const router = express.Router();
  const versions = new CreatorVersionRepository(db);

  router.post("/", async (req, res) => {
    try {
      const { resourceType, resourceId, filePath, metadata } = req.body || {};
      if (!RESOURCE_TYPES.has(resourceType)) return res.status(400).json({ error: `resourceType must be one of: ${[...RESOURCE_TYPES].join(", ")}` });
      if (!resourceId || !filePath) return res.status(400).json({ error: "resourceId and filePath are required" });
      const version = await versions.recordVersion(req.user.id, { resourceType, resourceId, filePath, metadata });
      res.status(201).json({ version });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/", async (req, res) => {
    try {
      const { resourceType, resourceId } = req.query;
      if (!RESOURCE_TYPES.has(resourceType) || !resourceId) return res.status(400).json({ error: "resourceType and resourceId are required" });
      const rows = await versions.listByResource(req.user.id, resourceType, resourceId);
      res.json({ versions: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
