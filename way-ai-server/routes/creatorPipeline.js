// way-ai-server/routes/creatorPipeline.js
// Creator Studio Phase F1: narrated short video pipeline. Deterministic
// text-processing only (segment split + storyboard scaffold) — per-scene
// image/voiceover generation stays the client's job via the existing
// tasks/costs/versions routes, matching Phase D's product-shot pattern.

const express = require("express");
const { CreatorEpisodeRepository } = require("../creator/CreatorEpisodeRepository.js");
const { splitNarration } = require("../creator/pipelines/NarrationSegmentSplitter.js");
const { buildStoryboard } = require("../creator/pipelines/StoryboardBuilder.js");

module.exports = (db) => {
  const router = express.Router();
  const episodes = new CreatorEpisodeRepository(db);

  // Splits sourceText into a storyboard and persists it onto the episode's
  // script_json (overwriting any prior storyboard for that episode — the
  // *storyboard scaffold* is regenerated from scratch each time this runs;
  // per-scene generated media (image/audio) lives separately and is
  // reattached by the client after this call, not lost by re-running it).
  router.post("/narration", async (req, res) => {
    try {
      const { projectId, episodeId, sourceText, style } = req.body || {};
      if (!projectId || !episodeId) return res.status(400).json({ error: "projectId and episodeId are required" });
      if (!String(sourceText || "").trim()) return res.status(400).json({ error: "sourceText is required" });

      const existing = await episodes.getById(req.user.id, projectId, episodeId);
      if (!existing) return res.status(404).json({ error: "Episode not found" });

      const segments = splitNarration(sourceText, {});
      const storyboard = buildStoryboard(segments, { style: style || "cinematic" });
      const script = { sourceText, segments, storyboard, generatedAt: new Date().toISOString() };

      const episode = await episodes.update(req.user.id, projectId, episodeId, { script });
      res.json({ episode, segments, storyboard });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
