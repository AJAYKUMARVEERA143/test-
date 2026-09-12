// way-ai-server/routes/creatorProjects.js
// Creator Studio: projects + episodes CRUD

const express = require("express");
const { CreatorProjectRepository } = require("../creator/CreatorProjectRepository.js");
const { CreatorEpisodeRepository } = require("../creator/CreatorEpisodeRepository.js");
const { computeProjectStatus, computeProjectProgress } = require("../creator/CreatorStatusCalculator.js");

const CONTENT_MODES = new Set(["narration", "drama", "ad"]);
const GENERATION_MODES = new Set(["storyboard", "reference_video"]);

function withStatus(project, episodes) {
  return {
    ...project,
    status: computeProjectStatus(project, episodes),
    progress: computeProjectProgress(project, episodes),
  };
}

// Factory: receives db pool from index.js
module.exports = (db) => {
  const router = express.Router();
  const projects = new CreatorProjectRepository(db);
  const episodes = new CreatorEpisodeRepository(db);

  router.get("/", async (req, res) => {
    try {
      const rows = await projects.list(req.user.id, { limit: req.query.limit });
      const withStatuses = await Promise.all(
        rows.map(async (project) => withStatus(project, await episodes.listByProject(req.user.id, project.id))),
      );
      res.json({ projects: withStatuses });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { name, contentMode, generationMode, style, aspectRatio, overview } = req.body || {};
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!CONTENT_MODES.has(contentMode)) return res.status(400).json({ error: "contentMode must be one of narration, drama, ad" });
      if (!GENERATION_MODES.has(generationMode)) return res.status(400).json({ error: "generationMode must be one of storyboard, reference_video" });
      const project = await projects.create(req.user.id, { name, contentMode, generationMode, style, aspectRatio, overview });
      res.status(201).json({ project: withStatus(project, []) });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "A project with this name already exists" });
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const project = await projects.getById(req.user.id, req.params.id);
      if (!project) return res.status(404).json({ error: "Project not found" });
      const projectEpisodes = await episodes.listByProject(req.user.id, project.id);
      res.json({ project: withStatus(project, projectEpisodes), episodes: projectEpisodes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST aliases alongside PATCH/DELETE: this host's firewall blocks those
  // methods before they reach the app, which the browser reports as a bare
  // "Failed to fetch" (same reason /me and the credential routes have them).
  const updateProject = async (req, res) => {
    try {
      const existing = await projects.getById(req.user.id, req.params.id);
      if (!existing) return res.status(404).json({ error: "Project not found" });
      const { name, style, aspectRatio, overview } = req.body || {};
      const project = await projects.update(req.user.id, req.params.id, { name, style, aspectRatio, overview });
      const projectEpisodes = await episodes.listByProject(req.user.id, project.id);
      res.json({ project: withStatus(project, projectEpisodes) });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "A project with this name already exists" });
      res.status(500).json({ error: err.message });
    }
  };
  router.patch("/:id", updateProject);
  router.post("/:id/update", updateProject);

  const removeProject = async (req, res) => {
    try {
      const ok = await projects.softDelete(req.user.id, req.params.id);
      if (!ok) return res.status(404).json({ error: "Project not found" });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
  router.delete("/:id", removeProject);
  router.post("/:id/delete", removeProject);

  router.get("/:id/episodes", async (req, res) => {
    try {
      const project = await projects.getById(req.user.id, req.params.id);
      if (!project) return res.status(404).json({ error: "Project not found" });
      res.json({ episodes: await episodes.listByProject(req.user.id, req.params.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/:id/episodes", async (req, res) => {
    try {
      const project = await projects.getById(req.user.id, req.params.id);
      if (!project) return res.status(404).json({ error: "Project not found" });
      const { episodeNumber, title, script } = req.body || {};
      if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
        return res.status(400).json({ error: "episodeNumber must be a positive integer" });
      }
      const episode = await episodes.create(req.user.id, req.params.id, { episodeNumber, title, script });
      res.status(201).json({ episode });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "This episode number already exists in the project" });
      res.status(500).json({ error: err.message });
    }
  });

  const updateEpisode = async (req, res) => {
    try {
      const existing = await episodes.getById(req.user.id, req.params.id, req.params.episodeId);
      if (!existing) return res.status(404).json({ error: "Episode not found" });
      const { title, script } = req.body || {};
      const episode = await episodes.update(req.user.id, req.params.id, req.params.episodeId, { title, script });
      res.json({ episode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
  router.patch("/:id/episodes/:episodeId", updateEpisode);
  router.post("/:id/episodes/:episodeId/update", updateEpisode);

  return router;
};
