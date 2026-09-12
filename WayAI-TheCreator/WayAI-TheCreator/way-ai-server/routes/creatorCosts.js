// way-ai-server/routes/creatorCosts.js
// Creator Studio Phase E: cost preview (before a task is ever submitted) and
// cost rollups (estimate vs. actual, currency-separated) over creator_api_calls.

const express = require("express");
const { CreatorApiCallRepository } = require("../creator/CreatorApiCallRepository.js");
const { estimateCost } = require("../creator/CreatorCostEstimator.js");

const MEDIA_TYPES = new Set(["text", "image", "video", "audio"]);

module.exports = (db) => {
  const router = express.Router();
  const apiCalls = new CreatorApiCallRepository(db);

  // Pure preview — no DB write, no task required. Lets a panel show "~$0.04"
  // before the user commits to generating anything.
  router.get("/estimate", (req, res) => {
    const { mediaType, durationSeconds, textLength } = req.query;
    if (!MEDIA_TYPES.has(mediaType)) return res.status(400).json({ error: `mediaType must be one of: ${[...MEDIA_TYPES].join(", ")}` });
    const payload = {};
    if (durationSeconds) payload.durationSeconds = Number(durationSeconds);
    if (textLength) payload.text = { length: Number(textLength) };
    res.json(estimateCost({ mediaType, payload }));
  });

  // projectId omitted rolls up the global (cross-project) scope, matching how
  // Creator Studio's asset library and product-shot tasks are scoped today.
  router.get("/rollup", async (req, res) => {
    try {
      const { projectId, isEstimate } = req.query;
      const opts = isEstimate === undefined ? {} : { isEstimate: isEstimate === "true" };
      const rows = await apiCalls.rollupByProject(req.user.id, projectId || null, opts);
      res.json({ rollup: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
