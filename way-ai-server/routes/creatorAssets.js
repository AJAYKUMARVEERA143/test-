// way-ai-server/routes/creatorAssets.js
// Creator Studio: character/scene/prop/product asset library CRUD.
// Omitting projectId scopes to the global cross-project library; passing it
// scopes to that project's own assets. See CreatorAssetRepository for why
// there's no "everything everywhere" query.

const express = require("express");
const { CreatorAssetRepository } = require("../creator/CreatorAssetRepository.js");

const ASSET_TYPES = new Set(["character", "scene", "prop", "product"]);

module.exports = (db) => {
  const router = express.Router();
  const assets = new CreatorAssetRepository(db);

  router.get("/", async (req, res) => {
    try {
      const { projectId, assetType, limit } = req.query;
      if (assetType && !ASSET_TYPES.has(assetType)) return res.status(400).json({ error: "Invalid assetType" });
      const rows = await assets.list(req.user.id, { projectId: projectId || null, assetType, limit });
      res.json({ assets: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { projectId, assetType, name, definition, referenceImagePath, source } = req.body || {};
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!ASSET_TYPES.has(assetType)) return res.status(400).json({ error: "assetType must be one of character, scene, prop, product" });
      const asset = await assets.create(req.user.id, { projectId: projectId || null, assetType, name, definition, referenceImagePath, source });
      res.status(201).json({ asset });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "An asset with this name already exists in this scope" });
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const asset = await assets.getById(req.user.id, req.params.id);
      if (!asset) return res.status(404).json({ error: "Asset not found" });
      res.json({ asset });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST aliases: this host's firewall blocks PUT/PATCH/DELETE before they
  // reach the app, which the browser reports as a bare "Failed to fetch".
  const updateAsset = async (req, res) => {
    try {
      const existing = await assets.getById(req.user.id, req.params.id);
      if (!existing) return res.status(404).json({ error: "Asset not found" });
      const { name, definition, referenceImagePath, currentVersionId } = req.body || {};
      const asset = await assets.update(req.user.id, req.params.id, { name, definition, referenceImagePath, currentVersionId });
      res.json({ asset });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "An asset with this name already exists in this scope" });
      res.status(500).json({ error: err.message });
    }
  };
  router.patch("/:id", updateAsset);
  router.post("/:id/update", updateAsset);

  const removeAsset = async (req, res) => {
    try {
      const ok = await assets.softDelete(req.user.id, req.params.id);
      if (!ok) return res.status(404).json({ error: "Asset not found" });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
  router.delete("/:id", removeAsset);
  router.post("/:id/delete", removeAsset);

  return router;
};
