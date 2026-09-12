// way-ai-server/routes/creatorExport.js
// Creator Studio Phase G: CapCut draft export. See CapCutDraftBuilder.js for
// the honest caveat on what "CapCut draft format" means here — best-effort
// against the community-documented structure, not an official spec.

const express = require("express");
const { CreatorEpisodeRepository } = require("../creator/CreatorEpisodeRepository.js");
const { buildDraft } = require("../creator/export/CapCutDraftBuilder.js");
const { streamCapCutZip } = require("../creator/export/CapCutZipAssembler.js");

function slugText(value = "episode") {
  return String(value || "episode").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "episode";
}

module.exports = (db) => {
  const router = express.Router();
  const episodes = new CreatorEpisodeRepository(db);

  router.get("/capcut/:projectId/:episodeId", async (req, res) => {
    try {
      const episode = await episodes.getById(req.user.id, req.params.projectId, req.params.episodeId);
      if (!episode) return res.status(404).json({ error: "Episode not found" });

      const script = typeof episode.script_json === "string" ? JSON.parse(episode.script_json) : episode.script_json;
      if (!script?.storyboard?.length) return res.status(400).json({ error: "This episode has no generated storyboard to export yet." });

      const { draftContent, draftMetaInfo, mediaManifest } = buildDraft(
        { title: episode.title || `Episode ${episode.episode_number}`, storyboard: script.storyboard },
        {},
      );

      const draftName = slugText(episode.title || `episode-${episode.episode_number}`);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${draftName}-capcut-draft.zip"`);

      await streamCapCutZip({ draftContent, draftMetaInfo, mediaManifest, draftName }, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.end();
      }
    }
  });

  return router;
};
